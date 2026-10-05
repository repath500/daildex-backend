import type { Database, JsonValue } from "@daildex/db";
import { getDatabase } from "@daildex/db";
import { ensureAccountProfileId, type AccountLogin } from "../chat/service";

export const STUDY_MAX_SPACES = 50;
/** Serialised size cap per space: 30 sources of long text plus practice, cards and drafts. */
export const STUDY_MAX_SPACE_BYTES = 4_000_000;

export class StudyStorageError extends Error {
  constructor(message: string, readonly status: number, readonly code: "SPACE_LIMIT" | "SPACE_TOO_LARGE" | "NOT_FOUND") {
    super(message);
  }
}

export type StudySpaceIndexEntry = { id: string; title: string; revision: number; updatedAt: string };
export type StoredStudySpace = StudySpaceIndexEntry & { data: JsonValue };
export type StudySaveResult =
  | { ok: true; revision: number; updatedAt: string }
  | { ok: false; conflict: StoredStudySpace | null };

type Row = { id: string; title: string; revision: number; updated_at: Date; data?: JsonValue };
const entry = (row: Row): StudySpaceIndexEntry => ({ id: row.id, title: row.title, revision: row.revision, updatedAt: row.updated_at.toISOString() });

/** Every Study query is scoped to the signed-in account's profile; there are no cross-account reads. */
export async function listStudySpaces(login: AccountLogin, database: Database = getDatabase()) {
  const profileId = await ensureAccountProfileId(login, database);
  const rows = await database<Row[]>`
    SELECT id, title, revision, updated_at FROM study_spaces WHERE profile_id = ${profileId} ORDER BY updated_at DESC
  `;
  return { profileId, spaces: rows.map(entry) };
}

export async function getStudySpace(login: AccountLogin, id: string, database: Database = getDatabase()): Promise<StoredStudySpace | null> {
  const profileId = await ensureAccountProfileId(login, database);
  const rows = await database<Row[]>`
    SELECT id, title, revision, updated_at, data FROM study_spaces WHERE profile_id = ${profileId} AND id = ${id}
  `;
  return rows[0] ? { ...entry(rows[0]), data: rows[0].data ?? null } : null;
}

/**
 * Save a space when the caller's base revision is still current (null creates it).
 * A stale base returns the server copy so the device can keep both versions instead of overwriting.
 */
/** Postgres JSONB rejects NUL characters, which PDF text extraction can produce. */
function withoutNul(value: JsonValue): JsonValue {
  if (typeof value === "string") return value.replaceAll("\u0000", "");
  if (Array.isArray(value)) return value.map(withoutNul);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, withoutNul(child as JsonValue)]));
  return value;
}

export async function saveStudySpace(
  login: AccountLogin,
  input: { id: string; title: string; data: JsonValue; baseRevision: number | null },
  database: Database = getDatabase(),
): Promise<StudySaveResult> {
  const data = withoutNul(input.data);
  const bytes = Buffer.byteLength(JSON.stringify(data));
  if (bytes > STUDY_MAX_SPACE_BYTES) throw new StudyStorageError("This space is too large to save. Move some sources into another space.", 413, "SPACE_TOO_LARGE");
  const profileId = await ensureAccountProfileId(login, database);
  const title = input.title.trim().slice(0, 160) || "Study space";
  return database.begin(async (transaction) => {
    // Serialise saves per account so concurrent creates cannot pass the space limit or race on insert.
    await transaction`SELECT pg_advisory_xact_lock(hashtext(${`study:${profileId}`}))`;
    const current = await transaction<Row[]>`
      SELECT id, title, revision, updated_at, data FROM study_spaces WHERE profile_id = ${profileId} AND id = ${input.id} FOR UPDATE
    `;
    if (!current[0]) {
      if (input.baseRevision !== null) return { ok: false as const, conflict: null };
      const count = await transaction<{ count: number }[]>`SELECT count(*)::INTEGER AS count FROM study_spaces WHERE profile_id = ${profileId}`;
      if ((count[0]?.count ?? 0) >= STUDY_MAX_SPACES) throw new StudyStorageError(`Your account holds up to ${STUDY_MAX_SPACES} study spaces. Delete one to make room.`, 409, "SPACE_LIMIT");
      const rows = await transaction<Row[]>`
        INSERT INTO study_spaces (profile_id, id, title, data, bytes)
        VALUES (${profileId}, ${input.id}, ${title}, ${transaction.json(data)}, ${bytes})
        RETURNING id, title, revision, updated_at
      `;
      return { ok: true as const, revision: rows[0].revision, updatedAt: rows[0].updated_at.toISOString() };
    }
    if (current[0].revision !== input.baseRevision) return { ok: false as const, conflict: { ...entry(current[0]), data: current[0].data ?? null } };
    const rows = await transaction<Row[]>`
      UPDATE study_spaces SET title = ${title}, data = ${transaction.json(data)}, bytes = ${bytes}, revision = revision + 1, updated_at = now()
      WHERE profile_id = ${profileId} AND id = ${input.id}
      RETURNING id, title, revision, updated_at
    `;
    return { ok: true as const, revision: rows[0].revision, updatedAt: rows[0].updated_at.toISOString() };
  });
}

export async function deleteStudySpace(login: AccountLogin, id: string, database: Database = getDatabase()) {
  const profileId = await ensureAccountProfileId(login, database);
  await database`DELETE FROM study_spaces WHERE profile_id = ${profileId} AND id = ${id}`;
}
