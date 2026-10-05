import { getDatabase, type Database, type TransactionDatabase } from "@daildex/db";
import {
  alertDraftSchema,
  AppError,
  type AlertAgentOutcome,
  type AlertRunMetadata,
  type AlertTargetFailure,
  type AlertDraft,
  type ClaimedAlertTarget,
} from "@daildex/shared";

/** How far back, by ingestion time, the alert worker drafts events. */
export function alertRecentDays(value = process.env.ALERT_RECENT_DAYS): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.floor(parsed), 365) : 3;
}

export async function claimAlertTarget(
  workerId: string,
  database: Database = getDatabase(),
): Promise<ClaimedAlertTarget | null> {
  await database`
    UPDATE agent_runs AS run
    SET status = 'failed', error = 'Alert worker lease expired before the run completed.',
        error_class = 'transient', finished_at = now()
    WHERE run.job_type = 'alert_draft' AND run.status = 'running'
      AND EXISTS (
        SELECT 1 FROM raw_event_targets target
        WHERE target.id = run.raw_event_target_id
          AND target.status = 'processing'
          AND target.locked_at < now() - interval '15 minutes'
      )
  `;
  const rows = await database<ClaimedAlertTarget[]>`
    WITH candidate AS (
      -- Draft only for representatives an active subscriber follows, and
      -- only for events recent enough to still be news, newest first. A vote
      -- is dated by its division, not by when a backfill fetched it; drafting
      -- anything older only produces drafts the auto-publisher expires.
      -- Everything else stays pending so a later follow or a wider window can pick it up.
      SELECT target.id
      FROM raw_event_targets target
      JOIN raw_events source_event ON source_event.id = target.raw_event_id
      WHERE (
        target.status = 'pending' OR
        (target.status = 'processing' AND target.locked_at < now() - interval '15 minutes') OR
        (target.status = 'failed' AND target.attempt_count < 5)
      )
        AND source_event.fetched_at >= now() - make_interval(days => ${alertRecentDays()})
        AND COALESCE((source_event.raw_payload #>> '{division,date}')::DATE, source_event.fetched_at::DATE)
          >= (now() - make_interval(days => ${alertRecentDays()}))::DATE
        AND EXISTS (
          SELECT 1
          FROM subscriber_follows follow
          JOIN subscribers subscriber ON subscriber.id = follow.subscriber_id
          WHERE follow.representative_id = target.representative_id
            AND subscriber.status = 'active'
        )
      ORDER BY source_event.fetched_at DESC, target.id
      FOR UPDATE OF target SKIP LOCKED
      LIMIT 1
    ), claimed AS (
      UPDATE raw_event_targets AS target
      SET status = 'processing', locked_by = ${workerId}, locked_at = now(),
          attempt_count = attempt_count + 1
      FROM candidate
      WHERE target.id = candidate.id
      RETURNING target.*
    )
    SELECT
      claimed.id AS "targetId",
      event.id AS "rawEventId",
      claimed.attempt_count AS "attemptCount",
      event.source_type AS "sourceType",
      event.source_url AS "sourceUrl",
      left(event.raw_text, 16000) AS "rawText",
      claimed.participation,
      json_build_object(
        'id', representative.id,
        'name', representative.name,
        'chamber', representative.chamber,
        'role', representative.role,
        'area', representative.area,
        'party', representative.party_name
      ) AS representative
    FROM claimed
    JOIN raw_events event ON event.id = claimed.raw_event_id
    JOIN representatives representative ON representative.id = claimed.representative_id
  `;
  return rows[0] ?? null;
}

export async function writeAlertDraft(
  workerId: string,
  target: ClaimedAlertTarget,
  draftInput: AlertDraft,
  model: AlertRunMetadata,
  database: Database = getDatabase(),
) {
  const draft = alertDraftSchema.parse(draftInput);
  const expectedEventType = eventTypeForSource(target.sourceType);
  if (draft.eventType !== expectedEventType) {
    throw new AppError("INVALID_REQUEST", `Draft event type must be ${expectedEventType}.`, 400);
  }

  return database.begin(async (transaction) => {
    const locks = await transaction<{ representative_id: string }[]>`
      SELECT representative_id
      FROM raw_event_targets
      WHERE id = ${target.targetId} AND status = 'processing' AND locked_by = ${workerId}
      FOR UPDATE
    `;
    const lock = locks[0];
    if (!lock) throw new AppError("CONFLICT", "The alert target lease is no longer owned by this worker.", 409);

    const items = await transaction<{ id: string }[]>`
      INSERT INTO alert_items (
        raw_event_target_id, representative_id, event_type, headline, summary,
        explanation, topic_tags, source_url, source_label, importance_score,
        confidence, model_metadata, status
      ) VALUES (
        ${target.targetId}, ${lock.representative_id}, ${draft.eventType}, ${draft.headline},
        ${draft.summary}, ${draft.explanation}, ${draft.topicTags}, ${target.sourceUrl},
        ${draft.sourceLabel}, ${draft.importanceScore}, ${draft.confidence},
        ${transaction.json(modelMetadataForStorage(model))}, 'needs_review'
      )
      ON CONFLICT (raw_event_target_id) DO UPDATE SET
        headline = EXCLUDED.headline,
        summary = EXCLUDED.summary,
        explanation = EXCLUDED.explanation,
        topic_tags = EXCLUDED.topic_tags,
        source_label = EXCLUDED.source_label,
        importance_score = EXCLUDED.importance_score,
        confidence = EXCLUDED.confidence,
        model_metadata = EXCLUDED.model_metadata,
        status = 'needs_review',
        updated_at = now()
      RETURNING id
    `;
    await transaction`
      UPDATE raw_event_targets
      SET status = 'processed', locked_by = NULL, locked_at = NULL, last_error = NULL
      WHERE id = ${target.targetId} AND status = 'processing' AND locked_by = ${workerId}
    `;
    if (model.runId) {
      const updatedRuns = await transaction<{ id: string }[]>`
        UPDATE agent_runs
        SET status = 'succeeded', provider = ${model.provider}, model = ${model.model},
            prompt_version = ${model.promptVersion}, response_payload = ${transaction.json(draft)},
            input_tokens = ${model.inputTokens ?? null}, output_tokens = ${model.outputTokens ?? null},
            request_id = ${model.requestId ?? null}, hermes_run_id = ${model.hermesRunId ?? null},
            latency_ms = ${model.latencyMs ?? null}, provider_verified = ${model.providerVerified ?? null},
            finished_at = now()
        WHERE id = ${model.runId} AND raw_event_target_id = ${target.targetId} AND status = 'running'
        RETURNING id
      `;
      if (!updatedRuns[0]) throw new AppError("CONFLICT", "The alert model run is no longer active.", 409);
    } else {
      await transaction`
        INSERT INTO agent_runs (
          raw_event_target_id, job_type, status, provider, model, prompt_version,
          response_payload, input_tokens, output_tokens, request_id, hermes_run_id,
          latency_ms, provider_verified, finished_at
        ) VALUES (
          ${target.targetId}, 'alert_draft', 'succeeded', ${model.provider}, ${model.model},
          ${model.promptVersion}, ${transaction.json(draft)}, ${model.inputTokens ?? null},
          ${model.outputTokens ?? null}, ${model.requestId ?? null}, ${model.hermesRunId ?? null},
          ${model.latencyMs ?? null}, ${model.providerVerified ?? null}, now()
        )
      `;
    }
    return { alertItemId: items[0]?.id };
  });
}

export async function startAlertRun(
  workerId: string,
  targetId: string,
  model: AlertRunMetadata,
  database: Database = getDatabase(),
): Promise<string> {
  return database.begin(async (transaction) => {
    const locks = await transaction<{ id: string }[]>`
      SELECT id
      FROM raw_event_targets
      WHERE id = ${targetId} AND status = 'processing' AND locked_by = ${workerId}
      FOR UPDATE
    `;
    if (!locks[0]) throw new AppError("CONFLICT", "The alert target lease is no longer owned by this worker.", 409);
    const runs = await transaction<{ id: string }[]>`
      INSERT INTO agent_runs (
        raw_event_target_id, job_type, status, provider, model, prompt_version,
        provider_verified
      ) VALUES (
        ${targetId}, 'alert_draft', 'running', ${model.provider}, ${model.model},
        ${model.promptVersion}, ${model.providerVerified ?? null}
      )
      RETURNING id
    `;
    if (!runs[0]) throw new AppError("INTERNAL_ERROR", "Could not create the alert model run.", 500);
    return runs[0].id;
  });
}

export async function getAlertDraftForTarget(
  targetId: string,
  database: Database = getDatabase(),
) {
  const rows = await database<{
    alertItemId: string;
    status: "draft" | "approved" | "needs_review" | "sent" | "rejected";
    headline: string;
  }[]>`
    SELECT id AS "alertItemId", status, headline
    FROM alert_items
    WHERE raw_event_target_id = ${targetId}
  `;
  return rows[0] ?? null;
}

export async function getAlertResultForTarget(
  targetId: string,
  runId: string,
  database: Database = getDatabase(),
) {
  const rows = await database<{
    targetStatus: "pending" | "processing" | "processed" | "needs_review" | "rejected" | "failed";
    alertItemId: string | null;
    runStatus: "running" | "succeeded" | "failed" | "rejected" | null;
    outcome: AlertAgentOutcome | null;
  }[]>`
    SELECT target.status AS "targetStatus", alert.id AS "alertItemId", run.status AS "runStatus",
      CASE WHEN jsonb_typeof(run.response_payload) = 'object'
        THEN run.response_payload ->> 'outcome' ELSE NULL END AS outcome
    FROM raw_event_targets target
    LEFT JOIN alert_items alert ON alert.raw_event_target_id = target.id
    LEFT JOIN agent_runs run ON run.id = ${runId} AND run.raw_event_target_id = target.id
    WHERE target.id = ${targetId}
  `;
  return rows[0] ?? null;
}

/** Complete telemetry that is only known after a tool-driven Hermes run returns. */
export async function finalizeAlertRunMetadata(
  runId: string,
  targetId: string,
  model: AlertRunMetadata,
  database: Database = getDatabase(),
): Promise<void> {
  await database.begin(async (transaction) => {
    const runs = await transaction<{ id: string }[]>`
      UPDATE agent_runs
      SET provider = ${model.provider}, model = ${model.model}, prompt_version = ${model.promptVersion},
          request_id = ${model.requestId ?? null}, hermes_run_id = ${model.hermesRunId ?? null},
          input_tokens = ${model.inputTokens ?? null}, output_tokens = ${model.outputTokens ?? null},
          latency_ms = ${model.latencyMs ?? null}, provider_verified = ${model.providerVerified ?? null}
      WHERE id = ${runId} AND raw_event_target_id = ${targetId} AND status = 'succeeded'
      RETURNING id
    `;
    if (!runs[0]) throw new AppError("CONFLICT", "The alert model run is no longer available.", 409);
    await transaction`
      UPDATE alert_items
      SET model_metadata = ${transaction.json(modelMetadataForStorage(model))}, updated_at = now()
      WHERE raw_event_target_id = ${targetId}
    `;
  });
}

export async function listAlertTargetFailures(database: Database = getDatabase()) {
  return database<{
    id: string;
    representative_name: string;
    source_url: string;
    source_type: string;
    attempt_count: number;
    last_error: string | null;
    updated_at: Date | null;
  }[]>`
    SELECT target.id, representative.name AS representative_name,
      event.source_url, event.source_type, target.attempt_count,
      target.last_error, event.fetched_at AS updated_at
    FROM raw_event_targets target
    JOIN raw_events event ON event.id = target.raw_event_id
    JOIN representatives representative ON representative.id = target.representative_id
    LEFT JOIN alert_items alert ON alert.raw_event_target_id = target.id
    WHERE target.status = 'needs_review' AND alert.id IS NULL
    ORDER BY event.fetched_at, target.id
    LIMIT 100
  `;
}

/** Promote approved alerts after every related email has been delivered. */
export async function reconcileSentAlertItems(database: Database = getDatabase()): Promise<void> {
  await database`
    UPDATE alert_items AS alert
    SET status = 'sent', updated_at = now()
    WHERE alert.status = 'approved'
      AND EXISTS (
        SELECT 1 FROM email_outbox outbox
        WHERE outbox.alert_item_id = alert.id AND outbox.status = 'sent'
      )
      AND NOT EXISTS (
        SELECT 1 FROM email_outbox outbox
        WHERE outbox.alert_item_id = alert.id
          AND outbox.status NOT IN ('sent', 'cancelled')
      )
  `;
}

function eventTypeForSource(sourceType: string): AlertDraft["eventType"] {
  if (sourceType === "oireachtas_vote") return "vote";
  if (sourceType === "oireachtas_question") return "pq";
  if (sourceType === "oireachtas_debate") return "debate";
  if (sourceType.includes("news")) return "news";
  throw new AppError("INVALID_REQUEST", "Unsupported alert source type.", 400);
}

export async function releaseAlertTarget(
  workerId: string,
  targetId: string,
  failureInput: string | AlertTargetFailure,
  model?: AlertRunMetadata,
  database: Database = getDatabase(),
) {
  const failure: AlertTargetFailure = typeof failureInput === "string"
    ? { message: failureInput, classification: "unknown" }
    : failureInput;
  const error = failure.message.slice(0, 2000);
  const paused = failure.classification === "paused";
  const terminal = !["transient", "unknown", "paused"].includes(failure.classification);

  return database.begin(async (transaction) => {
    const released = await transaction<{ status: string }[]>`
      UPDATE raw_event_targets
      SET status = CASE
            WHEN ${paused} THEN 'pending'
            WHEN ${terminal} OR attempt_count >= 5 THEN 'needs_review'
            ELSE 'failed'
          END,
          attempt_count = CASE WHEN ${paused} THEN GREATEST(attempt_count - 1, 0) ELSE attempt_count END,
          last_error = ${error}, locked_by = NULL, locked_at = NULL
      WHERE id = ${targetId} AND locked_by = ${workerId}
      RETURNING status
    `;
    if (!released[0]) return { released: false, status: "lease_lost" as const };

    if (model?.runId) {
      await transaction`
        UPDATE agent_runs
        SET status = 'failed', provider = ${model.provider}, model = ${model.model},
            prompt_version = ${model.promptVersion}, error = ${error},
            error_class = ${failure.classification}, request_id = ${model.requestId ?? null},
            hermes_run_id = ${model.hermesRunId ?? null}, latency_ms = ${model.latencyMs ?? null},
            provider_verified = ${model.providerVerified ?? null}, finished_at = now()
        WHERE id = ${model.runId} AND raw_event_target_id = ${targetId} AND status = 'running'
      `;
    } else {
      await insertFailedRun(transaction, targetId, failure, model, error);
    }
    return { released: true, status: released[0].status };
  });
}

function modelMetadataForStorage(model: AlertRunMetadata) {
  return {
    provider: model.provider,
    model: model.model,
    promptVersion: model.promptVersion,
    requestId: model.requestId ?? null,
    hermesRunId: model.hermesRunId ?? null,
    inputTokens: model.inputTokens ?? null,
    outputTokens: model.outputTokens ?? null,
    latencyMs: model.latencyMs ?? null,
    providerVerified: model.providerVerified ?? null,
  };
}

async function insertFailedRun(
  transaction: TransactionDatabase,
  targetId: string,
  failure: AlertTargetFailure,
  model: AlertRunMetadata | undefined,
  error: string,
): Promise<void> {
  await transaction`
    INSERT INTO agent_runs (
      raw_event_target_id, job_type, status, provider, model, prompt_version,
      error, error_class, request_id, hermes_run_id, latency_ms,
      provider_verified, finished_at
    ) VALUES (
      ${targetId}, 'alert_draft', 'failed', ${model?.provider ?? null},
      ${model?.model ?? null}, ${model?.promptVersion ?? 'unknown'},
      ${error}, ${failure.classification}, ${model?.requestId ?? null},
      ${model?.hermesRunId ?? null}, ${model?.latencyMs ?? null},
      ${model?.providerVerified ?? null}, now()
    )
  `;
}
