import { randomUUID } from "node:crypto";
import { claimReply, createThreadToken, editReply, persistResendInbound, reviewReply, writeReplyDraft } from "@daildex/core";
import { closeDatabase, getDatabase } from "@daildex/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const run = process.env.DATABASE_URL ? describe : describe.skip;

run("Resend inbound receiving integration", () => {
  const database = process.env.DATABASE_URL ? getDatabase() : null!;
  const suffix = randomUUID();
  const email = `resend-${suffix}@example.test`;
  const representativeKey = `fixture-${suffix}`;
  const providerMessageId = `re_${suffix}`;
  const unsubscribeMessageId = `re_unsubscribe_${suffix}`;
  const questionEventId = `msg_question_${suffix}`;
  const unsubscribeEventId = `msg_unsubscribe_${suffix}`;
  const outboundRfcId = `<outbound-${suffix}@reply.example.test>`;
  let threadId = "";
  let representativeId = "";
  let rawEventId = "";
  let alertId = "";

  beforeAll(async () => {
    process.env.TOKEN_HASH_PEPPER = "integration-test-pepper-that-is-not-production";
    process.env.APP_BASE_URL = "http://localhost:3000";
    process.env.EMAIL_REPLY_DOMAIN = "reply.example.test";

    const representatives = await database<{ id: string }[]>`
      INSERT INTO representatives (
        representative_key, name, chamber, role, area, party_name
      ) VALUES (${representativeKey}, 'Fixture TD', 'Dáil', 'TD', 'Test', 'Independent')
      RETURNING id
    `;
    representativeId = representatives[0]!.id;
    const events = await database<{ id: string }[]>`
      INSERT INTO raw_events (
        source_type, source_external_id, source_url, raw_payload, dedupe_hash
      ) VALUES ('fixture', ${suffix}, 'https://example.test/source', '{}'::JSONB, ${suffix})
      RETURNING id
    `;
    rawEventId = events[0]!.id;
    const targets = await database<{ id: string }[]>`
      INSERT INTO raw_event_targets (raw_event_id, representative_id, status)
      VALUES (${rawEventId}, ${representativeId}, 'processed') RETURNING id
    `;
    const alerts = await database<{ id: string }[]>`
      INSERT INTO alert_items (
        raw_event_target_id, representative_id, event_type, headline, summary,
        explanation, source_url, source_label, importance_score, status
      ) VALUES (
        ${targets[0]!.id}, ${representativeId}, 'vote', 'Fixture', 'Fixture', 'Fixture',
        'https://example.test/source', 'Fixture', 1, 'sent'
      ) RETURNING id
    `;
    alertId = alerts[0]!.id;
    const subscribers = await database<{ id: string }[]>`
      INSERT INTO subscribers (email, status, confirmed_at, token_version)
      VALUES (${email}, 'active', now(), 1) RETURNING id
    `;
    const threads = await database<{ id: string }[]>`
      INSERT INTO email_threads (subscriber_id, alert_item_id)
      VALUES (${subscribers[0]!.id}, ${alerts[0]!.id}) RETURNING id
    `;
    threadId = threads[0]!.id;
    await database`
      INSERT INTO email_messages (
        email_thread_id, direction, subject, body_text, rfc_message_id
      ) VALUES (${threadId}, 'outbound_alert', 'Fixture', 'Fixture', ${outboundRfcId})
    `;
  });

  afterAll(async () => {
    await database`DELETE FROM provider_webhook_events WHERE provider_event_id IN (${questionEventId}, ${unsubscribeEventId})`;
    await database`DELETE FROM subscribers WHERE email = ${email}`;
    if (alertId) await database`DELETE FROM alert_items WHERE id = ${alertId}`;
    if (rawEventId) await database`DELETE FROM raw_events WHERE id = ${rawEventId}`;
    if (representativeId) await database`DELETE FROM representatives WHERE id = ${representativeId}`;
    await closeDatabase();
  });

  it("persists, drafts, reviews, unsubscribes, and deduplicates received replies", async () => {
    const threadToken = createThreadToken(threadId, 1, process.env.TOKEN_HASH_PEPPER!);
    const createReceived = (id: string, text: string) => ({
      id,
      from: email,
      to: [`reply+${threadToken}@reply.example.test`],
      subject: "Re: Fixture",
      text,
      headers: {
        "message-id": `<${id}@example.test>`,
        "in-reply-to": outboundRfcId,
      },
    });

    const question = await persistResendInbound(
      createReceived(providerMessageId, "Can you explain what this vote means?"),
      questionEventId,
      database,
    );
    expect(question).toMatchObject({ duplicate: false, questionType: "unknown" });
    const claimed = await claimReply("integration-worker", database);
    expect(claimed?.questionType).toBe("ask_vote_breakdown");
    await writeReplyDraft("integration-worker", claimed!, {
      questionType: "ask_vote_breakdown",
      answer: "This fixture answer is grounded in the retained official event.",
      citations: ["official_event"],
      confidence: 0.9,
    }, { provider: "fixture", model: "fixture", promptVersion: "fixture-v1" }, database);
    await expect(editReply(
      claimed!.replyId,
      "This reviewed fixture answer is grounded in the retained official event.",
      "integration-test",
      database,
    )).resolves.toEqual({ edited: true });
    expect(await reviewReply(claimed!.replyId, "approved", "integration-test", "", database))
      .toMatchObject({ queued: true });

    const first = await persistResendInbound(
      createReceived(unsubscribeMessageId, "Please unsubscribe me"),
      unsubscribeEventId,
      database,
    );
    expect(first).toMatchObject({ duplicate: false, questionType: "unsubscribe" });
    const retry = await persistResendInbound(
      createReceived(unsubscribeMessageId, "Please unsubscribe me"),
      unsubscribeEventId,
      database,
    );
    expect(retry).toMatchObject({ duplicate: true });

    const subscribers = await database<{ status: string }[]>`SELECT status FROM subscribers WHERE email = ${email}`;
    expect(subscribers[0]?.status).toBe("unsubscribed");
    const messages = await database<{ count: string }[]>`
      SELECT count(*)::TEXT AS count FROM email_messages
      WHERE provider_message_id = ${providerMessageId}
    `;
    expect(messages[0]?.count).toBe("1");
    const outbox = await database<{ count: string }[]>`
      SELECT count(*)::TEXT AS count FROM email_outbox
      WHERE idempotency_key LIKE ${`inbound-fixed:%`}
        AND email_thread_id = ${threadId}
    `;
    expect(outbox[0]?.count).toBe("1");
  }, 15_000);
});
