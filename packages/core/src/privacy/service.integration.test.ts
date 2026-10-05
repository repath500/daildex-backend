import { randomUUID } from "node:crypto";
import { closeDatabase, getDatabase } from "@daildex/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSubscriberToken } from "../security/tokens";
import { eraseSubscriberData, exportSubscriberData, suppressionHash } from "./service";

const run = process.env.DATABASE_URL ? describe : describe.skip;

run("subscriber privacy lifecycle", () => {
  const database = process.env.DATABASE_URL ? getDatabase() : null!;
  const suffix = randomUUID();
  const email = `privacy-${suffix}@example.test`;
  const providerEventId = `privacy:${suffix}`;
  let subscriberId = "";
  let token = "";

  beforeAll(async () => {
    process.env.TOKEN_HASH_PEPPER = "privacy-integration-pepper";
    const subscribers = await database<{ id: string }[]>`
      INSERT INTO subscribers (email, status, confirmed_at, consent_version)
      VALUES (${email}, 'active', now(), 'test') RETURNING id
    `;
    subscriberId = subscribers[0]!.id;
    token = createSubscriberToken(subscriberId, "manage", 1, process.env.TOKEN_HASH_PEPPER!);
    await database`
      INSERT INTO consent_events (subscriber_id, event_type, consent_version)
      VALUES (${subscriberId}, 'confirmed', 'test')
    `;
    await database`
      INSERT INTO email_outbox (kind, recipient, payload, idempotency_key, subscriber_id)
      VALUES ('confirm_subscription', ${email}, '{}'::JSONB, ${`privacy:${suffix}`}, ${subscriberId})
    `;
    await database`
      INSERT INTO provider_webhook_events (provider, event_type, provider_event_id, payload, status)
      VALUES (
        'resend', 'email.received', ${providerEventId},
        ${database.json({ sender: email, "body-plain": "private fixture" })}, 'processed'
      )
    `;
  });

  afterAll(async () => {
    await database`DELETE FROM subscribers WHERE email = ${email}`;
    await database`DELETE FROM provider_webhook_events WHERE provider_event_id = ${providerEventId}`;
    await database`DELETE FROM privacy_requests WHERE subject_hash = ${suppressionHash(email)}`;
    await database`DELETE FROM suppression_tombstones WHERE email_hash = ${suppressionHash(email)}`;
    await closeDatabase();
  });

  it("exports the subject data, erases cascades, redacts provider payloads, and leaves only a hash", async () => {
    const exported = await exportSubscriberData(token, database);
    expect(exported.profile.email).toBe(email);
    expect(exported.consentHistory).toHaveLength(1);

    await expect(eraseSubscriberData(token, database)).resolves.toEqual({ erased: true });
    const subscribers = await database<{ count: string }[]>`
      SELECT count(*)::TEXT AS count FROM subscribers WHERE id = ${subscriberId}
    `;
    expect(subscribers[0]?.count).toBe("0");
    const outbox = await database<{ count: string }[]>`
      SELECT count(*)::TEXT AS count FROM email_outbox WHERE recipient = ${email}
    `;
    expect(outbox[0]?.count).toBe("0");
    const events = await database<{ payload: Record<string, unknown> }[]>`
      SELECT payload FROM provider_webhook_events WHERE provider_event_id = ${providerEventId}
    `;
    expect(events[0]?.payload).toEqual({ redacted: true });
    const tombstones = await database<{ email_hash: string }[]>`
      SELECT email_hash FROM suppression_tombstones WHERE email_hash = ${suppressionHash(email)}
    `;
    expect(tombstones[0]?.email_hash).toBeTruthy();
    expect(JSON.stringify(tombstones)).not.toContain(email);
    await expect(exportSubscriberData(token, database)).rejects.toMatchObject({ code: "NOT_FOUND" });
  }, 15_000);
});
