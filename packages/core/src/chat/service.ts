import type { Database } from "@daildex/db";
import { getDatabase, type JsonValue } from "@daildex/db";
import { hasLaunchProAccess, LAUNCH_PRO_WEEK } from "@daildex/shared";
import { getTokenPepper } from "../config";
import { createOpaqueToken, hashOpaqueToken } from "../security/tokens";
import { getActivePromoMultiplier } from "./promo";
import { uploadAllowance, type UploadAllowance } from "./upload-limits";

export const CHAT_DAILY_LIMIT = 50;
export const CHAT_CLOUD_DAILY_LIMIT = 100;
export const CHAT_PRO_DAILY_LIMIT = 500;
const MAX_CLOUD_MESSAGES = 400;
const MAX_JSON_CHARS = 1_500_000;
export const CLOUD_TRAINING_CONSENT_VERSION = "cloud-training-v1";

export class ChatAccessError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: "INVALID_TOKEN" | "DAILY_LIMIT_REACHED" | "CLOUD_CONSENT_REQUIRED" | "MODEL_LOCKED" | "UPLOAD_LIMIT_REACHED" | "PROFILE_EXISTS" | "SIGN_IN_REQUIRED",
  ) {
    super(message);
  }
}

export type ChatProfile = {
  id: string;
  firstName: string;
  email: string;
  remaining: number;
  dailyLimit: number;
  cloudTrainingConsent: boolean;
  promoMultiplier?: number;
  promoExpiresAt?: string | null;
  plan: "free" | "pro";
  proUntil: string | null;
  /** True while Pro comes from the free launch week rather than a paid plan. */
  launchPro?: boolean;
  signedIn: boolean;
  /** BCP 47 code Dex answers in by default, or "auto" to mirror the reader. */
  preferredLanguage: string;
  /** File-upload allowance for this reader (unlimited on Pro). */
  uploads: UploadAllowance;
};

/** Signed-in accounts keep cross-device history without having to opt into training. */
export function canStoreCloudConversations(
  profile: Pick<ChatProfile, "signedIn" | "cloudTrainingConsent">,
) {
  return profile.signedIn || profile.cloudTrainingConsent;
}

type ProfileRow = {
  id: string;
  first_name: string;
  email: string;
  message_count: number;
  cloud_training_consent: boolean;
  plan: string;
  pro_until: Date | null;
  auth_subject: string | null;
  preferred_language: string;
  uploads_this_week: number;
};

/** Pro is active while the plan says so and the paid period has not lapsed. */
export function isProActive(row: { plan: string; pro_until: Date | null }, now = new Date()) {
  return row.plan === "pro" && (!row.pro_until || row.pro_until > now);
}

export type CloudConversationInput = {
  conversationId: string;
  title: string;
  modelId: string;
  messages: unknown;
  createdAt?: string;
  updatedAt?: string;
};

export type CloudSyncResult = {
  ok: true;
  conversationId: string;
  messageCount: number;
};

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

/** Keep cloud rows JSON-safe and bounded so training sync cannot blow past DB/API limits. */
export function sanitizeCloudMessages(messages: unknown): JsonValue {
  const list = Array.isArray(messages) ? messages.slice(0, MAX_CLOUD_MESSAGES) : [];
  const sanitized = list.map((message) => {
    if (!message || typeof message !== "object") return { role: "unknown", parts: [] };
    const record = message as Record<string, unknown>;
    const role = typeof record.role === "string" ? record.role.slice(0, 32) : "unknown";
    const id = typeof record.id === "string" ? record.id.slice(0, 120) : undefined;
    const parts = Array.isArray(record.parts)
      ? record.parts.map((part) => sanitizePart(part)).filter(Boolean)
      : typeof record.content === "string"
        ? [{ type: "text", text: record.content.slice(0, 20_000) }]
        : [];
    return id ? { id, role, parts } : { role, parts };
  });

  let json = JSON.stringify(sanitized);
  if (json.length <= MAX_JSON_CHARS) return sanitized as JsonValue;

  // Prefer keeping later turns if the thread is huge.
  while (sanitized.length > 2 && json.length > MAX_JSON_CHARS) {
    sanitized.shift();
    json = JSON.stringify(sanitized);
  }
  return sanitized as JsonValue;
}

function sanitizePart(part: unknown): Record<string, unknown> | null {
  if (!part || typeof part !== "object") return null;
  const record = part as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type.slice(0, 80) : "unknown";

  if (type === "text" && typeof record.text === "string") {
    return { type, text: record.text.slice(0, 20_000) };
  }

  if (type === "reasoning" && typeof record.text === "string") {
    return { type, text: record.text.slice(0, 8_000) };
  }

  // Keep tool/card names for interactive-training signal, drop bulky payloads.
  if (type.startsWith("tool-") || type === "dynamic-tool" || type === "source" || type === "file") {
    const slim: Record<string, unknown> = { type };
    if (typeof record.toolName === "string") slim.toolName = record.toolName.slice(0, 120);
    if (typeof record.state === "string") slim.state = record.state.slice(0, 40);
    if (typeof record.title === "string") slim.title = record.title.slice(0, 200);
    if (typeof record.filename === "string") slim.filename = record.filename.slice(0, 200);
    if (typeof record.mediaType === "string") slim.mediaType = record.mediaType.slice(0, 80);
    // Uploaded files are private to the device; never copy their bytes into cloud history.
    if (typeof record.url === "string" && !record.url.startsWith("data:")) slim.url = record.url.slice(0, 500);
    return slim;
  }

  try {
    const raw = JSON.stringify(record);
    if (raw.length > 4_000) return { type, truncated: true };
    return toJsonValue(record) as Record<string, unknown>;
  } catch {
    return { type };
  }
}

export function chatDailyLimit(cloudTrainingConsent: boolean, promoMultiplier = 1, pro = false): number {
  if (pro) return CHAT_PRO_DAILY_LIMIT;
  const base = cloudTrainingConsent ? CHAT_CLOUD_DAILY_LIMIT : CHAT_DAILY_LIMIT;
  return base * Math.max(1, Math.min(10, promoMultiplier));
}

export function chatMessagesRemaining(
  count: number,
  cloudTrainingConsent = false,
  promoMultiplier = 1,
  pro = false,
): number {
  return Math.max(0, chatDailyLimit(cloudTrainingConsent, promoMultiplier, pro) - count);
}

async function resolveProfileId(token: string, database: Database) {
  const tokenHash = hashOpaqueToken(token, getTokenPepper());
  const rows = await database<{ id: string }[]>`
    SELECT id FROM chat_profiles WHERE token_hash = ${tokenHash}
  `;
  const profile = rows[0];
  if (!profile) throw new ChatAccessError("This Dex pass is no longer valid.", 401, "INVALID_TOKEN");
  return profile.id;
}

function toChatProfile(
  row: ProfileRow,
  promo: { multiplier: number; expiresAt: Date | null } = { multiplier: 1, expiresAt: null },
): ChatProfile {
  const paidPro = isProActive(row);
  const launchPro = !paidPro && hasLaunchProAccess(row);
  const pro = paidPro || launchPro;
  const dailyLimit = chatDailyLimit(row.cloud_training_consent, promo.multiplier, pro);
  return {
    id: row.id,
    firstName: row.first_name,
    email: row.email,
    remaining: chatMessagesRemaining(row.message_count, row.cloud_training_consent, promo.multiplier, pro),
    dailyLimit,
    cloudTrainingConsent: row.cloud_training_consent,
    promoMultiplier: promo.multiplier,
    promoExpiresAt: promo.expiresAt?.toISOString() ?? null,
    plan: pro ? "pro" : "free",
    proUntil: paidPro ? row.pro_until?.toISOString() ?? null : launchPro ? LAUNCH_PRO_WEEK.endsAt.toISOString() : null,
    launchPro,
    signedIn: Boolean(row.auth_subject),
    preferredLanguage: row.preferred_language ?? "auto",
    uploads: uploadAllowance(pro, row.uploads_this_week ?? 0),
  };
}

function parseTimestamp(value: string | undefined, fallback: Date) {
  if (!value) return fallback;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

export async function createChatProfile(
  input: { firstName: string; email: string },
  database: Database = getDatabase(),
): Promise<ChatProfile & { token: string }> {
  const linked = await database<{ id: string }[]>`
    SELECT id FROM chat_profiles WHERE email = ${input.email} AND auth_subject IS NOT NULL
  `;
  if (linked[0]) {
    throw new ChatAccessError("This email is linked to a DáilDex account. Sign in to continue.", 409, "SIGN_IN_REQUIRED");
  }
  const token = createOpaqueToken();
  const tokenHash = hashOpaqueToken(token, getTokenPepper());
  // The email is the pass. Submitting it again reissues the browser token and
  // keeps the same allowance, consent, and saved chats.
  const rows = await database<{ id: string }[]>`
    INSERT INTO chat_profiles (first_name, email, token_hash, last_seen_at)
    VALUES (${input.firstName}, ${input.email}, ${tokenHash}, now())
    ON CONFLICT (email) DO UPDATE SET
      first_name = EXCLUDED.first_name,
      token_hash = EXCLUDED.token_hash,
      updated_at = now(),
      last_seen_at = now()
    RETURNING id
  `;
  if (!rows[0]) throw new ChatAccessError("This Dex pass is no longer valid.", 401, "INVALID_TOKEN");
  const full = await getChatProfile(token, database);
  return { ...full, token };
}

export async function getChatProfile(
  token: string,
  database: Database = getDatabase(),
): Promise<ChatProfile> {
  const tokenHash = hashOpaqueToken(token, getTokenPepper());
  const rows = await database<ProfileRow[]>`
    SELECT profile.id, profile.first_name, profile.email::TEXT,
      COALESCE(usage.message_count, 0)::INTEGER AS message_count,
      profile.cloud_training_consent, profile.plan, profile.pro_until, profile.auth_subject,
      -- Read through jsonb so Dex keeps working if a deploy lands before migration 0022.
      COALESCE(to_jsonb(profile)->>'preferred_language', 'auto') AS preferred_language,
      0 AS uploads_this_week
    FROM chat_profiles profile
    LEFT JOIN chat_daily_usage usage
      ON usage.profile_id = profile.id AND usage.usage_date = (now() AT TIME ZONE 'UTC')::DATE
    WHERE profile.token_hash = ${tokenHash}
  `;
  const profile = rows[0];
  if (!profile) throw new ChatAccessError("This Dex pass is no longer valid.", 401, "INVALID_TOKEN");
  const promo = await getActivePromoMultiplier(profile.email, database);
  // Separate query so Dex keeps working if a deploy lands before migration 0025 creates the table.
  const uploadsThisWeek = await database<{ count: number }[]>`
    SELECT count(DISTINCT fingerprint)::INTEGER AS count
    FROM chat_upload_events
    WHERE profile_id = ${profile.id} AND created_at > now() - interval '7 days'
  `.then((result) => result[0]?.count ?? 0).catch(() => 0);
  return toChatProfile({ ...profile, uploads_this_week: uploadsThisWeek }, promo);
}

export async function getChatMessagesRemaining(token: string, database: Database = getDatabase()) {
  return (await getChatProfile(token, database)).remaining;
}

export async function updateCloudTrainingConsent(
  token: string,
  consent: boolean,
  database: Database = getDatabase(),
): Promise<ChatProfile> {
  const tokenHash = hashOpaqueToken(token, getTokenPepper());
  await database.begin(async (transaction) => {
    const rows = await transaction<{
      id: string;
      auth_subject: string | null;
    }[]>`
      UPDATE chat_profiles
      SET
        cloud_training_consent = ${consent},
        cloud_training_consent_at = CASE WHEN ${consent} THEN now() ELSE NULL END,
        updated_at = now(),
        last_seen_at = now()
      WHERE token_hash = ${tokenHash}
      RETURNING id, auth_subject
    `;
    const profile = rows[0];
    if (!profile) throw new ChatAccessError("This Dex pass is no longer valid.", 401, "INVALID_TOKEN");

    await transaction`
      INSERT INTO chat_consent_events (profile_id, consent_type, granted, consent_version, metadata)
      VALUES (
        ${profile.id}, 'cloud_training', ${consent}, ${CLOUD_TRAINING_CONSENT_VERSION},
        ${transaction.json({
          purpose: "optional cloud storage and Irish civic model training",
          downstreamUse: "LeemerLabs may use opted-in conversations to train an open-source Irish civic model",
          liveModelProviderSeparate: true,
        } as never)}
      )
    `;

    // Guest cloud history exists only under cloud-training consent. Signed-in
    // account history remains available when training consent is withdrawn.
    if (!consent && !profile.auth_subject) {
      await transaction`DELETE FROM chat_cloud_conversations WHERE profile_id = ${profile.id}`;
    }
  });

  return getChatProfile(token, database);
}

export async function syncCloudConversation(
  token: string,
  input: CloudConversationInput,
  database: Database = getDatabase(),
): Promise<CloudSyncResult> {
  const profile = await getChatProfile(token, database);
  if (!canStoreCloudConversations(profile)) {
    throw new ChatAccessError(
      "Sign in or enable cloud training before chats can be saved to DáilDex.",
      403,
      "CLOUD_CONSENT_REQUIRED",
    );
  }

  const conversationId = input.conversationId.trim().slice(0, 80);
  if (conversationId.length < 8) {
    throw new Error("Conversation id is required.");
  }

  const now = new Date();
  const createdAt = parseTimestamp(input.createdAt, now);
  const updatedAt = parseTimestamp(input.updatedAt, now);
  const messagesJson = sanitizeCloudMessages(input.messages);
  const messageCount = Array.isArray(messagesJson) ? messagesJson.length : 0;
  const title = (input.title.trim() || "New conversation").slice(0, 200);
  const modelId = (input.modelId.trim() || "unknown").slice(0, 80);

  await database`
    INSERT INTO chat_cloud_conversations (
      profile_id, conversation_id, title, model_id, messages, created_at, updated_at
    )
    VALUES (
      ${profile.id},
      ${conversationId},
      ${title},
      ${modelId},
      ${database.json(messagesJson)},
      ${createdAt},
      ${updatedAt}
    )
    ON CONFLICT (profile_id, conversation_id) DO UPDATE SET
      title = EXCLUDED.title,
      model_id = EXCLUDED.model_id,
      messages = EXCLUDED.messages,
      updated_at = EXCLUDED.updated_at
  `;

  return { ok: true, conversationId, messageCount };
}

export async function syncCloudConversations(
  token: string,
  conversations: CloudConversationInput[],
  database: Database = getDatabase(),
) {
  const profile = await getChatProfile(token, database);
  if (!canStoreCloudConversations(profile)) {
    throw new ChatAccessError(
      "Sign in or enable cloud training before chats can be saved to DáilDex.",
      403,
      "CLOUD_CONSENT_REQUIRED",
    );
  }

  const results: CloudSyncResult[] = [];
  for (const conversation of conversations.slice(0, 100)) {
    if (!Array.isArray(conversation.messages) || conversation.messages.length === 0) continue;
    results.push(await syncCloudConversation(token, conversation, database));
  }
  return { ok: true as const, synced: results.length, results };
}

export async function deleteCloudConversation(
  token: string,
  conversationId: string,
  database: Database = getDatabase(),
) {
  const profileId = await resolveProfileId(token, database);
  await database`
    DELETE FROM chat_cloud_conversations
    WHERE profile_id = ${profileId} AND conversation_id = ${conversationId}
  `;
}

export async function countCloudConversations(
  token: string,
  database: Database = getDatabase(),
) {
  const profileId = await resolveProfileId(token, database);
  const rows = await database<{ count: number }[]>`
    SELECT count(*)::INTEGER AS count
    FROM chat_cloud_conversations
    WHERE profile_id = ${profileId}
  `;
  return rows[0]?.count ?? 0;
}

export async function reserveChatMessage(token: string, database: Database = getDatabase()) {
  const tokenHash = hashOpaqueToken(token, getTokenPepper());
  return database.begin(async (transaction) => {
    const profiles = await transaction<{ id: string; email: string; cloud_training_consent: boolean; plan: string; pro_until: Date | null; auth_subject: string | null }[]>`
      SELECT id, email::TEXT, cloud_training_consent, plan, pro_until, auth_subject FROM chat_profiles WHERE token_hash = ${tokenHash} FOR UPDATE
    `;
    const profile = profiles[0];
    if (!profile) throw new ChatAccessError("This Dex pass is no longer valid.", 401, "INVALID_TOKEN");
    const pro = isProActive(profile) || hasLaunchProAccess(profile);
    const promo = await getActivePromoMultiplier(profile.email, transaction);
    const dailyLimit = chatDailyLimit(profile.cloud_training_consent, promo.multiplier, pro);
    const rows = await transaction<{ message_count: number }[]>`
      INSERT INTO chat_daily_usage (profile_id, usage_date, message_count)
      VALUES (${profile.id}, (now() AT TIME ZONE 'UTC')::DATE, 1)
      ON CONFLICT (profile_id, usage_date) DO UPDATE SET
        message_count = chat_daily_usage.message_count + 1,
        updated_at = now()
      RETURNING message_count
    `;
    const count = rows[0]?.message_count ?? 1;
    if (count > dailyLimit) {
      throw new ChatAccessError(
        pro
          ? `You have used today’s ${dailyLimit} Pro messages. Dex resets at midnight UTC.`
          : `You have used today’s ${dailyLimit} free messages. Dex resets at midnight UTC, or go Pro for ${CHAT_PRO_DAILY_LIMIT} a day.`,
        429,
        "DAILY_LIMIT_REACHED",
      );
    }
    await transaction`UPDATE chat_profiles SET last_seen_at = now() WHERE id = ${profile.id}`;
    return {
      remaining: chatMessagesRemaining(count, profile.cloud_training_consent, promo.multiplier, pro),
      dailyLimit,
      cloudTrainingConsent: profile.cloud_training_consent,
      promoMultiplier: promo.multiplier,
      pro,
    };
  });
}

/** Return a message reserved for a request that delivered nothing (a failed or unverifiable Study answer). */
export async function releaseChatMessage(token: string, database: Database = getDatabase()) {
  const tokenHash = hashOpaqueToken(token, getTokenPepper());
  await database`
    UPDATE chat_daily_usage usage SET message_count = GREATEST(usage.message_count - 1, 0), updated_at = now()
    FROM chat_profiles profile
    WHERE profile.token_hash = ${tokenHash} AND usage.profile_id = profile.id
      AND usage.usage_date = (now() AT TIME ZONE 'UTC')::DATE
  `;
}

export async function deleteChatProfile(token: string, database: Database = getDatabase()) {
  const tokenHash = hashOpaqueToken(token, getTokenPepper());
  await database`DELETE FROM chat_profiles WHERE token_hash = ${tokenHash}`;
}

export {
  GAEILGE_BLOG_PROMO,
  getActivePromoMultiplier,
  isGaeilgePromoActive,
  logPromoEmailAttempt,
  redeemGaeilgeBlogPromo,
} from "./promo";
export type { PromoRedeemOutcome, PromoRedeemResult } from "./promo";

/**
 * Sign-in path: find or create the pass for a verified login identity and issue
 * a fresh browser token. Linking locks the email against anonymous reclaim.
 */
export async function signInChatProfile(
  input: { subject: string; email: string; firstName: string },
  database: Database = getDatabase(),
): Promise<ChatProfile & { token: string }> {
  const token = createOpaqueToken();
  const tokenHash = hashOpaqueToken(token, getTokenPepper());
  await database.begin(async (transaction) => {
    const bySubject = await transaction<{ id: string }[]>`
      UPDATE chat_profiles SET token_hash = ${tokenHash}, updated_at = now(), last_seen_at = now()
      WHERE auth_subject = ${input.subject}
      RETURNING id
    `;
    if (bySubject[0]) return;
    await transaction`
      INSERT INTO chat_profiles (first_name, email, token_hash, auth_subject, last_seen_at)
      VALUES (${input.firstName}, ${input.email}, ${tokenHash}, ${input.subject}, now())
      ON CONFLICT (email) DO UPDATE SET
        token_hash = EXCLUDED.token_hash,
        auth_subject = COALESCE(chat_profiles.auth_subject, EXCLUDED.auth_subject),
        updated_at = now(),
        last_seen_at = now()
    `;
  });
  const profile = await getChatProfile(token, database);
  return { ...profile, token };
}

export async function getChatProfileBilling(token: string, database: Database = getDatabase()) {
  const tokenHash = hashOpaqueToken(token, getTokenPepper());
  const rows = await database<{ id: string; email: string; auth_subject: string | null; stripe_customer_id: string | null }[]>`
    SELECT id, email::TEXT, auth_subject, stripe_customer_id FROM chat_profiles WHERE token_hash = ${tokenHash}
  `;
  if (!rows[0]) throw new ChatAccessError("This Dex pass is no longer valid.", 401, "INVALID_TOKEN");
  return { id: rows[0].id, email: rows[0].email, signedIn: Boolean(rows[0].auth_subject), stripeCustomerId: rows[0].stripe_customer_id };
}

/** Apply a Stripe subscription state change. Returns false for events already seen. */
export async function applyChatSubscription(
  input: {
    eventId: string;
    eventType: string;
    profileId?: string | null;
    customerId?: string | null;
    subscriptionId?: string | null;
    active: boolean;
    periodEnd?: Date | null;
  },
  database: Database = getDatabase(),
) {
  return database.begin(async (transaction) => {
    const fresh = await transaction`
      INSERT INTO chat_billing_events (stripe_event_id, event_type, profile_id)
      VALUES (${input.eventId}, ${input.eventType}, ${input.profileId ?? null})
      ON CONFLICT (stripe_event_id) DO NOTHING
      RETURNING stripe_event_id
    `;
    if (fresh.length === 0) return false;
    const plan = input.active ? "pro" : "free";
    if (input.profileId) {
      await transaction`
        UPDATE chat_profiles SET plan = ${plan}, pro_until = ${input.periodEnd ?? null},
          stripe_customer_id = COALESCE(${input.customerId ?? null}, stripe_customer_id),
          stripe_subscription_id = COALESCE(${input.subscriptionId ?? null}, stripe_subscription_id),
          updated_at = now()
        WHERE id = ${input.profileId}
      `;
    } else if (input.customerId) {
      await transaction`
        UPDATE chat_profiles SET plan = ${plan}, pro_until = ${input.periodEnd ?? null}, updated_at = now()
        WHERE stripe_customer_id = ${input.customerId}
      `;
    }
    return true;
  });
}

/** A verified Auth0 login, as the web layer hands it to account functions. */
export type AccountLogin = { subject: string; email: string; firstName: string };

export type ChatAccount = ChatProfile & {
  memberSince: string;
  cloudConversations: number;
  /** Oldest first, one entry per UTC day, zero-filled. */
  usage: { date: string; messages: number }[];
};

export const ACCOUNT_USAGE_DAYS = 30;

/**
 * Find the pass linked to a login, linking or creating one when needed.
 * Unlike signInChatProfile this never rotates the browser token, so opening
 * the account page does not sign Dex out on another device.
 */
export async function ensureAccountProfileId(login: AccountLogin, database: Database = getDatabase()) {
  const bySubject = await database<{ id: string }[]>`
    SELECT id FROM chat_profiles WHERE auth_subject = ${login.subject}
  `;
  if (bySubject[0]) return bySubject[0].id;
  const placeholderHash = hashOpaqueToken(createOpaqueToken(), getTokenPepper());
  const rows = await database<{ id: string }[]>`
    INSERT INTO chat_profiles (first_name, email, token_hash, auth_subject, last_seen_at)
    VALUES (${login.firstName}, ${login.email}, ${placeholderHash}, ${login.subject}, now())
    ON CONFLICT (email) DO UPDATE SET
      auth_subject = COALESCE(chat_profiles.auth_subject, EXCLUDED.auth_subject),
      updated_at = now()
    RETURNING id
  `;
  if (!rows[0]) throw new ChatAccessError("Your DáilDex account could not be loaded.", 401, "INVALID_TOKEN");
  return rows[0].id;
}

export async function getChatAccount(login: AccountLogin, database: Database = getDatabase()): Promise<ChatAccount> {
  const id = await ensureAccountProfileId(login, database);
  const rows = await database<(ProfileRow & { created_at: Date })[]>`
    SELECT profile.id, profile.first_name, profile.email::TEXT,
      COALESCE(usage.message_count, 0)::INTEGER AS message_count,
      profile.cloud_training_consent, profile.plan, profile.pro_until, profile.auth_subject,
      COALESCE(to_jsonb(profile)->>'preferred_language', 'auto') AS preferred_language,
      profile.created_at
    FROM chat_profiles profile
    LEFT JOIN chat_daily_usage usage
      ON usage.profile_id = profile.id AND usage.usage_date = (now() AT TIME ZONE 'UTC')::DATE
    WHERE profile.id = ${id}
  `;
  const row = rows[0];
  if (!row) throw new ChatAccessError("Your DáilDex account could not be loaded.", 401, "INVALID_TOKEN");
  const [promo, history, cloud] = await Promise.all([
    getActivePromoMultiplier(row.email, database),
    database<{ date: string; messages: number }[]>`
      SELECT day::DATE::TEXT AS date, COALESCE(usage.message_count, 0)::INTEGER AS messages
      FROM generate_series(
        (now() AT TIME ZONE 'UTC')::DATE - ${ACCOUNT_USAGE_DAYS - 1}::INTEGER,
        (now() AT TIME ZONE 'UTC')::DATE,
        interval '1 day'
      ) AS day
      LEFT JOIN chat_daily_usage usage
        ON usage.profile_id = ${id} AND usage.usage_date = day::DATE
      ORDER BY day
    `,
    database<{ count: number }[]>`
      SELECT count(*)::INTEGER AS count FROM chat_cloud_conversations WHERE profile_id = ${id}
    `,
  ]);
  return {
    ...toChatProfile(row, promo),
    memberSince: row.created_at.toISOString(),
    cloudConversations: cloud[0]?.count ?? 0,
    usage: history,
  };
}

export async function updateChatAccountLanguage(
  login: AccountLogin,
  preferredLanguage: string,
  database: Database = getDatabase(),
) {
  const id = await ensureAccountProfileId(login, database);
  await database`
    UPDATE chat_profiles SET preferred_language = ${preferredLanguage}, updated_at = now()
    WHERE id = ${id}
  `;
  return getChatAccount(login, database);
}
