import { getDatabase, type Database } from "@daildex/db";
import {
  alertAgentDecisionSchema,
  alertDraftSchema,
  AppError,
  type AlertAgentDecision,
  type AlertDraft,
  type AlertRunMetadata,
  type ClaimedAlertTarget,
} from "@daildex/shared";
import { writeAlertDraft } from "../alerts/service";
import type { AgentScopeClaims } from "./scope";

export async function getClaimedAlertTarget(
  scope: Pick<AgentScopeClaims, "targetId" | "workerId">,
  database: Database = getDatabase(),
): Promise<ClaimedAlertTarget | null> {
  const rows = await database<ClaimedAlertTarget[]>`
    SELECT
      target.id AS "targetId",
      event.id AS "rawEventId",
      target.attempt_count AS "attemptCount",
      event.source_type AS "sourceType",
      event.source_url AS "sourceUrl",
      left(event.raw_text, 16000) AS "rawText",
      target.participation,
      json_build_object(
        'id', representative.id,
        'name', representative.name,
        'chamber', representative.chamber,
        'role', representative.role,
        'area', representative.area,
        'party', representative.party_name
      ) AS representative
    FROM raw_event_targets target
    JOIN raw_events event ON event.id = target.raw_event_id
    JOIN representatives representative ON representative.id = target.representative_id
    WHERE target.id = ${scope.targetId}
      AND target.status = 'processing'
      AND target.locked_by = ${scope.workerId}
  `;
  return rows[0] ?? null;
}

export async function getRepresentativeHistory(
  representativeId: string,
  limit = 20,
  database: Database = getDatabase(),
) {
  const boundedLimit = boundedListLimit(limit, 20, 50);
  return database<{
    id: string;
    factType: string;
    payload: unknown;
    sourceUrl: string;
    effectiveAt: Date | null;
  }[]>`
    SELECT id, fact_type AS "factType", fact_payload AS payload,
      source_url AS "sourceUrl", effective_at AS "effectiveAt"
    FROM td_facts
    WHERE representative_id = ${representativeId}
    ORDER BY effective_at DESC NULLS LAST, created_at DESC
    LIMIT ${boundedLimit}
  `;
}

export async function findSimilarPreviousAlerts(
  representativeId: string,
  query: string,
  limit = 10,
  database: Database = getDatabase(),
) {
  const boundedLimit = boundedListLimit(limit, 10, 25);
  const needle = query.trim().toLocaleLowerCase("en-IE").slice(0, 120);
  return database<{
    id: string;
    eventType: string;
    headline: string;
    summary: string;
    sourceUrl: string;
    status: string;
    createdAt: Date;
  }[]>`
    SELECT id, event_type AS "eventType", headline, summary,
      source_url AS "sourceUrl", status, created_at AS "createdAt"
    FROM alert_items
    WHERE representative_id = ${representativeId}
      AND status <> 'rejected'
      AND (
        ${needle} = '' OR
        lower(headline || ' ' || summary || ' ' || explanation) LIKE ${`%${needle}%`}
      )
    ORDER BY created_at DESC
    LIMIT ${boundedLimit}
  `;
}

export async function submitScopedAlertDraft(
  scope: AgentScopeClaims,
  draftInput: AlertDraft,
  database: Database = getDatabase(),
) {
  const draft = alertDraftSchema.parse(draftInput);
  const target = await getClaimedAlertTarget(scope, database);
  if (!target) throw new AppError("CONFLICT", "The alert target lease is no longer owned by this worker.", 409);

  const metadata: AlertRunMetadata = {
    runId: scope.runId,
    provider: scope.provider,
    model: scope.model,
    promptVersion: scope.promptVersion,
    providerVerified: scope.providerVerified,
  };
  return writeAlertDraft(scope.workerId, target, draft, metadata, database);
}

export async function submitScopedAlertOutcome(
  scope: AgentScopeClaims,
  input: AlertAgentDecision,
  database: Database = getDatabase(),
) {
  const decision = alertAgentDecisionSchema.parse(input);
  validateNonDraftOutcome(decision);
  const target = await getClaimedAlertTarget(scope, database);
  if (!target) throw new AppError("CONFLICT", "The alert target lease is no longer owned by this worker.", 409);

  return database.begin(async (transaction) => {
    const locks = await transaction<{ representative_id: string }[]>`
      SELECT representative_id
      FROM raw_event_targets
      WHERE id = ${scope.targetId} AND status = 'processing' AND locked_by = ${scope.workerId}
      FOR UPDATE
    `;
    const lock = locks[0];
    if (!lock) throw new AppError("CONFLICT", "The alert target lease is no longer owned by this worker.", 409);

    if (decision.outcome === "merge") {
      const matches = await transaction<{ id: string }[]>`
        SELECT id FROM alert_items
        WHERE id = ${decision.mergeAlertId!}
          AND representative_id = ${lock.representative_id}
          AND status <> 'rejected'
      `;
      if (!matches[0]) throw new AppError("INVALID_REQUEST", "The merge target is not a valid alert for this representative.", 400);
    }

    const targetStatus = decision.outcome === "needs_more_context" ? "needs_review" : "processed";
    const updatedTargets = await transaction<{ status: string }[]>`
      UPDATE raw_event_targets
      SET status = ${targetStatus}, last_error = ${decision.reason ?? null},
          locked_by = NULL, locked_at = NULL
      WHERE id = ${scope.targetId} AND status = 'processing' AND locked_by = ${scope.workerId}
      RETURNING status
    `;
    if (!updatedTargets[0]) throw new AppError("CONFLICT", "The alert target lease is no longer owned by this worker.", 409);

    const runs = await transaction<{ id: string }[]>`
      UPDATE agent_runs
      SET status = 'succeeded', response_payload = ${transaction.json(decision)}, finished_at = now()
      WHERE id = ${scope.runId} AND raw_event_target_id = ${scope.targetId} AND status = 'running'
      RETURNING id
    `;
    if (!runs[0]) throw new AppError("CONFLICT", "The alert model run is no longer active.", 409);
    return { outcome: decision.outcome, mergeAlertId: decision.mergeAlertId ?? null };
  });
}

function validateNonDraftOutcome(decision: AlertAgentDecision): void {
  if (decision.outcome === "draft") {
    throw new AppError("INVALID_REQUEST", "Use submit_alert_draft for a draft outcome.", 400);
  }
  if (decision.draft) {
    throw new AppError("INVALID_REQUEST", "Only a draft outcome may include a draft.", 400);
  }
  if ((decision.outcome === "skip" || decision.outcome === "needs_more_context") && !decision.reason) {
    throw new AppError("INVALID_REQUEST", `A ${decision.outcome} outcome requires a reason.`, 400);
  }
  if (decision.outcome === "merge" && !decision.mergeAlertId) {
    throw new AppError("INVALID_REQUEST", "A merge outcome requires an existing alert id.", 400);
  }
  if (decision.outcome !== "merge" && decision.mergeAlertId) {
    throw new AppError("INVALID_REQUEST", "Only a merge outcome may include an existing alert id.", 400);
  }
}

function boundedListLimit(value: number, fallback: number, maximum: number): number {
  return Number.isInteger(value) && value >= 1 ? Math.min(value, maximum) : fallback;
}
