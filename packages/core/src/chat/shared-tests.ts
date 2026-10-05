import { createHash, randomBytes } from "node:crypto";
import type { Database } from "@daildex/db";
import { getDatabase } from "@daildex/db";
import { getTokenPepper } from "../config";
import { hashOpaqueToken } from "../security/tokens";
import { ChatAccessError } from "./service";

const MAX_TEST_JSON_CHARS = 60_000;
const SHARES_PER_DAY = 30;
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

export type SharedTestRecord = {
  id: string;
  title: string;
  test: unknown;
  createdAt: string;
  expiresAt: string;
};

function newId() {
  const bytes = randomBytes(10);
  return Array.from(bytes, (byte) => ALPHABET[byte % ALPHABET.length]).join("");
}

/**
 * Publish a test paper at a short link. The caller has already validated the paper; only the
 * paper is stored. Sharing the same paper again returns the same link.
 */
export async function createSharedTest(
  token: string,
  input: { title: string; test: unknown },
  database: Database = getDatabase(),
): Promise<{ id: string; expiresAt: string; reused: boolean }> {
  const json = JSON.stringify(input.test);
  if (json.length > MAX_TEST_JSON_CHARS) throw new Error("That test is too large to share.");
  const contentHash = createHash("sha256").update(json).digest("hex");
  const tokenHash = hashOpaqueToken(token, getTokenPepper());

  return database.begin(async (transaction) => {
    const profiles = await transaction<{ id: string }[]>`SELECT id FROM chat_profiles WHERE token_hash = ${tokenHash} FOR UPDATE`;
    const profile = profiles[0];
    if (!profile) throw new ChatAccessError("This Dex pass is no longer valid.", 401, "INVALID_TOKEN");

    const existing = await transaction<{ id: string; expires_at: Date }[]>`
      SELECT id, expires_at FROM shared_tests
      WHERE profile_id = ${profile.id} AND content_hash = ${contentHash} AND expires_at > now()
    `;
    if (existing[0]) return { id: existing[0].id, expiresAt: existing[0].expires_at.toISOString(), reused: true };

    const recent = await transaction<{ count: number }[]>`
      SELECT count(*)::INTEGER AS count FROM shared_tests
      WHERE profile_id = ${profile.id} AND created_at > now() - interval '1 day'
    `;
    if ((recent[0]?.count ?? 0) >= SHARES_PER_DAY) {
      throw new ChatAccessError("You have shared a lot of tests today. Try again tomorrow.", 429, "DAILY_LIMIT_REACHED");
    }

    const id = newId();
    const rows = await transaction<{ expires_at: Date }[]>`
      INSERT INTO shared_tests (id, profile_id, content_hash, title, test)
      VALUES (${id}, ${profile.id}, ${contentHash}, ${input.title.slice(0, 120)}, ${transaction.json(input.test as never)})
      ON CONFLICT DO NOTHING
      RETURNING expires_at
    `;
    if (!rows[0]) throw new Error("Could not create the share link. Try again.");
    return { id, expiresAt: rows[0].expires_at.toISOString(), reused: false };
  });
}

/** Load a shared test and count the view. Returns null when it is missing or expired. */
export async function getSharedTest(id: string, database: Database = getDatabase()): Promise<SharedTestRecord | null> {
  if (!/^[a-z0-9]{8,16}$/.test(id)) return null;
  const rows = await database<{ id: string; title: string; test: unknown; created_at: Date; expires_at: Date }[]>`
    UPDATE shared_tests SET view_count = view_count + 1
    WHERE id = ${id} AND expires_at > now()
    RETURNING id, title, test, created_at, expires_at
  `;
  const row = rows[0];
  return row ? { id: row.id, title: row.title, test: row.test, createdAt: row.created_at.toISOString(), expiresAt: row.expires_at.toISOString() } : null;
}
