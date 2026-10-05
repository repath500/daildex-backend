import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ profile: vi.fn() }));
vi.mock("../chat/service", () => ({ ensureAccountProfileId: mocks.profile }));
vi.mock("@daildex/db", () => ({ getDatabase: () => { throw new Error("tests must inject a database"); } }));
import { deleteStudySpace, getStudySpace, listStudySpaces, saveStudySpace, STUDY_MAX_SPACES, STUDY_MAX_SPACE_BYTES, StudyStorageError } from "./service";

type Call = { sql: string; values: unknown[] };
/** A tagged-template fake: replies are consumed in order and every query is recorded. Not a SQL engine; it checks scoping, ordering and branching. */
function fakeDatabase(replies: unknown[][]) {
  const calls: Call[] = []; const locks: unknown[] = [];
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?").replace(/\s+/g, " ").trim();
    if (sql.includes("pg_advisory_xact_lock")) { locks.push(values[0]); return Promise.resolve([]); } // per-account save lock; consumes no reply
    calls.push({ sql, values }); return Promise.resolve(replies.shift() ?? []);
  };
  const transaction = Object.assign(run, { json: (value: unknown) => ({ json: value }) });
  const database = Object.assign(run, { begin: (fn: (tx: typeof transaction) => unknown) => Promise.resolve(fn(transaction)) });
  return { database: database as never, calls, locks };
}
const login = { subject: "auth0|1", email: "a@example.com", firstName: "A" };
const id = "00000000-0000-4000-8000-0000000000aa";
const at = new Date("2026-10-01T10:00:00.000Z");
const row = (revision = 1, extra = {}) => ({ id, title: "Civics", revision, updated_at: at, ...extra });
const input = (baseRevision: number | null, extra = {}) => ({ id, title: "  Civics  ", data: { id } as never, baseRevision, ...extra });
beforeEach(() => { vi.clearAllMocks(); mocks.profile.mockResolvedValue("profile-1"); });

describe("Study storage scoping", () => {
  it("scopes list, get and delete to the login's profile", async () => {
    const list = fakeDatabase([[row(2)]]);
    expect((await listStudySpaces(login, list.database)).spaces).toEqual([{ id, title: "Civics", revision: 2, updatedAt: at.toISOString() }]);
    expect(list.calls[0].sql).toContain("profile_id = ?"); expect(list.calls[0].values).toEqual(["profile-1"]);
    const get = fakeDatabase([[row(2, { data: { id } })]]);
    expect(await getStudySpace(login, id, get.database)).toMatchObject({ revision: 2, data: { id } });
    expect(get.calls[0].values).toEqual(["profile-1", id]);
    expect(await getStudySpace(login, id, fakeDatabase([[]]).database)).toBeNull();
    const del = fakeDatabase([[]]);
    await deleteStudySpace(login, id, del.database);
    expect(del.calls[0].sql).toContain("DELETE FROM study_spaces WHERE profile_id = ?"); expect(del.calls[0].values).toEqual(["profile-1", id]);
    expect(mocks.profile).toHaveBeenCalledWith(login, expect.anything());
  });
});
describe("Study save concurrency and limits", () => {
  it("creates a new space when no base revision is sent, trimming the title", async () => {
    const { database, calls, locks } = fakeDatabase([[], [{ count: 3 }], [row(1)]]);
    expect(await saveStudySpace(login, input(null), database)).toEqual({ ok: true, revision: 1, updatedAt: at.toISOString() });
    expect(locks).toEqual(["study:profile-1"]);
    expect(calls[0].sql).toContain("FOR UPDATE"); expect(calls[2].sql).toContain("INSERT INTO study_spaces"); expect(calls[2].values).toContain("Civics");
  });
  it("refuses to create past the space limit", async () => {
    const { database } = fakeDatabase([[], [{ count: STUDY_MAX_SPACES }]]);
    await expect(saveStudySpace(login, input(null), database)).rejects.toMatchObject({ status: 409, code: "SPACE_LIMIT" });
  });
  it("reports a conflict with no copy when a device updates a space that no longer exists", async () => {
    expect(await saveStudySpace(login, input(2), fakeDatabase([[]]).database)).toEqual({ ok: false, conflict: null });
  });
  it("updates only when the base revision is current, else returns the server copy", async () => {
    const ok = fakeDatabase([[row(3, { data: { id } })], [row(4)]]);
    expect(await saveStudySpace(login, input(3), ok.database)).toMatchObject({ ok: true, revision: 4 });
    expect(ok.calls[1].sql).toContain("revision = revision + 1"); expect(ok.calls[1].sql).toContain("profile_id = ?");
    const stale = fakeDatabase([[row(5, { data: { server: true } })]]);
    expect(await saveStudySpace(login, input(3), stale.database)).toMatchObject({ ok: false, conflict: { revision: 5, data: { server: true } } });
    expect(stale.calls).toHaveLength(1);
    expect((await saveStudySpace(login, input(null), fakeDatabase([[row(1)]]).database))).toMatchObject({ ok: false });
  });
  it("rejects oversize content before any database work", async () => {
    const { database, calls } = fakeDatabase([]);
    const error = await saveStudySpace(login, input(null, { data: "x".repeat(STUDY_MAX_SPACE_BYTES + 1) }), database).catch((e) => e);
    expect(error).toBeInstanceOf(StudyStorageError); expect(error).toMatchObject({ status: 413, code: "SPACE_TOO_LARGE" });
    expect(calls).toEqual([]); expect(mocks.profile).not.toHaveBeenCalled();
  });
  it("strips NUL characters that Postgres JSONB rejects, keeping the rest of the text", async () => {
    const { database, calls } = fakeDatabase([[], [{ count: 0 }], [row(1)]]);
    await saveStudySpace(login, input(null, { data: { id, sources: [{ text: "Dáil\u0000 Éireann" }] } }), database);
    expect(calls[2].values).toContainEqual({ json: { id, sources: [{ text: "Dáil Éireann" }] } });
  });
  it("falls back to a default title for a blank one", async () => {
    const { database, calls } = fakeDatabase([[], [{ count: 0 }], [row(1)]]);
    await saveStudySpace(login, input(null, { title: "   " }), database);
    expect(calls[2].values).toContain("Study space");
  });
});
