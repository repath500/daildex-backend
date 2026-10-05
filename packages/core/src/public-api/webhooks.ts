import { createHmac } from "node:crypto";
import { lookup as dnsLookup } from "node:dns";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { getDatabase, type Database } from "@daildex/db";
import { AppError } from "@daildex/shared";
import { z } from "zod";
import { getTokenPepper } from "../config";
import { getDivision } from "./divisions";
import { getQuestion } from "./resources";

export const WEBHOOK_EVENTS = ["division.created", "question.created"] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export const MAX_WEBHOOKS_PER_KEY = 5;
/** Delays before each retry; after the last one the delivery is marked dead. */
export const RETRY_DELAYS_SECONDS = [60, 300, 1800, 7200, 21_600] as const;
const DISABLE_AFTER_FAILURES = 20;
const DELIVERY_TIMEOUT_MS = 8000;
/** Webhooks announce news. A backfill that stores old records must not announce them. */
const RECENT_DAYS = 7;

export const createWebhookSchema = z.strictObject({
  url: z.string().trim().min(12).max(2000),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).max(WEBHOOK_EVENTS.length),
  representative: z.string().trim().min(1).max(160).optional(),
});

export type WebhookSummary = {
  id: string;
  url: string;
  events: WebhookEvent[];
  representative: string | null;
  status: "active" | "disabled";
  createdAt: string;
};

/** Signing secret: derived from the webhook id and the server pepper, so it is never stored. */
export function webhookSecret(id: string): string {
  return `whsec_${createHmac("sha256", getTokenPepper()).update(`webhook:${id}`).digest("hex").slice(0, 40)}`;
}

/** HMAC over `${timestamp}.${body}` so a captured delivery can't be replayed later with a fresh timestamp. */
export function signWebhookBody(secret: string, body: string, timestamp: number | string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`, "utf8").digest("hex")}`;
}

// ---------------------------------------------------------------------------------------------
// SSRF guard: a webhook URL must be https and must only ever reach a public address.
// ---------------------------------------------------------------------------------------------

/** Expand an IPv6 literal (including an embedded dotted IPv4 tail) into its eight 16-bit groups. */
function ipv6Groups(address: string): number[] | null {
  let value = address.toLowerCase().split("%")[0]!;
  const tail = value.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const octets = tail[1]!.split(".").map(Number);
    if (octets.some((octet) => octet > 255)) return null;
    value = `${value.slice(0, -tail[1]!.length)}${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...rest].map((group) => Number.parseInt(group, 16));
  return groups.length === 8 && groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff) ? groups : null;
}

const ipv4FromGroups = (high: number, low: number) => `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;

export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const [a, b, c] = address.split(".").map(Number) as [number, number, number];
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 192 && b === 0 && c === 0)
      || (a === 198 && (b === 18 || b === 19));
  }
  if (version === 6) {
    // Work on the numeric groups: the URL parser rewrites ::ffff:127.0.0.1 to ::ffff:7f00:1, so text matching misses it.
    const groups = ipv6Groups(address);
    if (!groups) return true;
    const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [number, number, number, number, number, number, number, number];
    if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0) {
      // ::, ::1, IPv4-mapped (::ffff:a.b.c.d) and the deprecated IPv4-compatible form (::a.b.c.d): judge the embedded IPv4.
      if (g5 === 0 && g6 === 0 && g7 <= 1) return true;
      if (g5 === 0xffff || g5 === 0) return isPrivateAddress(ipv4FromGroups(g6, g7));
    }
    if (g0 === 0x2002) return isPrivateAddress(ipv4FromGroups(g1, g2)); // 6to4 embeds the IPv4 in the next 32 bits
    return (g0 & 0xffc0) === 0xfe80 // link-local
      || (g0 & 0xffc0) === 0xfec0 // deprecated site-local
      || (g0 & 0xfe00) === 0xfc00 // unique local
      || (g0 & 0xff00) === 0xff00 // multicast
      || (g0 === 0x2001 && g1 === 0x0db8) // documentation
      || (g0 === 0x0064 && g1 === 0xff9b) // NAT64
      || (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0); // discard-only
  }
  return true;
}

export function assertPublicWebhookUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError("INVALID_REQUEST", "url must be an absolute https URL.", 400);
  }
  if (url.protocol !== "https:") throw new AppError("INVALID_REQUEST", "url must use https.", 400);
  if (url.username || url.password) throw new AppError("INVALID_REQUEST", "url must not contain credentials.", 400);
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new AppError("INVALID_REQUEST", "url must point at a public host.", 400);
  }
  if (isIP(host) !== 0 && isPrivateAddress(host)) {
    throw new AppError("INVALID_REQUEST", "url must point at a public address.", 400);
  }
  return url;
}

// ---------------------------------------------------------------------------------------------
// Management
// ---------------------------------------------------------------------------------------------

type WebhookRow = {
  id: string; url: string; events: WebhookEvent[]; representative_key: string | null;
  status: "active" | "disabled"; created_at: Date;
};

function toSummary(row: WebhookRow): WebhookSummary {
  return {
    id: row.id, url: row.url, events: row.events, representative: row.representative_key,
    status: row.status, createdAt: row.created_at.toISOString(),
  };
}

export async function createWebhook(
  apiKeyId: string,
  input: z.infer<typeof createWebhookSchema>,
  database: Database = getDatabase(),
): Promise<WebhookSummary & { secret: string }> {
  const url = assertPublicWebhookUrl(input.url);
  const events = [...new Set(input.events)];
  if (input.representative) {
    const found = await database`SELECT 1 FROM representatives WHERE representative_key = ${input.representative}`;
    if (found.length === 0) throw new AppError("INVALID_REQUEST", "Unknown representative id.", 400);
  }
  const row = await database.begin(async (transaction) => {
    await transaction`SELECT pg_advisory_xact_lock(hashtext(${`api-webhooks:${apiKeyId}`}))`;
    const [{ count }] = await transaction<{ count: number }[]>`
      SELECT count(*)::INT AS count FROM api_webhooks WHERE api_key_id = ${apiKeyId}
    `;
    if (count >= MAX_WEBHOOKS_PER_KEY) {
      throw new AppError("INVALID_REQUEST", `A key can have up to ${MAX_WEBHOOKS_PER_KEY} webhooks. Delete one first.`, 400);
    }
    const [created] = await transaction<WebhookRow[]>`
      INSERT INTO api_webhooks (api_key_id, url, events, representative_key)
      VALUES (${apiKeyId}, ${url.toString()}, ${events}::TEXT[], ${input.representative ?? null})
      RETURNING id, url, events, representative_key, status, created_at
    `;
    return created!;
  });
  return { ...toSummary(row), secret: webhookSecret(row.id) };
}

export async function listWebhooks(apiKeyId: string, database: Database = getDatabase()): Promise<WebhookSummary[]> {
  const rows = await database<WebhookRow[]>`
    SELECT id, url, events, representative_key, status, created_at
    FROM api_webhooks WHERE api_key_id = ${apiKeyId} ORDER BY created_at DESC
  `;
  return rows.map(toSummary);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function deleteWebhook(apiKeyId: string, id: string, database: Database = getDatabase()): Promise<boolean> {
  if (!UUID.test(id)) return false;
  const rows = await database`DELETE FROM api_webhooks WHERE id = ${id} AND api_key_id = ${apiKeyId} RETURNING id`;
  return rows.length > 0;
}

export async function listWebhookDeliveries(
  apiKeyId: string,
  id: string,
  limit = 20,
  database: Database = getDatabase(),
) {
  if (!UUID.test(id)) throw new AppError("NOT_FOUND", "Webhook not found.", 404);
  const owned = await database`SELECT 1 FROM api_webhooks WHERE id = ${id} AND api_key_id = ${apiKeyId}`;
  if (owned.length === 0) throw new AppError("NOT_FOUND", "Webhook not found.", 404);
  const rows = await database<{
    id: string; event_type: string; status: string; attempts: number; last_error: string | null;
    created_at: Date; delivered_at: Date | null; next_attempt_at: Date;
  }[]>`
    SELECT id, event_type, status, attempts, last_error, created_at, delivered_at, next_attempt_at
    FROM api_webhook_deliveries WHERE webhook_id = ${id}
    ORDER BY created_at DESC LIMIT ${Math.min(Math.max(limit, 1), 50)}
  `;
  return rows.map((row) => ({
    id: row.id,
    event: row.event_type,
    status: row.status,
    attempts: row.attempts,
    lastError: row.last_error,
    createdAt: row.created_at.toISOString(),
    deliveredAt: row.delivered_at?.toISOString() ?? null,
    nextAttemptAt: row.status === "pending" ? row.next_attempt_at.toISOString() : null,
  }));
}

// ---------------------------------------------------------------------------------------------
// Scanning for new events and queueing deliveries
// ---------------------------------------------------------------------------------------------

type NewEvent = { ref: string; firstSeen: Date };

/**
 * created_at is the time a transaction started, not when it committed, so a row from a slow ingest transaction can
 * appear behind the checkpoint. Only scan records older than this, which comfortably outlasts any ingest transaction.
 */
const SCAN_SETTLE_MS = 10 * 60_000;

async function newEvents(database: Database, type: WebhookEvent, since: Date, until: Date): Promise<NewEvent[]> {
  // "First seen" is when we stored the record: re-ingesting an old division must not re-announce it.
  if (type === "division.created") {
    const rows = await database<{ ref: string; first_seen: Date }[]>`
      SELECT source_event_id::TEXT AS ref, min(created_at) AS first_seen
      FROM td_facts
      WHERE fact_type = 'vote' AND source_event_id IS NOT NULL
        AND created_at >= ${since} AND created_at <= ${until}
        AND (fact_payload ->> 'date')::DATE >= current_date - ${RECENT_DAYS}::INT
      GROUP BY source_event_id
      ORDER BY min(created_at), source_event_id
      LIMIT 100
    `;
    return rows.map((row) => ({ ref: row.ref, firstSeen: row.first_seen }));
  }
  const rows = await database<{ ref: string; first_seen: Date }[]>`
    SELECT contribution.id::TEXT AS ref, contribution.created_at AS first_seen
    FROM official_contributions contribution
    JOIN official_document_versions version ON version.id = contribution.official_document_version_id
    JOIN official_documents document ON document.id = version.official_document_id
    WHERE contribution.contribution_type = 'question'
      AND contribution.created_at >= ${since} AND contribution.created_at <= ${until}
      AND document.document_date >= current_date - ${RECENT_DAYS}::INT
    ORDER BY contribution.created_at, contribution.id
    LIMIT 100
  `;
  return rows.map((row) => ({ ref: row.ref, firstSeen: row.first_seen }));
}

async function involvedRepresentatives(database: Database, type: WebhookEvent, ref: string): Promise<string[]> {
  const rows = type === "division.created"
    ? await database<{ key: string }[]>`
        SELECT representative.representative_key AS key
        FROM raw_event_targets target JOIN representatives representative ON representative.id = target.representative_id
        WHERE target.raw_event_id = ${ref}::UUID
      `
    : await database<{ key: string }[]>`
        SELECT representative.representative_key AS key
        FROM official_contributions contribution JOIN representatives representative ON representative.id = contribution.representative_id
        WHERE contribution.id = ${ref}::UUID
      `;
  return rows.map((row) => row.key);
}

/** Queue deliveries for records stored since the last scan. Returns how many were queued. */
export async function queueWebhookEvents(database: Database = getDatabase()): Promise<number> {
  let queued = 0;
  for (const type of WEBHOOK_EVENTS) {
    const until = new Date(Date.now() - SCAN_SETTLE_MS); // let a record's writes settle first
    await database`
      INSERT INTO api_webhook_checkpoints (event_type, scanned_through)
      VALUES (${type}, now() - interval '1 hour') ON CONFLICT (event_type) DO NOTHING
    `;
    for (let batch = 0; batch < 20; batch += 1) {
      const [checkpoint] = await database<{ scanned_through: Date }[]>`
        SELECT scanned_through FROM api_webhook_checkpoints WHERE event_type = ${type}
      `;
      const events = await newEvents(database, type, checkpoint!.scanned_through, until);
      for (const event of events) {
        const members = await involvedRepresentatives(database, type, event.ref);
        const targets = await database<{ id: string }[]>`
          SELECT webhook.id
          FROM api_webhooks webhook
          JOIN api_keys key ON key.id = webhook.api_key_id AND key.revoked_at IS NULL
          WHERE webhook.status = 'active'
            AND ${type} = ANY(webhook.events)
            AND webhook.created_at <= ${event.firstSeen}
            AND (webhook.representative_key IS NULL OR webhook.representative_key = ANY(${members}::TEXT[]))
        `;
        if (targets.length === 0) continue;
        const data = type === "division.created"
          ? (await getDivision(event.ref, {}, database)).data
          : (await getQuestion(event.ref, database)).data;
        for (const target of targets) {
          const inserted = await database`
            INSERT INTO api_webhook_deliveries (webhook_id, event_type, event_ref, payload)
            VALUES (${target.id}, ${type}, ${event.ref}, ${database.json({ type, data })})
            ON CONFLICT (webhook_id, event_type, event_ref) DO NOTHING
            RETURNING id
          `;
          queued += inserted.length;
        }
      }
      // The scan is inclusive (>=) so a batch boundary cannot skip records sharing a timestamp;
      // deliveries are unique per webhook and record, so re-reading the last one is harmless.
      const next = events.at(-1)?.firstSeen ?? until;
      await database`
        UPDATE api_webhook_checkpoints SET scanned_through = ${next} WHERE event_type = ${type}
      `;
      if (events.length < 100 || next.getTime() <= checkpoint!.scanned_through.getTime()) break;
    }
  }
  await database`DELETE FROM api_webhook_deliveries WHERE created_at < now() - interval '30 days'`;
  return queued;
}

// ---------------------------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------------------------

export type WebhookPost = (url: string, body: string, headers: Record<string, string>) => Promise<{ status: number }>;

/** POST over https, resolving the host ourselves so the address we connect to is the address we vetted. */
export const postToWebhook: WebhookPost = (rawUrl, body, headers) => new Promise((resolve, reject) => {
  let url: URL;
  try {
    url = assertPublicWebhookUrl(rawUrl);
  } catch (error) {
    reject(error);
    return;
  }
  const request = httpsRequest(url, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) },
    timeout: DELIVERY_TIMEOUT_MS,
    lookup: (hostname, options, callback) => {
      dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
        if (error) return callback(error, "", 4);
        const list = Array.isArray(addresses) ? addresses : [];
        const safe = list.filter((entry) => !isPrivateAddress(entry.address));
        if (list.length === 0 || safe.length !== list.length) {
          return callback(new Error("Webhook host resolves to a non-public address."), "", 4);
        }
        if (options.all) return callback(null, safe as never, 4);
        return callback(null, safe[0]!.address, safe[0]!.family);
      });
    },
  }, (response) => {
    response.resume(); // the body is ignored; we only care about the status
    resolve({ status: response.statusCode ?? 0 });
  });
  request.on("timeout", () => request.destroy(new Error("Webhook request timed out.")));
  request.on("error", reject);
  request.end(body);
});

/** Send due deliveries. Returns counts for logging. */
export async function deliverDueWebhooks(
  options: { batch?: number; post?: WebhookPost } = {},
  database: Database = getDatabase(),
): Promise<{ delivered: number; retried: number; dead: number }> {
  const post = options.post ?? postToWebhook;
  const counts = { delivered: 0, retried: 0, dead: 0 };
  // Claiming pushes the next attempt out, so a crashed worker's deliveries come back after the lease.
  const claimed = await database<{
    id: string; webhook_id: string; event_type: string; payload: { type: string; data: unknown };
    attempts: number; created_at: Date; url: string;
  }[]>`
    WITH due AS (
      SELECT delivery.id FROM api_webhook_deliveries delivery
      JOIN api_webhooks webhook ON webhook.id = delivery.webhook_id AND webhook.status = 'active'
      WHERE delivery.status = 'pending' AND delivery.next_attempt_at <= now()
      ORDER BY delivery.next_attempt_at
      LIMIT ${options.batch ?? 50}
      FOR UPDATE OF delivery SKIP LOCKED
    )
    UPDATE api_webhook_deliveries delivery
    SET next_attempt_at = now() + interval '2 minutes'
    FROM due, api_webhooks webhook
    WHERE delivery.id = due.id AND webhook.id = delivery.webhook_id
    RETURNING delivery.id, delivery.webhook_id, delivery.event_type, delivery.payload,
      delivery.attempts, delivery.created_at, webhook.url
  `;

  for (const delivery of claimed) {
    const body = JSON.stringify({
      id: delivery.id,
      type: delivery.event_type,
      created_at: delivery.created_at.toISOString(),
      data: delivery.payload.data,
    });
    const secret = webhookSecret(delivery.webhook_id);
    const timestamp = Math.floor(Date.now() / 1000);
    let error: string | null = null;
    try {
      const response = await post(delivery.url, body, {
        "user-agent": "DailDex-Webhooks/1",
        "x-daildex-event": delivery.event_type,
        "x-daildex-delivery": delivery.id,
        "x-daildex-timestamp": String(timestamp),
        "x-daildex-signature": signWebhookBody(secret, body, timestamp),
      });
      if (response.status < 200 || response.status >= 300) error = `Endpoint answered HTTP ${response.status}.`;
    } catch (caught) {
      error = caught instanceof Error ? caught.message.slice(0, 300) : "Delivery failed.";
    }

    if (!error) {
      await database`
        UPDATE api_webhook_deliveries SET status = 'delivered', attempts = attempts + 1, delivered_at = now(), last_error = NULL
        WHERE id = ${delivery.id}
      `;
      await database`UPDATE api_webhooks SET consecutive_failures = 0 WHERE id = ${delivery.webhook_id}`;
      counts.delivered += 1;
      continue;
    }

    const attempt = delivery.attempts + 1;
    const delay = RETRY_DELAYS_SECONDS[attempt - 1];
    if (delay === undefined) {
      await database`
        UPDATE api_webhook_deliveries SET status = 'dead', attempts = ${attempt}, last_error = ${error} WHERE id = ${delivery.id}
      `;
      await database`
        UPDATE api_webhooks
        SET consecutive_failures = consecutive_failures + 1,
            status = CASE WHEN consecutive_failures + 1 >= ${DISABLE_AFTER_FAILURES} THEN 'disabled' ELSE status END
        WHERE id = ${delivery.webhook_id}
      `;
      counts.dead += 1;
    } else {
      await database`
        UPDATE api_webhook_deliveries
        SET attempts = ${attempt}, last_error = ${error}, next_attempt_at = now() + (${delay} * interval '1 second')
        WHERE id = ${delivery.id}
      `;
      counts.retried += 1;
    }
  }
  return counts;
}
