import type { Database, TransactionDatabase } from "@daildex/db";
import { getDatabase } from "@daildex/db";
import {
  AppError,
  manageSubscriptionUpdateSchema,
  subscriptionRequestSchema,
  type ManagedSubscription,
  type ManageSubscriptionUpdate,
  type PublicRepresentative,
  type SubscriptionRequest,
} from "@daildex/shared";
import { getAppBaseUrl, getTokenPepper } from "../config";
import { renderConfirmationEmail } from "../email/templates";
import { suppressionHash } from "../privacy/service";
import {
  createOpaqueToken,
  createSubscriberToken,
  hashOpaqueToken,
  verifySubscriberToken,
} from "../security/tokens";
import { enforceHourlyRateLimit } from "../security/rate-limit";

const CONFIRMATION_TTL_HOURS = 24;
const CONSENT_VERSION = "email-alerts-v1";

type SubscriptionAccepted = { accepted: true };
type ConfirmationResult = { manageToken: string; unsubscribeToken: string };

export async function requestSubscription(
  input: SubscriptionRequest,
  availableRepresentatives?: readonly PublicRepresentative[],
  database: Database = getDatabase(),
  requestKeys: readonly string[] = [],
): Promise<SubscriptionAccepted> {
  const parsed = subscriptionRequestSchema.parse(input);
  await enforceSubscriptionRateLimits([`email:${parsed.email}`, ...requestKeys], database);
  const representativeKeys = [...new Set(parsed.representativeIds)];
  const representatives = availableRepresentatives
    ? selectRepresentatives(representativeKeys, availableRepresentatives)
    : await loadRepresentatives(representativeKeys, database);

  const tombstones = await database<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM suppression_tombstones WHERE email_hash = ${suppressionHash(parsed.email)}
    ) AS exists
  `;
  if (tombstones[0]?.exists) return { accepted: true };

  const acquisition = parsed.acquisition && Object.keys(parsed.acquisition).length > 0 ? parsed.acquisition : null;
  const confirmationToken = createOpaqueToken();
  const tokenHash = hashOpaqueToken(confirmationToken, getTokenPepper());
  const localePrefix = parsed.locale === "ga" ? "/ga" : "";
  const confirmationUrl = `${getAppBaseUrl()}${localePrefix}/confirm?token=${encodeURIComponent(confirmationToken)}`;
  const email = renderConfirmationEmail({ confirmationUrl, locale: parsed.locale });

  await database.begin(async (transaction) => {
    for (const representative of representatives) {
      await transaction`
        INSERT INTO representatives (
          representative_key, name, chamber, role, area, party_name, status
        ) VALUES (
          ${representative.id}, ${representative.name}, ${representative.chamber},
          ${representative.role}, ${representative.area}, ${representative.party}, 'active'
        )
        ON CONFLICT (representative_key) DO UPDATE SET
          name = EXCLUDED.name,
          chamber = EXCLUDED.chamber,
          role = EXCLUDED.role,
          area = EXCLUDED.area,
          party_name = EXCLUDED.party_name,
          updated_at = now()
      `;
    }

    const subscribers = await transaction<{ id: string; status: string }[]>`
      INSERT INTO subscribers (email, status, locale, acquisition)
      VALUES (${parsed.email}, 'pending', ${parsed.locale}, ${acquisition ? transaction.json(acquisition) : null})
      ON CONFLICT (email) DO UPDATE SET
        acquisition = coalesce(subscribers.acquisition, EXCLUDED.acquisition),
        status = CASE
          WHEN subscribers.status IN ('active', 'suppressed') THEN subscribers.status
          ELSE 'pending'
        END,
        locale = EXCLUDED.locale,
        updated_at = now()
      RETURNING id, status
    `;
    const subscriber = subscribers[0];
    if (!subscriber) throw new AppError("INTERNAL_ERROR", "Unable to create subscription.", 500);
    if (subscriber.status === "suppressed") return;

    const requests = await transaction<{ id: string }[]>`
      INSERT INTO subscription_requests (
        subscriber_id, token_hash, representative_keys, event_types,
        topic_tags, alert_level, expires_at
      ) VALUES (
        ${subscriber.id}, ${tokenHash}, ${representativeKeys}, ${parsed.eventTypes},
        ${parsed.topicTags}, ${parsed.alertLevel},
        now() + (${CONFIRMATION_TTL_HOURS} * interval '1 hour')
      )
      RETURNING id
    `;
    const request = requests[0];
    if (!request) throw new AppError("INTERNAL_ERROR", "Unable to create confirmation.", 500);

    await transaction`
      INSERT INTO email_outbox (kind, recipient, payload, idempotency_key, subscriber_id)
      VALUES (
        'confirm_subscription',
        ${parsed.email},
        ${transaction.json({ ...email, confirmationUrl })},
        ${`confirm:${request.id}`},
        ${subscriber.id}
      )
    `;
  });

  return { accepted: true };
}

async function enforceSubscriptionRateLimits(keys: readonly string[], database: Database) {
  for (const key of new Set(keys.filter(Boolean))) {
    await enforceHourlyRateLimit({
      namespace: "subscription",
      key,
      limit: 5,
      message: "Too many confirmation requests. Try again later.",
    }, database);
  }
}

export async function listActiveRepresentatives(
  database: Database = getDatabase(),
): Promise<PublicRepresentative[]> {
  return database<PublicRepresentative[]>`
    SELECT representative_key AS id, name, area, party_name AS party, role, chamber
    FROM representatives
    WHERE status = 'active'
    ORDER BY chamber, name
  `;
}

export async function confirmSubscription(
  token: string,
  database: Database = getDatabase(),
): Promise<ConfirmationResult> {
  const tokenHash = hashOpaqueToken(token, getTokenPepper());
  let manageToken = "";
  let unsubscribeToken = "";

  await database.begin(async (transaction) => {
    const rows = await transaction<{
      id: string;
      subscriber_id: string;
      representative_keys: string[];
      event_types: ManagedSubscription["eventTypes"];
      topic_tags: ManagedSubscription["topicTags"];
      alert_level: ManagedSubscription["alertLevel"];
      expires_at: Date;
      used_at: Date | null;
    }[]>`
      SELECT id, subscriber_id, representative_keys, event_types, topic_tags,
        alert_level, expires_at, used_at
      FROM subscription_requests
      WHERE token_hash = ${tokenHash}
      FOR UPDATE
    `;
    const request = rows[0];
    if (!request) throw new AppError("NOT_FOUND", "This confirmation link is invalid.", 404);
    if (request.used_at) throw new AppError("TOKEN_USED", "This confirmation link was already used.", 409);
    if (new Date(request.expires_at).getTime() <= Date.now()) {
      throw new AppError("TOKEN_EXPIRED", "This confirmation link has expired.", 410);
    }

    const representatives = await transaction<{ id: string }[]>`
      SELECT id FROM representatives
      WHERE representative_key = ANY(${request.representative_keys})
        AND status = 'active'
    `;
    if (representatives.length !== request.representative_keys.length) {
      throw new AppError("CONFLICT", "One or more representatives are no longer available.", 409);
    }

    await transaction`DELETE FROM subscriber_follows WHERE subscriber_id = ${request.subscriber_id}`;
    for (const representative of representatives) {
      await transaction`
        INSERT INTO subscriber_follows (
          subscriber_id, representative_id, event_types, topic_tags, alert_level
        ) VALUES (
          ${request.subscriber_id}, ${representative.id}, ${request.event_types},
          ${request.topic_tags}, ${request.alert_level}
        )
      `;
    }

    const subscribers = await transaction<{ token_version: number }[]>`
      UPDATE subscribers
      SET status = 'active', confirmed_at = COALESCE(confirmed_at, now()),
          consent_version = ${CONSENT_VERSION}, updated_at = now()
      WHERE id = ${request.subscriber_id}
        AND status <> 'suppressed'
      RETURNING token_version
    `;
    const subscriber = subscribers[0];
    if (!subscriber) throw new AppError("CONFLICT", "This subscription cannot be activated.", 409);
    await transaction`
      UPDATE subscription_requests SET used_at = now() WHERE id = ${request.id}
    `;
    manageToken = createSubscriberToken(request.subscriber_id, "manage", subscriber.token_version, getTokenPepper());
    unsubscribeToken = createSubscriberToken(request.subscriber_id, "unsubscribe", subscriber.token_version, getTokenPepper());
    await transaction`
      INSERT INTO consent_events (subscriber_id, event_type, consent_version, metadata)
      VALUES (
        ${request.subscriber_id}, 'confirmed', ${CONSENT_VERSION},
        ${transaction.json({
          representativeKeys: request.representative_keys,
          eventTypes: request.event_types,
          topicTags: request.topic_tags,
          alertLevel: request.alert_level,
        })}
      )
    `;
  });

  return { manageToken, unsubscribeToken };
}

export async function getManagedSubscription(
  token: string,
  database: Database = getDatabase(),
): Promise<ManagedSubscription> {
  const access = verifySubscriberToken(token, getTokenPepper());
  if (!access || access.kind !== "manage") {
    throw new AppError("NOT_FOUND", "This manage link is invalid.", 404);
  }
  const rows = await database<{ id: string }[]>`
    SELECT id FROM subscribers
    WHERE id = ${access.subscriberId} AND token_version = ${access.version}
  `;
  if (!rows[0]) throw new AppError("NOT_FOUND", "This manage link is invalid.", 404);
  return loadManagedSubscription(rows[0].id, database);
}

async function loadManagedSubscription(subscriberId: string, database: Database): Promise<ManagedSubscription> {
  const rows = await database<{
    email: string;
    status: ManagedSubscription["status"];
  }[]>`
    SELECT s.email::TEXT AS email, s.status
    FROM subscribers s
    WHERE s.id = ${subscriberId}
  `;
  const subscriber = rows[0];
  if (!subscriber) throw new AppError("NOT_FOUND", "No alerts were found for this account.", 404);

  const follows = await database<{
    representative_key: string;
    event_types: ManagedSubscription["eventTypes"];
    topic_tags: ManagedSubscription["topicTags"];
    alert_level: ManagedSubscription["alertLevel"];
  }[]>`
    SELECT r.representative_key, f.event_types, f.topic_tags, f.alert_level
    FROM subscriber_follows f
    JOIN representatives r ON r.id = f.representative_id
    WHERE f.subscriber_id = ${subscriberId}
    ORDER BY r.name
  `;

  return {
    emailMasked: maskEmail(subscriber.email),
    representativeIds: follows.map((follow) => follow.representative_key),
    eventTypes: follows[0]?.event_types ?? ["vote", "debate", "pq", "news"],
    topicTags: follows[0]?.topic_tags ?? [],
    alertLevel: follows[0]?.alert_level ?? "important_only",
    status: subscriber.status,
  };
}

/**
 * Preference edits need a DáilDex account. The private manage link in each
 * email stays read-only (plus unsubscribe, export and erase), so a forwarded
 * email cannot be used to rewrite someone else's alerts.
 */
export async function getAccountSubscription(
  email: string,
  database: Database = getDatabase(),
): Promise<ManagedSubscription | null> {
  const rows = await database<{ id: string }[]>`
    SELECT id FROM subscribers WHERE email = ${email}
  `;
  return rows[0] ? loadManagedSubscription(rows[0].id, database) : null;
}

export async function updateAccountSubscription(
  email: string,
  input: ManageSubscriptionUpdate,
  database: Database = getDatabase(),
): Promise<ManagedSubscription> {
  const parsed = manageSubscriptionUpdateSchema.parse(input);
  const representativeKeys = [...new Set(parsed.representativeIds)];
  let subscriberId = "";

  await database.begin(async (transaction) => {
    const rows = await transaction<{ id: string; status: ManagedSubscription["status"] }[]>`
      SELECT id, status FROM subscribers WHERE email = ${email} FOR UPDATE
    `;
    const subscriber = rows[0];
    if (!subscriber) throw new AppError("NOT_FOUND", "No alerts were found for this account.", 404);
    if (subscriber.status !== "active") {
      throw new AppError("CONFLICT", "These alerts are not active. Follow a TD again to restart them.", 409);
    }
    subscriberId = subscriber.id;
    await replaceFollows(transaction, subscriber.id, representativeKeys, parsed, "account");
  });

  return loadManagedSubscription(subscriberId, database);
}

export async function unsubscribeAccount(
  email: string,
  database: Database = getDatabase(),
): Promise<{ unsubscribed: true }> {
  await database.begin(async (transaction) => {
    const rows = await transaction<{ id: string }[]>`
      SELECT id FROM subscribers WHERE email = ${email} FOR UPDATE
    `;
    if (!rows[0]) throw new AppError("NOT_FOUND", "No alerts were found for this account.", 404);
    await markUnsubscribed(transaction, rows[0].id);
  });
  return { unsubscribed: true };
}

/** Keep alert emails in English or Irish in step with the account language. */
export async function updateSubscriberLocale(
  email: string,
  locale: "en" | "ga",
  database: Database = getDatabase(),
) {
  await database`
    UPDATE subscribers SET locale = ${locale}, updated_at = now()
    WHERE email = ${email} AND locale <> ${locale}
  `;
}

async function replaceFollows(
  transaction: TransactionDatabase,
  subscriberId: string,
  representativeKeys: string[],
  preferences: ManageSubscriptionUpdate,
  source: "manage_link" | "account",
) {
  const representatives = await transaction<{ id: string }[]>`
    SELECT id FROM representatives
    WHERE representative_key = ANY(${representativeKeys}) AND status = 'active'
  `;
  if (representatives.length !== representativeKeys.length) {
    throw new AppError("INVALID_REQUEST", "Choose valid active representatives.", 400);
  }

  await transaction`DELETE FROM subscriber_follows WHERE subscriber_id = ${subscriberId}`;
  for (const representative of representatives) {
    await transaction`
      INSERT INTO subscriber_follows (
        subscriber_id, representative_id, event_types, topic_tags, alert_level
      ) VALUES (
        ${subscriberId}, ${representative.id}, ${preferences.eventTypes},
        ${preferences.topicTags}, ${preferences.alertLevel}
      )
    `;
  }
  await transaction`
    INSERT INTO consent_events (subscriber_id, event_type, consent_version, metadata)
    VALUES (
      ${subscriberId}, 'preferences_updated', ${CONSENT_VERSION},
      ${transaction.json({ ...preferences, representativeKeys, source })}
    )
  `;
}

async function markUnsubscribed(transaction: TransactionDatabase, subscriberId: string) {
  await transaction`
    UPDATE subscribers SET status = 'unsubscribed', updated_at = now()
    WHERE id = ${subscriberId} AND status <> 'suppressed'
  `;
  await transaction`
    UPDATE email_outbox SET status = 'cancelled'
    WHERE recipient = (SELECT email FROM subscribers WHERE id = ${subscriberId})
      AND status IN ('queued', 'failed')
      AND kind IN ('alert', 'ai_reply')
  `;
  await transaction`
    INSERT INTO consent_events (subscriber_id, event_type, consent_version)
    VALUES (${subscriberId}, 'unsubscribed', ${CONSENT_VERSION})
  `;
}

export async function updateManagedSubscription(
  token: string,
  input: ManageSubscriptionUpdate,
  database: Database = getDatabase(),
): Promise<ManagedSubscription> {
  const parsed = manageSubscriptionUpdateSchema.parse(input);
  const tokenAccess = verifySubscriberToken(token, getTokenPepper());
  if (!tokenAccess || tokenAccess.kind !== "manage") {
    throw new AppError("NOT_FOUND", "This manage link is invalid.", 404);
  }
  const representativeKeys = [...new Set(parsed.representativeIds)];

  await database.begin(async (transaction) => {
    const tokens = await transaction<{ subscriber_id: string }[]>`
      SELECT id AS subscriber_id FROM subscribers
      WHERE id = ${tokenAccess.subscriberId} AND token_version = ${tokenAccess.version}
      FOR UPDATE
    `;
    const access = tokens[0];
    if (!access) throw new AppError("NOT_FOUND", "This manage link is invalid.", 404);
    await replaceFollows(transaction, access.subscriber_id, representativeKeys, parsed, "manage_link");
  });

  return getManagedSubscription(token, database);
}

export async function unsubscribe(
  token: string,
  database: Database = getDatabase(),
): Promise<{ unsubscribed: true }> {
  const tokenAccess = verifySubscriberToken(token, getTokenPepper());
  if (!tokenAccess) throw new AppError("NOT_FOUND", "This unsubscribe link is invalid.", 404);

  await database.begin(async (transaction) => {
    const tokens = await transaction<{ subscriber_id: string }[]>`
      SELECT id AS subscriber_id FROM subscribers
      WHERE id = ${tokenAccess.subscriberId} AND token_version = ${tokenAccess.version}
      FOR UPDATE
    `;
    const access = tokens[0];
    if (!access) throw new AppError("NOT_FOUND", "This unsubscribe link is invalid.", 404);
    await markUnsubscribed(transaction, access.subscriber_id);
  });

  return { unsubscribed: true };
}

async function loadRepresentatives(keys: string[], database: Database): Promise<PublicRepresentative[]> {
  const rows = await database<{
    id: string;
    name: string;
    area: string;
    party: string;
    role: "TD" | "Senator";
    chamber: "Dáil" | "Seanad";
  }[]>`
    SELECT representative_key AS id, name, area, party_name AS party, role, chamber
    FROM representatives
    WHERE representative_key = ANY(${keys}) AND status = 'active'
  `;
  if (rows.length !== keys.length) {
    throw new AppError("INVALID_REQUEST", "Choose valid active representatives.", 400);
  }
  return rows;
}

export async function listPublicRepresentatives(
  database: Database = getDatabase(),
  options: { includeFormer?: boolean } = {},
): Promise<PublicRepresentative[]> {
  const rows = options.includeFormer
    ? await database<PublicRepresentative[]>`
        SELECT representative_key AS id, name, area, party_name AS party, role, chamber
        FROM representatives
        WHERE status IN ('active', 'former')
        ORDER BY CASE WHEN chamber = 'Dáil' THEN 0 ELSE 1 END, name
      `
    : await database<PublicRepresentative[]>`
        SELECT representative_key AS id, name, area, party_name AS party, role, chamber
        FROM representatives
        WHERE status = 'active'
        ORDER BY CASE WHEN chamber = 'Dáil' THEN 0 ELSE 1 END, name
      `;
  return rows;
}

function selectRepresentatives(
  keys: string[],
  representatives: readonly PublicRepresentative[],
): PublicRepresentative[] {
  const byId = new Map(representatives.map((representative) => [representative.id, representative]));
  const selected = keys.map((key) => byId.get(key)).filter((value): value is PublicRepresentative => Boolean(value));
  if (selected.length !== keys.length) {
    throw new AppError("INVALID_REQUEST", "Choose valid active representatives.", 400);
  }
  return selected;
}

function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${"•".repeat(Math.max(3, local.length - visible.length))}@${domain}`;
}
