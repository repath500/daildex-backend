import { getDatabase, type Database } from "@daildex/db";
import { AppError } from "@daildex/shared";

export const runtimeControlKeys = ["email_sending", "alert_generation", "reply_generation", "editorial_generation", "budget_live"] as const;
export type RuntimeControlKey = (typeof runtimeControlKeys)[number];

const environmentGate: Record<RuntimeControlKey, string> = {
  email_sending: "EMAIL_SENDING_ENABLED",
  alert_generation: "HERMES_ALERTS_ENABLED",
  reply_generation: "HERMES_REPLIES_ENABLED",
  editorial_generation: "EDITORIAL_GENERATION_ENABLED",
  budget_live: "BUDGET_LIVE_ENABLED",
};

export async function isRuntimeControlEnabled(key: RuntimeControlKey, database: Database = getDatabase()): Promise<boolean> {
  if (process.env[environmentGate[key]] !== "true") return false;
  const rows = await database<{ enabled: boolean }[]>`
    SELECT enabled FROM runtime_controls WHERE key = ${key}
  `;
  return rows[0]?.enabled === true;
}

export async function listRuntimeControls(database: Database = getDatabase()) {
  const rows = await database<{
    key: RuntimeControlKey;
    enabled: boolean;
    reason: string | null;
    updated_by: string;
    updated_at: Date;
  }[]>`
    SELECT key, enabled, reason, updated_by, updated_at
    FROM runtime_controls ORDER BY key
  `;
  return rows.map((row) => ({
    ...row,
    environmentEnabled: process.env[environmentGate[row.key]] === "true",
    effectiveEnabled: row.enabled && process.env[environmentGate[row.key]] === "true",
  }));
}

export async function setRuntimeControl(
  key: string,
  enabled: boolean,
  actor: string,
  reason: string,
  database: Database = getDatabase(),
) {
  if (!runtimeControlKeys.includes(key as RuntimeControlKey)) {
    throw new AppError("NOT_FOUND", "Runtime control not found.", 404);
  }
  const rows = await database<{
    key: RuntimeControlKey;
    enabled: boolean;
    reason: string | null;
    updated_by: string;
    updated_at: Date;
  }[]>`
    UPDATE runtime_controls SET enabled = ${enabled}, reason = ${reason || null},
      updated_by = ${actor.slice(0, 200)}, updated_at = now()
    WHERE key = ${key}
    RETURNING key, enabled, reason, updated_by, updated_at
  `;
  return rows[0];
}

export async function getOperationalSnapshot(database: Database = getDatabase()) {
  const [queues, ingestion, subscribers, deliveries] = await Promise.all([
    database<{ queue: string; status: string; count: number; oldest_at: Date | null }[]>`
      SELECT queue, status, count(*)::INTEGER AS count, min(created_at) AS oldest_at
      FROM (
        SELECT 'email_outbox' AS queue, status, created_at FROM email_outbox
        UNION ALL
        SELECT 'ai_replies', status, created_at FROM ai_replies
        UNION ALL
        SELECT 'provider_webhooks', status, received_at AS created_at FROM provider_webhook_events
        UNION ALL
        SELECT 'alert_targets', target.status, event.fetched_at AS created_at
        FROM raw_event_targets target JOIN raw_events event ON event.id = target.raw_event_id
      ) work
      GROUP BY queue, status ORDER BY queue, status
    `,
    database<{ source_type: string; status: string; finished_at: Date | null; records_written: number }[]>`
      SELECT DISTINCT ON (source_type) source_type, status, finished_at, records_written
      FROM ingest_runs ORDER BY source_type, started_at DESC
    `,
    database<{ status: string; count: number }[]>`
      SELECT status, count(*)::INTEGER AS count FROM subscribers GROUP BY status ORDER BY status
    `,
    database<{ event_type: string; count: number }[]>`
      SELECT event_type, count(*)::INTEGER AS count
      FROM email_delivery_events
      WHERE received_at > now() - interval '24 hours'
      GROUP BY event_type ORDER BY event_type
    `,
  ]);
  return { generatedAt: new Date().toISOString(), queues, ingestion, subscribers, deliveries };
}

/**
 * Aggregate-only view of the alert pipeline for the public site. Exposes counts
 * and timestamps, never record contents, so it is safe to serve unauthenticated.
 */
export async function getPublicPipelineStats(database: Database = getDatabase()) {
  const [targets, alerts] = await Promise.all([
    database<{ status: string; count: number }[]>`
      SELECT status, count(*)::INTEGER AS count FROM raw_event_targets GROUP BY status
    `,
    database<{ last_24h: number; latest_at: Date | null }[]>`
      SELECT count(*) FILTER (WHERE created_at > now() - interval '24 hours')::INTEGER AS last_24h,
        max(created_at) AS latest_at
      FROM alert_items
    `,
  ]);
  const byStatus = (status: string) => targets.find((row) => row.status === status)?.count ?? 0;
  return {
    generatedAt: new Date().toISOString(),
    queued: byStatus("pending"),
    processing: byStatus("processing"),
    held: byStatus("needs_review"),
    processed: byStatus("processed"),
    alertsLast24h: alerts[0]?.last_24h ?? 0,
    latestAlertAt: alerts[0]?.latest_at?.toISOString() ?? null,
  };
}

export type PublicPipelineStats = Awaited<ReturnType<typeof getPublicPipelineStats>>;

export type AcquisitionRow = {
  ref: string;
  signups: number;
  confirmed: number;
};

/**
 * Follow sign-ups grouped by first-touch attribution, newest campaigns first.
 * Aggregate-only: never returns email addresses. `by` picks the grouping key.
 */
export async function getAcquisitionBreakdown(
  by: "ref" | "source" | "entry" | "referrer" = "ref",
  days = 30,
  database: Database = getDatabase(),
): Promise<AcquisitionRow[]> {
  return database<AcquisitionRow[]>`
    SELECT
      coalesce(acquisition ->> ${by}, '(none)') AS ref,
      count(*)::INTEGER AS signups,
      count(*) FILTER (WHERE status = 'active')::INTEGER AS confirmed
    FROM subscribers
    WHERE created_at > now() - (${days} * interval '1 day')
    GROUP BY 1
    ORDER BY signups DESC, ref
    LIMIT 25
  `;
}
