import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ profile: vi.fn() }));
vi.mock("../chat/service", () => ({ ensureAccountProfileId: mocks.profile }));
vi.mock("@daildex/db", () => ({ getDatabase: () => { throw new Error("tests must inject a database"); } }));
import {
  ClassError, closeClass, computeAggregates, createClass, deleteClass, deleteClassResults, formatClassCode, getClassForTeacher, getOpenClassByCode,
  getOpenClassTest, listClasses, newClassCode, normalizeClassCode, purgeExpiredClassData, submitClassResult, MAX_CLASSES_PER_ACCOUNT, MAX_RESULTS_PER_CLASS,
} from "./classes";

type Call = { sql: string; values: unknown[] };
/** Tagged-template fake: replies are consumed in order and every query is recorded (checks scoping and branching, not SQL). */
function fakeDatabase(replies: unknown[][]) {
  const calls: Call[] = [];
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?").replace(/\s+/g, " ").trim();
    if (sql.includes("pg_advisory_xact_lock")) return Promise.resolve([]);
    calls.push({ sql, values });
    return Promise.resolve(replies.shift() ?? []);
  };
  const transaction = Object.assign(run, { json: (value: unknown) => ({ json: value }) });
  const database = Object.assign(run, { begin: (fn: (tx: typeof transaction) => unknown) => Promise.resolve(fn(transaction)) });
  return { database: database as never, calls };
}
const login = { subject: "auth0|1", email: "t@example.com", firstName: "T" };
const at = new Date("2026-10-01T10:00:00.000Z");
const test = { title: "Mock: the Oireachtas", questions: [{ prompt: "Q1", topic: "Dáil" }, { prompt: "Q2", topic: "Seanad" }, { prompt: "Q3", topic: "Seanad" }] };
const row = (extra = {}) => ({ id: "c1", name: "5B CSPE", code: "K7QM2P", shared_test_id: "abcd2345xy", test, max_score: 5, question_maxes: [1, 1, 3], is_open: true, created_at: at, expires_at: at, ...extra });
beforeEach(() => { vi.clearAllMocks(); mocks.profile.mockResolvedValue("profile-1"); });

describe("class codes", () => {
  it("generates unambiguous 6-character codes and normalises typed input", () => {
    for (let i = 0; i < 200; i += 1) expect(newClassCode()).toMatch(/^[A-HJKMNP-Z2-9]{6}$/);
    expect(normalizeClassCode(" k7q-m2p ")).toBe("K7QM2P");
    expect(formatClassCode("K7QM2P")).toBe("K7Q-M2P");
    for (const bad of ["K7Q-M2", "K7Q-M2PX", "K0Q-M2P", "KIQ-M2P", "", "K7Q M2L"]) expect(normalizeClassCode(bad)).toBeNull();
  });
});

describe("createClass", () => {
  const input = { name: "  5B  CSPE ", test, questionMaxes: [1, 1, 3] };
  it("publishes the paper for the account, then inserts a class scoped to the profile", async () => {
    const { database, calls } = fakeDatabase([[{ count: 2 }], [], [{ id: "newshare12" }], [row()]]);
    const created = await createClass(login, input, database);
    expect(created).toMatchObject({ name: "5B CSPE", code: "K7QM2P", testTitle: "Mock: the Oireachtas", questionCount: 3, maxScore: 5, open: true });
    expect(calls[2].sql).toContain("INSERT INTO shared_tests"); expect(calls[2].values).toContain("profile-1");
    expect(calls[3].sql).toContain("INSERT INTO study_classes"); expect(calls[3].values).toContain("profile-1"); expect(calls[3].values).toContain(5); expect(calls[3].values).toContain("5B CSPE");
  });
  it("reuses an identical paper the account already shared", async () => {
    const { database, calls } = fakeDatabase([[{ count: 0 }], [{ id: "oldshare12" }], [row({ shared_test_id: "oldshare12" })]]);
    await createClass(login, input, database);
    expect(calls.some((call) => call.sql.includes("INSERT INTO shared_tests"))).toBe(false);
    expect(calls[2].values).toContain("oldshare12");
  });
  it("pins an existing share link only while it is unexpired", async () => {
    const ok = fakeDatabase([[{ count: 0 }], [{ id: "abcd2345xy" }], [row()]]);
    await createClass(login, { ...input, sharedTestId: "abcd2345xy" }, ok.database);
    expect(ok.calls[1].sql).toContain("expires_at > now()");
    await expect(createClass(login, { ...input, sharedTestId: "abcd2345xy" }, fakeDatabase([[{ count: 0 }], []]).database)).rejects.toMatchObject({ status: 404, code: "TEST_UNAVAILABLE" });
  });
  it("enforces the per-account class limit and rejects empty tests or names", async () => {
    await expect(createClass(login, input, fakeDatabase([[{ count: MAX_CLASSES_PER_ACCOUNT }]]).database)).rejects.toMatchObject({ status: 409, code: "CLASS_LIMIT" });
    await expect(createClass(login, { ...input, questionMaxes: [] }, fakeDatabase([]).database)).rejects.toBeInstanceOf(ClassError);
    await expect(createClass(login, { ...input, name: "   " }, fakeDatabase([]).database)).rejects.toBeInstanceOf(ClassError);
  });
  it("retries on a code collision", async () => {
    const { database, calls } = fakeDatabase([[{ count: 0 }], [{ id: "x" }], [], [row()]]);
    await createClass(login, input, database);
    expect(calls.filter((call) => call.sql.includes("INSERT INTO study_classes"))).toHaveLength(2);
  });
});

describe("teacher reads and writes are scoped to the profile", () => {
  it("lists only this account's unexpired classes", async () => {
    const { database, calls } = fakeDatabase([[row({ result_count: 4 })]]);
    expect(await listClasses(login, database)).toMatchObject([{ id: "c1", resultCount: 4 }]);
    expect(calls[0].sql).toContain("c.profile_id = ?"); expect(calls[0].sql).toContain("c.expires_at > now()");
  });
  it("returns null for another teacher's class", async () => {
    const { database, calls } = fakeDatabase([[]]);
    expect(await getClassForTeacher(login, "c9", database)).toBeNull();
    expect(calls[0].values).toEqual(["c9", "profile-1"]); expect(calls).toHaveLength(1);
  });
  it("loads aggregates and unexpired results", async () => {
    const { database, calls } = fakeDatabase([[row()], [
      { id: "r1", display_name: "Aoife", score: 5, max_score: 5, question_marks: [1, 1, 3], answers: null, submitted_at: at },
      { id: "r2", display_name: "Seán", score: 1, max_score: 5, question_marks: [1, 0, 0], answers: null, submitted_at: at },
    ]]);
    const detail = await getClassForTeacher(login, "c1", database);
    expect(calls[1].sql).toContain("submitted_at > now() - make_interval");
    expect(detail?.summary.resultCount).toBe(2);
    expect(detail?.aggregates).toMatchObject({ count: 2, averagePercent: 60, medianPercent: 60 });
    expect(detail?.aggregates.mostMissed[0]).toMatchObject({ index: 1, prompt: "Q2", averagePercent: 50 });
  });
  it("scopes close, delete results and delete to the owner", async () => {
    const close = fakeDatabase([[{ id: "c1" }]]);
    expect(await closeClass(login, "c1", false, close.database)).toBe(true);
    expect(close.calls[0].sql).toContain("profile_id = ?"); expect(close.calls[0].values).toEqual([false, "c1", "profile-1"]);
    expect(await closeClass(login, "c1", false, fakeDatabase([[]]).database)).toBe(false);
    const results = fakeDatabase([[{ id: "c1" }], []]);
    expect(await deleteClassResults(login, "c1", results.database)).toBe(true);
    expect(results.calls[1].sql).toContain("DELETE FROM study_class_results");
    const notMine = fakeDatabase([[]]);
    expect(await deleteClassResults(login, "c1", notMine.database)).toBe(false); expect(notMine.calls).toHaveLength(1);
    const del = fakeDatabase([[{ id: "c1" }]]);
    expect(await deleteClass(login, "c1", del.database)).toBe(true); expect(del.calls[0].values).toEqual(["c1", "profile-1"]);
  });
});

describe("computeAggregates", () => {
  it("handles an empty class", () => {
    expect(computeAggregates(5, [1, 1, 3], [])).toMatchObject({ count: 0, averagePercent: null, medianPercent: null, mostMissed: [] });
  });
  it("buckets students into the five bands and rates each question", () => {
    const results = [{ score: 5, questionMarks: [1, 1, 3] }, { score: 2, questionMarks: [0, 1, 1] }, { score: 0, questionMarks: [0, 0, 0] }, { score: 4, questionMarks: [1, 1, 2] }];
    const aggregates = computeAggregates(5, [1, 1, 3], results);
    expect(aggregates.distribution.map((band) => band.count)).toEqual([1, 1, 0, 1, 1]); // 0%, 40%, 80%, 100% (and 55-69 empty)
    expect(aggregates.distribution.map((band) => band.count).reduce((a, b) => a + b)).toBe(4);
    expect(aggregates.questions[2]).toMatchObject({ averagePercent: 50, fullCreditPercent: 25 });
    expect(aggregates.averagePercent).toBe(55);
  });
});

describe("public class access", () => {
  it("reveals only the test id and class name of an open class", async () => {
    const { database, calls } = fakeDatabase([[{ name: "5B CSPE", shared_test_id: "abcd2345xy", profile_id: "secret" }]]);
    expect(await getOpenClassByCode("k7q-m2p", database)).toEqual({ testId: "abcd2345xy", name: "5B CSPE" });
    expect(calls[0].values).toEqual(["K7QM2P"]); expect(calls[0].sql).toContain("c.is_open");
    expect(await getOpenClassByCode("nope", database)).toBeNull();
    expect(await getOpenClassByCode("K7QM2P", fakeDatabase([[]]).database)).toBeNull();
    expect(await getOpenClassByCode("K7QM2P", fakeDatabase([[{ name: "x", shared_test_id: null }]]).database)).toBeNull();
    expect(await getOpenClassTest("K7QM2P", fakeDatabase([[{ test }]]).database)).toEqual({ test });
  });
});

describe("submitClassResult", () => {
  const ok = { displayName: "  Aoife   <b>K</b> ", score: 4, maxScore: 5, questionMarks: [1, 0, 3] };
  const classRow = { id: "c1", is_open: true, max_score: 5, question_maxes: [1, 1, 3] };
  it("stores a consistent result with a cleaned name and no answers by default", async () => {
    const { database, calls } = fakeDatabase([[classRow], [{ count: 3 }], [{ id: "r1" }]]);
    expect(await submitClassResult("k7q-m2p", ok, database)).toEqual({ id: "r1" });
    expect(calls[0].sql).toContain("FOR UPDATE");
    const insert = calls[2];
    expect(insert.sql).toContain("INSERT INTO study_class_results");
    expect(insert.values).toEqual(["c1", "Aoife b K /b", 4, 5, { json: [1, 0, 3] }, null]);
    expect(insert.sql).not.toMatch(/ip|user_agent/i);
  });
  it("stores answers only when supplied", async () => {
    const { database, calls } = fakeDatabase([[classRow], [{ count: 0 }], [{ id: "r1" }]]);
    await submitClassResult("K7QM2P", { ...ok, answers: [{ choice: 1 }] }, database);
    expect(calls[2].values.at(-1)).toEqual({ json: [{ choice: 1 }] });
  });
  it("falls back to Anonymous for a blank name", async () => {
    const { database, calls } = fakeDatabase([[classRow], [{ count: 0 }], [{ id: "r1" }]]);
    await submitClassResult("K7QM2P", { ...ok, displayName: "  " }, database);
    expect(calls[2].values[1]).toBe("Anonymous");
  });
  it.each([
    ["score that is not the sum of marks", { score: 5 }],
    ["mark above a question's maximum", { questionMarks: [2, 0, 2], score: 4 }],
    ["wrong number of questions", { questionMarks: [1, 3], score: 4 }],
    ["wrong total", { maxScore: 9 }],
    ["fractional mark", { questionMarks: [0.5, 0.5, 3], score: 4 }],
    ["negative mark", { questionMarks: [-1, 2, 3], score: 4 }],
  ])("rejects a %s", async (_label, change) => {
    await expect(submitClassResult("K7QM2P", { ...ok, ...change }, fakeDatabase([[classRow]]).database)).rejects.toMatchObject({ status: 400, code: "INVALID_RESULT" });
  });
  it("refuses closed, missing and full classes and oversize answers", async () => {
    await expect(submitClassResult("K7QM2P", ok, fakeDatabase([[{ ...classRow, is_open: false }]]).database)).rejects.toMatchObject({ status: 409, code: "CLASS_CLOSED" });
    await expect(submitClassResult("K7QM2P", ok, fakeDatabase([[]]).database)).rejects.toMatchObject({ status: 404 });
    await expect(submitClassResult("bad", ok, fakeDatabase([]).database)).rejects.toMatchObject({ status: 404 });
    await expect(submitClassResult("K7QM2P", ok, fakeDatabase([[classRow], [{ count: MAX_RESULTS_PER_CLASS }]]).database)).rejects.toMatchObject({ code: "RESULT_LIMIT" });
    await expect(submitClassResult("K7QM2P", { ...ok, answers: ["x".repeat(70_000)] }, fakeDatabase([]).database)).rejects.toMatchObject({ status: 413 });
  });
});

describe("purgeExpiredClassData", () => {
  it("deletes old results and expired classes", async () => {
    const { database, calls } = fakeDatabase([[{ id: "r1" }, { id: "r2" }], [{ id: "c1" }]]);
    expect(await purgeExpiredClassData(database)).toEqual({ classes: 1, results: 2 });
    expect(calls[0].sql).toContain("submitted_at < now()"); expect(calls[1].sql).toContain("expires_at < now()");
  });
});
