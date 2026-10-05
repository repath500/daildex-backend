import { getEmailProvider } from "@daildex/core/email";
import { getEmailReplyDomain } from "@daildex/core";
import { reconcileSentAlertItems } from "@daildex/core/alerts";
import { isRuntimeControlEnabled } from "@daildex/core/operations";
import { closeDatabase, getDatabase } from "@daildex/db";

type ClaimedEmail = {
  id: string;
  kind: "confirm_subscription" | "alert" | "ai_reply" | "td_office_login";
  recipient: string;
  payload: {
    subject: string;
    text: string;
    html: string;
    replyTo?: string;
    unsubscribeApiUrl?: string;
    inReplyTo?: string;
    references?: string;
  };
  alert_item_id: string | null;
  email_thread_id: string | null;
  ai_reply_id: string | null;
};

const workerId = `email-${process.pid}-${Date.now()}`;
const database = getDatabase();
let processed = 0;

if (!await isRuntimeControlEnabled("email_sending", database)) {
  console.log(JSON.stringify({ event: "worker.paused", worker: "email", control: "email_sending" }));
  await closeDatabase();
  process.exit(0);
}

while (processed < 50) {
  const email = await claimNext();
  if (!email) break;

  if (!await isRuntimeControlEnabled("email_sending", database)) {
    await releaseClaimedForPause(email);
    console.log(JSON.stringify({ event: "email.worker.paused", outboxId: email.id }));
    break;
  }

  try {
    const provider = getEmailProvider();
    const rfcMessageId = email.email_thread_id ? `<${email.id}@${getEmailReplyDomain()}>` : undefined;
    const result = await provider.send({
      id: email.id,
      recipient: email.recipient,
      rfcMessageId,
      ...email.payload,
    });
    await database.begin(async (transaction) => {
      await transaction`
        UPDATE email_outbox
        SET status = 'sent', provider_message_id = ${result.providerMessageId},
            sent_at = now(), locked_by = NULL, locked_at = NULL, last_error = NULL
        WHERE id = ${email.id} AND locked_by = ${workerId}
      `;
      if (email.email_thread_id) {
        await transaction`
          INSERT INTO email_messages (
            email_thread_id, direction, subject, body_text, body_html, provider_message_id,
            rfc_message_id, in_reply_to, references_header
          ) VALUES (
            ${email.email_thread_id},
            ${email.kind === "ai_reply" ? "outbound_ai" : "outbound_alert"},
            ${email.payload.subject}, ${email.payload.text}, ${email.payload.html},
            ${result.providerMessageId}, ${rfcMessageId ?? null},
            ${email.payload.inReplyTo ?? null}, ${email.payload.references ?? null}
          )
        `;
        await transaction`
          UPDATE email_threads SET last_message_at = now() WHERE id = ${email.email_thread_id}
        `;
      }
      if (email.ai_reply_id) {
        await transaction`
          UPDATE ai_replies SET status = 'sent', sent_at = now()
          WHERE id = ${email.ai_reply_id}
        `;
      }
      if (email.alert_item_id) {
        await transaction`
          UPDATE alert_items SET status = 'sent', updated_at = now()
          WHERE id = ${email.alert_item_id}
            AND NOT EXISTS (
              SELECT 1 FROM email_outbox
              WHERE alert_item_id = ${email.alert_item_id} AND id <> ${email.id}
                AND status NOT IN ('sent', 'cancelled')
            )
        `;
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown email provider error";
    await database`
      UPDATE email_outbox
      SET status = CASE
            WHEN ${email.kind} IN ('alert', 'ai_reply') THEN 'needs_review'
            WHEN attempt_count >= 5 THEN 'needs_review'
            ELSE 'failed'
          END,
          last_error = ${message.slice(0, 1000)}, locked_by = NULL, locked_at = NULL
      WHERE id = ${email.id} AND locked_by = ${workerId}
    `;
  }
  processed += 1;
}

await reconcileSentAlertItems(database);
console.log(`Processed ${processed} queued email${processed === 1 ? "" : "s"}.`);
await closeDatabase();

async function claimNext(): Promise<ClaimedEmail | null> {
  const rows = await database<ClaimedEmail[]>`
    WITH candidate AS (
      SELECT id FROM email_outbox
      WHERE (
          status IN ('queued', 'failed') OR
          (status = 'processing' AND locked_at < now() - interval '10 minutes')
        )
        AND attempt_count < 5
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE email_outbox AS outbox
    SET status = 'processing', locked_by = ${workerId}, locked_at = now(),
        attempt_count = attempt_count + 1
    FROM candidate
    WHERE outbox.id = candidate.id
    RETURNING outbox.id, outbox.kind, outbox.recipient::TEXT AS recipient,
      outbox.payload, outbox.alert_item_id, outbox.email_thread_id, outbox.ai_reply_id
  `;
  return rows[0] ?? null;
}

async function releaseClaimedForPause(email: ClaimedEmail) {
  await database`
    UPDATE email_outbox
    SET status = 'queued', attempt_count = GREATEST(attempt_count - 1, 0),
        locked_by = NULL, locked_at = NULL
    WHERE id = ${email.id} AND locked_by = ${workerId}
  `;
}
