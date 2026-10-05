import { createHash, randomBytes } from "node:crypto";
import type { Database, JsonValue } from "@daildex/db";
import { getDatabase } from "@daildex/db";
import { ensureAccountProfileId, type AccountLogin } from "../chat/service";

/** Results (and the class that holds them) are deleted this long after they were collected. */
export const CLASS_RETENTION_DAYS = 120;
export const MAX_CLASSES_PER_ACCOUNT = 30;
export const MAX_RESULTS_PER_CLASS = 1000;
export const MAX_NAME_CHARS = 40;
const MAX_ANSWERS_JSON_CHARS = 60_000;
/** No I, L, O, 0 or 1: a code read aloud or copied from a board is hard to get wrong. Matches the CHECK in migration 0027. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const SHARE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

export class ClassError extends Error {
  constructor(message: string, readonly status: number, readonly code: "NOT_FOUND" | "CLASS_LIMIT" | "CLASS_CLOSED" | "RESULT_LIMIT" | "INVALID_RESULT" | "TEST_UNAVAILABLE") {
    super(message);
  }
}

/* ---------- Codes ---------- */

function randomFrom(alphabet: string, length: number) {
  // Rejection sampling keeps every character equally likely (256 is not a multiple of 31).
  const limit = 256 - (256 % alphabet.length);
  let out = "";
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) if (byte < limit && out.length < length) out += alphabet[byte % alphabet.length];
  }
  return out;
}
export const newClassCode = () => randomFrom(CODE_ALPHABET, 6);
export const formatClassCode = (code: string) => `${code.slice(0, 3)}-${code.slice(3)}`;
/** Accepts "k7q-m2p", " K7Q M2P " etc. Returns the stored form, or null when it can't be a code. */
export function normalizeClassCode(input: string): string | null {
  const code = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return code.length === 6 && [...code].every((char) => CODE_ALPHABET.includes(char)) ? code : null;
}

/* ---------- Types ---------- */

export type ClassSummary = {
  id: string; name: string; code: string; sharedTestId: string | null; testTitle: string; questionCount: number;
  maxScore: number; open: boolean; createdAt: string; expiresAt: string; resultCount: number;
};
export type ClassResult = { id: string; displayName: string; score: number; maxScore: number; questionMarks: number[]; answers: JsonValue | null; submittedAt: string };
export type QuestionAggregate = { index: number; prompt: string; topic: string; max: number; averagePercent: number; fullCreditPercent: number };
export type ClassAggregates = {
  count: number; averagePercent: number | null; medianPercent: number | null;
  /** Student counts per band: under 40, 40-54, 55-69, 70-84, 85+ (the same bands students see). */
  distribution: { label: string; min: number; count: number }[];
  questions: QuestionAggregate[];
  /** The (up to) five hardest questions, lowest average first. */
  mostMissed: QuestionAggregate[];
};
/** Just enough of the pinned paper for a teacher to read per-question results and shared answers. */
export type ClassPaper = { title: string; questions: { prompt: string; type: string; topic: string; options?: string[] }[] };
export type ClassDetail = { summary: ClassSummary; aggregates: ClassAggregates; results: ClassResult[]; paper: ClassPaper };

type ClassRow = {
  id: string; name: string; code: string; shared_test_id: string | null; test: unknown; max_score: number; question_maxes: unknown;
  is_open: boolean; created_at: Date; expires_at: Date; result_count?: number;
};
const testTitle = (test: unknown) => (test && typeof test === "object" && typeof (test as { title?: unknown }).title === "string" ? (test as { title: string }).title : "Practice test");
const testQuestions = (test: unknown): { prompt?: unknown; topic?: unknown; type?: unknown; options?: unknown }[] => {
  const questions = test && typeof test === "object" ? (test as { questions?: unknown }).questions : null;
  return Array.isArray(questions) ? questions : [];
};
const numbers = (value: unknown): number[] => (Array.isArray(value) ? value.map((item) => (typeof item === "number" ? item : 0)) : []);

function summary(row: ClassRow): ClassSummary {
  return {
    id: row.id, name: row.name, code: row.code, sharedTestId: row.shared_test_id, testTitle: testTitle(row.test),
    questionCount: testQuestions(row.test).length, maxScore: row.max_score, open: row.is_open,
    createdAt: row.created_at.toISOString(), expiresAt: row.expires_at.toISOString(), resultCount: row.result_count ?? 0,
  };
}


/* ---------- Shared tests ---------- */

/** A teacher's own unexpired share links (the paper only), newest first. */
export async function listSharedTests(login: AccountLogin, database: Database = getDatabase()) {
  const profileId = await ensureAccountProfileId(login, database);
  const rows = await database<{ id: string; title: string; created_at: Date; expires_at: Date }[]>`
    SELECT id, title, created_at, expires_at FROM shared_tests
    WHERE profile_id = ${profileId} AND expires_at > now() ORDER BY created_at DESC LIMIT 50
  `;
  return rows.map((row) => ({ id: row.id, title: row.title, createdAt: row.created_at.toISOString(), expiresAt: row.expires_at.toISOString() }));
}

/** Read a share link's paper without counting a view. Any unexpired link works: a link is already public. */
export async function readSharedTestPaper(id: string, database: Database = getDatabase()): Promise<{ id: string; title: string; test: unknown } | null> {
  if (!/^[a-z0-9]{8,16}$/.test(id)) return null;
  const rows = await database<{ id: string; title: string; test: unknown }[]>`SELECT id, title, test FROM shared_tests WHERE id = ${id} AND expires_at > now()`;
  return rows[0] ?? null;
}

/* ---------- Teacher ---------- */

export type CreateClassInput = {
  name: string;
  /** The validated paper (route-parsed with studentTestInputSchema); stored as a snapshot. */
  test: { title: string } & Record<string, unknown>;
  /** Marks available per question (questionMarks() in src/lib/chat/student-test.ts). */
  questionMaxes: number[];
  /** Existing share link to reuse; omit to publish the paper under this account. */
  sharedTestId?: string;
};

export async function createClass(login: AccountLogin, input: CreateClassInput, database: Database = getDatabase()): Promise<ClassSummary> {
  const name = input.name.replace(/\s+/g, " ").trim().slice(0, 80);
  const maxScore = input.questionMaxes.reduce((sum, value) => sum + value, 0);
  if (!name) throw new ClassError("Give the class a name.", 400, "INVALID_RESULT");
  if (!input.questionMaxes.length || maxScore <= 0 || input.questionMaxes.some((value) => !Number.isInteger(value) || value < 0)) throw new ClassError("That test has no marks to score.", 400, "TEST_UNAVAILABLE");
  const profileId = await ensureAccountProfileId(login, database);
  const json = JSON.stringify(input.test);

  return database.begin(async (transaction) => {
    await transaction`SELECT pg_advisory_xact_lock(hashtext(${`classes:${profileId}`}))`;
    const count = await transaction<{ count: number }[]>`SELECT count(*)::INTEGER AS count FROM study_classes WHERE profile_id = ${profileId} AND expires_at > now()`;
    if ((count[0]?.count ?? 0) >= MAX_CLASSES_PER_ACCOUNT) throw new ClassError(`You can keep up to ${MAX_CLASSES_PER_ACCOUNT} classes. Delete one to make room.`, 409, "CLASS_LIMIT");

    let sharedTestId = input.sharedTestId ?? null;
    if (sharedTestId) {
      const found = await transaction<{ id: string }[]>`SELECT id FROM shared_tests WHERE id = ${sharedTestId} AND expires_at > now()`;
      if (!found[0]) throw new ClassError("That test link has expired or does not exist.", 404, "TEST_UNAVAILABLE");
    } else {
      // Publish the paper like createSharedTest does (same hash, so sharing the same paper again reuses one link).
      const contentHash = createHash("sha256").update(json).digest("hex");
      const existing = await transaction<{ id: string }[]>`
        SELECT id FROM shared_tests WHERE profile_id = ${profileId} AND content_hash = ${contentHash} AND expires_at > now()
      `;
      if (existing[0]) sharedTestId = existing[0].id;
      else {
        const id = randomFrom(SHARE_ALPHABET, 10);
        const inserted = await transaction<{ id: string }[]>`
          INSERT INTO shared_tests (id, profile_id, content_hash, title, test)
          VALUES (${id}, ${profileId}, ${contentHash}, ${input.test.title.slice(0, 120)}, ${transaction.json(input.test as never)})
          ON CONFLICT DO NOTHING RETURNING id
        `;
        if (!inserted[0]) throw new ClassError("Could not publish the test. Try again.", 500, "TEST_UNAVAILABLE");
        sharedTestId = id;
      }
    }

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const rows = await transaction<ClassRow[]>`
        INSERT INTO study_classes (profile_id, name, code, shared_test_id, test, question_maxes, max_score)
        VALUES (${profileId}, ${name}, ${newClassCode()}, ${sharedTestId}, ${transaction.json(input.test as never)}, ${transaction.json(input.questionMaxes)}, ${maxScore})
        ON CONFLICT (code) DO NOTHING
        RETURNING id, name, code, shared_test_id, test, max_score, question_maxes, is_open, created_at, expires_at
      `;
      if (rows[0]) return summary(rows[0]);
    }
    throw new ClassError("Could not make a class code. Try again.", 500, "CLASS_LIMIT");
  });
}

export async function listClasses(login: AccountLogin, database: Database = getDatabase()): Promise<ClassSummary[]> {
  const profileId = await ensureAccountProfileId(login, database);
  const rows = await database<ClassRow[]>`
    SELECT c.id, c.name, c.code, c.shared_test_id, c.test, c.max_score, c.question_maxes, c.is_open, c.created_at, c.expires_at,
      (SELECT count(*)::INTEGER FROM study_class_results r
        WHERE r.class_id = c.id AND r.submitted_at > now() - make_interval(days => ${CLASS_RETENTION_DAYS})) AS result_count
    FROM study_classes c
    WHERE c.profile_id = ${profileId} AND c.expires_at > now() ORDER BY c.created_at DESC
  `;
  return rows.map(summary);
}

/** Pure: class-level numbers a teacher reads before any individual score. */
function paperOf(test: unknown): ClassPaper {
  return {
    title: testTitle(test),
    questions: testQuestions(test).map((question, index) => ({
      prompt: typeof question.prompt === "string" ? question.prompt : `Question ${index + 1}`,
      type: typeof question.type === "string" ? question.type : "short",
      topic: typeof question.topic === "string" ? question.topic : "",
      ...(Array.isArray(question.options) ? { options: question.options.filter((option): option is string => typeof option === "string") } : {}),
    })),
  };
}

export function computeAggregates(maxScore: number, questionMaxes: number[], results: Pick<ClassResult, "score" | "questionMarks">[], questions: { prompt?: unknown; topic?: unknown }[] = []): ClassAggregates {
  const percents = results.map((result) => (maxScore ? (result.score / maxScore) * 100 : 0));
  const bands = [{ label: "Under 40%", min: 0 }, { label: "40 to 54%", min: 40 }, { label: "55 to 69%", min: 55 }, { label: "70 to 84%", min: 70 }, { label: "85% and over", min: 85 }];
  const distribution = bands.map((band, index) => ({ ...band, count: percents.filter((value) => Math.round(value) >= band.min && (index === bands.length - 1 || Math.round(value) < bands[index + 1].min)).length }));
  const sorted = [...percents].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length ? (sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2) : null;
  const perQuestion: QuestionAggregate[] = questionMaxes.map((max, index) => {
    const marks = results.map((result) => result.questionMarks[index] ?? 0);
    return {
      index, max, prompt: typeof questions[index]?.prompt === "string" ? (questions[index].prompt as string) : `Question ${index + 1}`,
      topic: typeof questions[index]?.topic === "string" ? (questions[index].topic as string) : "",
      averagePercent: marks.length && max ? Math.round((marks.reduce((sum, mark) => sum + mark, 0) / (marks.length * max)) * 100) : 0,
      fullCreditPercent: marks.length ? Math.round((marks.filter((mark) => mark >= max).length / marks.length) * 100) : 0,
    };
  });
  return {
    count: results.length,
    averagePercent: percents.length ? Math.round(percents.reduce((sum, value) => sum + value, 0) / percents.length) : null,
    medianPercent: median === null ? null : Math.round(median),
    distribution,
    questions: perQuestion,
    mostMissed: results.length ? [...perQuestion].sort((a, b) => a.averagePercent - b.averagePercent || a.index - b.index).slice(0, 5) : [],
  };
}

export async function getClassForTeacher(login: AccountLogin, id: string, database: Database = getDatabase()): Promise<ClassDetail | null> {
  const profileId = await ensureAccountProfileId(login, database);
  const classes = await database<ClassRow[]>`
    SELECT id, name, code, shared_test_id, test, max_score, question_maxes, is_open, created_at, expires_at
    FROM study_classes WHERE id = ${id} AND profile_id = ${profileId} AND expires_at > now()
  `;
  const row = classes[0];
  if (!row) return null;
  const rows = await database<{ id: string; display_name: string; score: number; max_score: number; question_marks: unknown; answers: JsonValue | null; submitted_at: Date }[]>`
    SELECT id, display_name, score, max_score, question_marks, answers, submitted_at FROM study_class_results
    WHERE class_id = ${row.id} AND submitted_at > now() - make_interval(days => ${CLASS_RETENTION_DAYS})
    ORDER BY submitted_at DESC
  `;
  const results: ClassResult[] = rows.map((item) => ({
    id: item.id, displayName: item.display_name, score: item.score, maxScore: item.max_score,
    questionMarks: numbers(item.question_marks), answers: item.answers, submittedAt: item.submitted_at.toISOString(),
  }));
  return {
    summary: { ...summary(row), resultCount: results.length },
    aggregates: computeAggregates(row.max_score, numbers(row.question_maxes), results, testQuestions(row.test)),
    results,
    paper: paperOf(row.test),
  };
}

/** Stop (or reopen) accepting results. Returns false when the class isn't this account's. */
export async function closeClass(login: AccountLogin, id: string, open = false, database: Database = getDatabase()): Promise<boolean> {
  const profileId = await ensureAccountProfileId(login, database);
  const rows = await database<{ id: string }[]>`UPDATE study_classes SET is_open = ${open} WHERE id = ${id} AND profile_id = ${profileId} RETURNING id`;
  return rows.length > 0;
}

export async function deleteClassResults(login: AccountLogin, id: string, database: Database = getDatabase()): Promise<boolean> {
  const profileId = await ensureAccountProfileId(login, database);
  const owned = await database<{ id: string }[]>`SELECT id FROM study_classes WHERE id = ${id} AND profile_id = ${profileId}`;
  if (!owned[0]) return false;
  await database`DELETE FROM study_class_results WHERE class_id = ${id}`;
  return true;
}

export async function deleteClass(login: AccountLogin, id: string, database: Database = getDatabase()): Promise<boolean> {
  const profileId = await ensureAccountProfileId(login, database);
  const rows = await database<{ id: string }[]>`DELETE FROM study_classes WHERE id = ${id} AND profile_id = ${profileId} RETURNING id`;
  return rows.length > 0;
}

/* ---------- Public (students, no account) ---------- */

/** Everything a student's browser may learn from a code: the test link and the class name. Never the teacher or results. */
export async function getOpenClassByCode(code: string, database: Database = getDatabase()): Promise<{ testId: string; name: string } | null> {
  const normal = normalizeClassCode(code);
  if (!normal) return null;
  const rows = await database<{ name: string; shared_test_id: string | null }[]>`
    SELECT c.name, c.shared_test_id FROM study_classes c
    LEFT JOIN shared_tests t ON t.id = c.shared_test_id
    WHERE c.code = ${normal} AND c.is_open AND c.expires_at > now() AND t.expires_at > now()
  `;
  return rows[0]?.shared_test_id ? { testId: rows[0].shared_test_id, name: rows[0].name } : null;
}

/** The pinned paper of an open class, so the route can mark a submission itself rather than trust a client score. */
export async function getOpenClassTest(code: string, database: Database = getDatabase()): Promise<{ test: unknown } | null> {
  const normal = normalizeClassCode(code);
  if (!normal) return null;
  const rows = await database<{ test: unknown }[]>`SELECT test FROM study_classes WHERE code = ${normal} AND is_open AND expires_at > now()`;
  return rows[0] ? { test: rows[0].test } : null;
}

export function cleanDisplayName(input: string) {
  const name = input.replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_NAME_CHARS);
  return name || "Anonymous";
}

export type ClassResultInput = {
  displayName: string; score: number; maxScore: number; questionMarks: number[];
  /** Only when the student ticked "include my written answers". Stored as given (after size limits). */
  answers?: JsonValue | null;
};

/**
 * Store one opted-in result. What is trusted: nothing about the score. The route marks the submitted answers against
 * the pinned paper with markTest; this function re-checks that the numbers are consistent with the class (same
 * question count, each mark within that question's maximum, score = sum of marks, max = the paper's total).
 * Written-question marks are the student's own self-marking, so a determined student can still claim extra marks
 * there; teachers see that as self-reported. Stores no IP address, user agent or identifier.
 */
export async function submitClassResult(code: string, input: ClassResultInput, database: Database = getDatabase()): Promise<{ id: string }> {
  const normal = normalizeClassCode(code);
  const invalid = () => new ClassError("That result does not match this test.", 400, "INVALID_RESULT");
  if (!normal) throw new ClassError("That class code is not open.", 404, "NOT_FOUND");
  const answers = input.answers ?? null;
  if (answers !== null && JSON.stringify(answers).length > MAX_ANSWERS_JSON_CHARS) throw new ClassError("Those answers are too long to send.", 413, "INVALID_RESULT");

  return database.begin(async (transaction) => {
    const classes = await transaction<{ id: string; is_open: boolean; max_score: number; question_maxes: unknown }[]>`
      SELECT id, is_open, max_score, question_maxes FROM study_classes WHERE code = ${normal} AND expires_at > now() FOR UPDATE
    `;
    const row = classes[0];
    if (!row) throw new ClassError("That class code is not open.", 404, "NOT_FOUND");
    if (!row.is_open) throw new ClassError("This class is no longer taking results.", 409, "CLASS_CLOSED");

    const maxes = numbers(row.question_maxes);
    const marks = input.questionMarks;
    const total = marks.reduce((sum, mark) => sum + mark, 0);
    if (
      marks.length !== maxes.length || input.maxScore !== row.max_score ||
      marks.some((mark, index) => !Number.isInteger(mark) || mark < 0 || mark > maxes[index]) ||
      input.score !== total
    ) throw invalid();

    const count = await transaction<{ count: number }[]>`SELECT count(*)::INTEGER AS count FROM study_class_results WHERE class_id = ${row.id}`;
    if ((count[0]?.count ?? 0) >= MAX_RESULTS_PER_CLASS) throw new ClassError("This class has reached its results limit.", 409, "RESULT_LIMIT");

    const inserted = await transaction<{ id: string }[]>`
      INSERT INTO study_class_results (class_id, display_name, score, max_score, question_marks, answers)
      VALUES (${row.id}, ${cleanDisplayName(input.displayName)}, ${input.score}, ${row.max_score}, ${transaction.json(marks)},
        ${answers === null ? null : transaction.json(answers)})
      RETURNING id
    `;
    return { id: inserted[0].id };
  });
}

/** Delete expired classes (their results cascade) and results older than the retention window. Run from a scheduled job. */
export async function purgeExpiredClassData(database: Database = getDatabase()): Promise<{ classes: number; results: number }> {
  const results = await database<{ id: string }[]>`
    DELETE FROM study_class_results WHERE submitted_at < now() - make_interval(days => ${CLASS_RETENTION_DAYS}) RETURNING id
  `;
  const classes = await database<{ id: string }[]>`DELETE FROM study_classes WHERE expires_at < now() RETURNING id`;
  return { classes: classes.length, results: results.length };
}
