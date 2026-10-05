import { getDatabase, type Database, type JsonValue } from "@daildex/db";
import { AppError } from "@daildex/shared";
import { getTokenPepper } from "../config";
import { hashOpaqueToken, verifySubscriberToken } from "../security/tokens";

export type PrivacyExport = {
  generatedAt: string;
  profile: Record<string, unknown>;
  follows: Array<Record<string, unknown>>;
  consentHistory: Array<Record<string, unknown>>;
  emailThreads: Array<Record<string, unknown>>;
  emailMessages: Array<Record<string, unknown>>;
  aiReplies: Array<Record<string, unknown>>;
};

export function suppressionHash(email: string, pepper = getTokenPepper()): string {
  return hashOpaqueToken(`suppression:${email.trim().toLocaleLowerCase("en-IE")}`, pepper);
}

export async function exportSubscriberData(token: string, database: Database = getDatabase()): Promise<PrivacyExport> {
  const access = verifyManageAccess(token);
  const profiles = await database<Record<string, unknown>[]>`
    SELECT id, email::TEXT AS email, status, confirmed_at, consent_version, created_at, updated_at
    FROM subscribers WHERE id = ${access.subscriberId} AND token_version = ${access.version}
  `;
  const profile = profiles[0];
  if (!profile) throw new AppError("NOT_FOUND", "This manage link is invalid.", 404);

  const [follows, consentHistory, emailThreads, emailMessages, aiReplies] = await Promise.all([
    database<Record<string, unknown>[]>`
      SELECT representative.name, representative.representative_key, follow.event_types,
        follow.topic_tags, follow.alert_level, follow.created_at, follow.updated_at
      FROM subscriber_follows follow
      JOIN representatives representative ON representative.id = follow.representative_id
      WHERE follow.subscriber_id = ${access.subscriberId} ORDER BY representative.name
    `,
    database<Record<string, unknown>[]>`
      SELECT event_type, consent_version, metadata, created_at
      FROM consent_events WHERE subscriber_id = ${access.subscriberId} ORDER BY created_at
    `,
    database<Record<string, unknown>[]>`
      SELECT thread.id, alert.headline, alert.source_url, thread.created_at, thread.last_message_at
      FROM email_threads thread JOIN alert_items alert ON alert.id = thread.alert_item_id
      WHERE thread.subscriber_id = ${access.subscriberId} ORDER BY thread.created_at
    `,
    database<Record<string, unknown>[]>`
      SELECT message.direction, message.subject, message.body_text, message.created_at
      FROM email_messages message
      JOIN email_threads thread ON thread.id = message.email_thread_id
      WHERE thread.subscriber_id = ${access.subscriberId} ORDER BY message.created_at
    `,
    database<Record<string, unknown>[]>`
      SELECT question, question_type, answer, sources, confidence, status, created_at, sent_at
      FROM ai_replies WHERE subscriber_id = ${access.subscriberId} ORDER BY created_at
    `,
  ]);

  await database`
    INSERT INTO privacy_requests (subject_hash, request_type, status, metadata, completed_at)
    VALUES (
      ${suppressionHash(String(profile.email))}, 'export', 'completed',
      ${database.json({ recordCounts: {
        follows: follows.length,
        consentHistory: consentHistory.length,
        emailThreads: emailThreads.length,
        emailMessages: emailMessages.length,
        aiReplies: aiReplies.length,
      } } as JsonValue)}, now()
    )
  `;

  return {
    generatedAt: new Date().toISOString(), profile, follows, consentHistory,
    emailThreads, emailMessages, aiReplies,
  };
}

export async function eraseSubscriberData(
  token: string,
  database: Database = getDatabase(),
): Promise<{ erased: true }> {
  const access = verifyManageAccess(token);
  await database.begin(async (transaction) => {
    const subscribers = await transaction<{ id: string; email: string }[]>`
      SELECT id, email::TEXT AS email FROM subscribers
      WHERE id = ${access.subscriberId} AND token_version = ${access.version}
      FOR UPDATE
    `;
    const subscriber = subscribers[0];
    if (!subscriber) throw new AppError("NOT_FOUND", "This manage link is invalid.", 404);
    const emailHash = suppressionHash(subscriber.email);

    await transaction`
      INSERT INTO suppression_tombstones (email_hash, reason)
      VALUES (${emailHash}, 'subscriber_erasure')
      ON CONFLICT (email_hash) DO NOTHING
    `;
    await transaction`
      UPDATE provider_webhook_events SET payload = '{"redacted":true}'::JSONB
      WHERE lower(COALESCE(
          payload->>'sender',
          payload->>'from',
          payload->>'recipient',
          payload->>'Recipient',
          payload->>'Email',
          payload#>>'{FromFull,Email}',
          ''
        )) = lower(${subscriber.email})
        OR lower(payload::TEXT) LIKE lower(${`%${subscriber.email}%`})
    `;
    await transaction`
      UPDATE email_delivery_events SET payload = '{"redacted":true}'::JSONB
      WHERE lower(COALESCE(payload->>'Recipient', payload->>'Email', '')) = lower(${subscriber.email})
        OR lower(payload::TEXT) LIKE lower(${`%${subscriber.email}%`})
    `;
    await transaction`
      DELETE FROM email_outbox WHERE lower(recipient::TEXT) = lower(${subscriber.email})
    `;
    await transaction`DELETE FROM subscribers WHERE id = ${subscriber.id}`;
    await transaction`
      INSERT INTO privacy_requests (subject_hash, request_type, status, metadata, completed_at)
      VALUES (${emailHash}, 'erasure', 'completed', '{"providerPayloadsRedacted":true}'::JSONB, now())
    `;
  });
  return { erased: true };
}

function verifyManageAccess(token: string) {
  const access = verifySubscriberToken(token, getTokenPepper());
  if (!access || access.kind !== "manage") {
    throw new AppError("NOT_FOUND", "This manage link is invalid.", 404);
  }
  return access;
}
