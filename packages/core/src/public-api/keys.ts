import { randomBytes } from "node:crypto";
import { getDatabase, type Database } from "@daildex/db";
import { AppError } from "@daildex/shared";
import { getTokenPepper } from "../config";
import { hashOpaqueToken } from "../security/tokens";

export const API_KEY_PREFIX = "dd_live_";
export const MAX_ACTIVE_API_KEYS = 5;

export type ApiKeyTier = "free" | "partner";

export type ApiKeySummary = {
  id: string;
  name: string;
  prefix: string;
  tier: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

export type CreatedApiKey = Pick<ApiKeySummary, "id" | "name" | "prefix" | "createdAt"> & {
  /** The full key. Shown once; only a keyed hash is stored. */
  key: string;
  tier: "free";
};

export type VerifiedApiKey = { id: string; tier: ApiKeyTier };

const KEY_PATTERN = /^dd_live_[A-Za-z0-9_-]{32,64}$/;

export function looksLikeApiKey(value: string): boolean {
  return KEY_PATTERN.test(value);
}

export function hashApiKey(key: string): string {
  return hashOpaqueToken(`api-key:${key}`, getTokenPepper());
}

export async function createApiKey(
  input: { profileId: string; name: string },
  database: Database = getDatabase(),
): Promise<CreatedApiKey> {
  const name = input.name.trim();
  if (name.length < 1 || name.length > 60) {
    throw new AppError("INVALID_REQUEST", "Give the key a name of 1 to 60 characters.", 400);
  }
  const key = `${API_KEY_PREFIX}${randomBytes(24).toString("base64url")}`;
  const prefix = key.slice(0, API_KEY_PREFIX.length + 6);

  // Serialise per account so two concurrent requests cannot both pass the cap.
  const created = await database.begin(async (transaction) => {
    await transaction`SELECT pg_advisory_xact_lock(hashtext(${`api-keys:${input.profileId}`}))`;
    const [{ active }] = await transaction<{ active: number }[]>`
      SELECT count(*)::INT AS active FROM api_keys
      WHERE profile_id = ${input.profileId} AND revoked_at IS NULL
    `;
    if (active >= MAX_ACTIVE_API_KEYS) {
      throw new AppError("INVALID_REQUEST", `You can have up to ${MAX_ACTIVE_API_KEYS} active keys. Revoke one first.`, 400);
    }
    const [row] = await transaction<{ id: string; created_at: Date }[]>`
      INSERT INTO api_keys (profile_id, name, prefix, key_hash)
      VALUES (${input.profileId}, ${name}, ${prefix}, ${hashApiKey(key)})
      RETURNING id, created_at
    `;
    return row!;
  });

  return { id: created.id, name, prefix, key, tier: "free", createdAt: created.created_at.toISOString() };
}

export async function listApiKeys(
  profileId: string,
  database: Database = getDatabase(),
): Promise<ApiKeySummary[]> {
  const rows = await database<{
    id: string; name: string; prefix: string; tier: string;
    created_at: Date; last_used_at: Date | null; revoked_at: Date | null;
  }[]>`
    SELECT id, name, prefix, tier, created_at, last_used_at, revoked_at
    FROM api_keys
    WHERE profile_id = ${profileId}
    ORDER BY created_at DESC
    LIMIT 50
  `;
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    tier: row.tier,
    createdAt: row.created_at.toISOString(),
    lastUsedAt: row.last_used_at?.toISOString() ?? null,
    revokedAt: row.revoked_at?.toISOString() ?? null,
  }));
}

export async function revokeApiKey(
  profileId: string,
  id: string,
  database: Database = getDatabase(),
): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
  const rows = await database<{ id: string }[]>`
    UPDATE api_keys SET revoked_at = now()
    WHERE id = ${id} AND profile_id = ${profileId} AND revoked_at IS NULL
    RETURNING id
  `;
  return rows.length > 0;
}

/** Resolve a presented key to an active key row, or null when it is unknown or revoked. */
export async function verifyApiKey(
  key: string,
  database: Database = getDatabase(),
): Promise<VerifiedApiKey | null> {
  if (!looksLikeApiKey(key)) return null;
  const rows = await database<{ id: string; tier: ApiKeyTier }[]>`
    SELECT id, tier FROM api_keys
    WHERE key_hash = ${hashApiKey(key)} AND revoked_at IS NULL
  `;
  return rows[0] ?? null;
}

/** Best-effort bookkeeping; callers should throttle and never await it on the request path. */
export async function touchApiKey(id: string, database: Database = getDatabase()): Promise<void> {
  await database`UPDATE api_keys SET last_used_at = now() WHERE id = ${id}`;
}
