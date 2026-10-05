import { closeDatabase, getDatabase } from "@daildex/db";

type ClaimedEvent = {
  id: string;
  provider: string;
  event_type: string;
  provider_event_id: string;
  payload: Record<string, unknown>;
};

const workerId = `webhook-${process.pid}-${Date.now()}`;
const database = getDatabase();
let processed = 0;

while (processed < 100) {
  const event = await claimNext();
  if (!event) break;
  try {
    await database.begin(async (transaction) => {
      const messageId = providerMessageId(event);
      await transaction`
        INSERT INTO email_delivery_events (
          provider_event_id, provider_message_id, event_type, payload, occurred_at
        ) VALUES (
          ${event.provider_event_id}, ${messageId}, ${event.event_type},
          ${transaction.json(event.payload as never)}, ${eventDate(event.payload)}
        )
        ON CONFLICT (provider_event_id) DO NOTHING
      `;

      if (shouldSuppress(event)) {
        for (const recipient of suppressedRecipients(event)) {
          const subscribers = await transaction<{ id: string }[]>`
            UPDATE subscribers SET status = 'suppressed', updated_at = now()
            WHERE email = ${recipient} AND status <> 'suppressed'
            RETURNING id
          `;
          for (const subscriber of subscribers) {
            await transaction`
              INSERT INTO consent_events (subscriber_id, event_type, metadata)
              VALUES (
                ${subscriber.id}, 'provider_suppressed',
                ${transaction.json({ provider: event.provider, eventType: event.event_type } as never)}
              )
            `;
            await transaction`
              UPDATE email_outbox SET status = 'cancelled', last_error = ${`Recipient suppressed by ${event.provider}`}
              WHERE subscriber_id = ${subscriber.id} AND status IN ('queued', 'failed')
            `;
          }
        }
      }

      await transaction`
        UPDATE provider_webhook_events
        SET status = 'processed', processed_at = now(), last_error = NULL,
            locked_by = NULL, locked_at = NULL
        WHERE id = ${event.id} AND status = 'processing' AND locked_by = ${workerId}
      `;
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown webhook processing error";
    await database`
      UPDATE provider_webhook_events
      SET status = CASE WHEN attempt_count >= 5 THEN 'needs_review' ELSE 'failed' END,
          last_error = ${message.slice(0, 1000)}, locked_by = NULL, locked_at = NULL
      WHERE id = ${event.id} AND status = 'processing' AND locked_by = ${workerId}
    `;
  }
  processed += 1;
}

console.log(`Processed ${processed} provider webhook event${processed === 1 ? "" : "s"}.`);
await closeDatabase();

async function claimNext(): Promise<ClaimedEvent | null> {
  const rows = await database<ClaimedEvent[]>`
    WITH candidate AS (
      SELECT id FROM provider_webhook_events
      WHERE (
          status IN ('pending', 'failed') OR
          (status = 'processing' AND locked_at < now() - interval '10 minutes')
        ) AND attempt_count < 5
      ORDER BY received_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE provider_webhook_events AS event
    SET status = 'processing', attempt_count = attempt_count + 1,
        locked_by = ${workerId}, locked_at = now()
    FROM candidate
    WHERE event.id = candidate.id
    RETURNING event.id, event.provider, event.event_type, event.provider_event_id, event.payload
  `;
  return rows[0] ?? null;
}

function shouldSuppress(event: ClaimedEvent): boolean {
  if (event.provider !== "resend") return false;
  return event.event_type === "email.complained" || event.event_type === "email.bounced";
}

function eventDate(payload: Record<string, unknown>): Date | null {
  const data = resendData(payload);
  const value = stringValue(data.created_at) || stringValue(payload.created_at);
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date;
}

function providerMessageId(event: ClaimedEvent): string | null {
  if (event.provider !== "resend") return null;
  return stringValue(resendData(event.payload).email_id) || null;
}

function suppressedRecipients(event: ClaimedEvent): string[] {
  if (event.provider !== "resend") return [];
  const to = resendData(event.payload).to;
  if (!Array.isArray(to)) return [];
  return to.map((recipient) => stringValue(recipient)).filter(Boolean);
}

function resendData(payload: Record<string, unknown>): Record<string, unknown> {
  const data = payload.data;
  return data && typeof data === "object" ? data as Record<string, unknown> : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}
