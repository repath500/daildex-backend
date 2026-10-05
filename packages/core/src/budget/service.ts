import { createHash } from "node:crypto";
import { getDatabase, type Database } from "@daildex/db";
import { AppError } from "@daildex/shared";
import {
  budgetLiveFingerprint,
  type BudgetLiveEvidence,
  type BudgetLiveKind,
  type BudgetLiveSource,
  type BudgetLiveUpdate,
} from "@daildex/shared/budget-live";
import { getTokenPepper } from "../config";

type UpdateRow = {
  id: string;
  kind: BudgetLiveKind;
  headline: string;
  body: string;
  sources: BudgetLiveSource[];
  evidence: BudgetLiveEvidence[];
  origin: "worker" | "editor";
  status: "pending" | "published" | "rejected";
  pinned: boolean;
  model: string | null;
  created_at: Date;
  published_at: Date | null;
  reviewed_by: string | null;
};

function toPublic(row: UpdateRow): BudgetLiveUpdate {
  return {
    id: row.id,
    kind: row.kind,
    headline: row.headline,
    body: row.body,
    sources: row.sources,
    pinned: row.pinned,
    origin: row.origin,
    publishedAt: (row.published_at ?? row.created_at).toISOString(),
  };
}

/** Published updates, pinned first, then newest first. */
export async function listPublishedBudgetUpdates(budget: string, limit = 80, database: Database = getDatabase()): Promise<BudgetLiveUpdate[]> {
  const rows = await database<UpdateRow[]>`
    SELECT id, kind, headline, body, sources, evidence, origin, status, pinned, model, created_at, published_at, reviewed_by
    FROM budget_live_updates
    WHERE budget = ${budget} AND status = 'published'
    ORDER BY pinned DESC, published_at DESC
    LIMIT ${Math.max(1, Math.min(limit, 200))}
  `;
  return rows.map(toPublic);
}

/** Headlines and source URLs already used, so the worker doesn't repeat itself. */
export async function getBudgetLiveMemory(budget: string, database: Database = getDatabase()) {
  const rows = await database<{ headline: string; sources: BudgetLiveSource[] }[]>`
    SELECT headline, sources FROM budget_live_updates
    WHERE budget = ${budget} AND status IN ('pending', 'published')
    ORDER BY created_at DESC
    LIMIT 150
  `;
  return {
    headlines: rows.map((row) => row.headline),
    sourceUrls: [...new Set(rows.flatMap((row) => row.sources.map((source) => source.url)))],
  };
}

export type NewBudgetUpdate = {
  budget: string;
  kind: BudgetLiveKind;
  headline: string;
  body: string;
  sources: BudgetLiveSource[];
  evidence: BudgetLiveEvidence[];
  origin: "worker" | "editor";
  publish: boolean;
  model?: string | null;
  actor?: string | null;
};

/** Stores an update. Returns null when an update with the same headline already exists. */
export async function createBudgetUpdate(input: NewBudgetUpdate, database: Database = getDatabase()): Promise<string | null> {
  const headline = input.headline.trim().slice(0, 180);
  const body = input.body.trim().slice(0, 2000);
  if (headline.length < 8 || body.length < 20) throw new AppError("INVALID_REQUEST", "The headline or text is too short.", 400);
  const status = input.publish ? "published" : "pending";
  const rows = await database<{ id: string }[]>`
    INSERT INTO budget_live_updates
      (budget, kind, headline, body, sources, evidence, origin, status, fingerprint, model, published_at, reviewed_by, reviewed_at)
    VALUES (
      ${input.budget}, ${input.kind}, ${headline}, ${body},
      ${database.json(input.sources as never)}, ${database.json(input.evidence as never)},
      ${input.origin}, ${status}, ${budgetLiveFingerprint(headline)}, ${input.model ?? null},
      ${input.publish ? new Date() : null}, ${input.publish ? (input.actor ?? input.origin) : null}, ${input.publish ? new Date() : null}
    )
    ON CONFLICT (budget, fingerprint) DO NOTHING
    RETURNING id
  `;
  return rows[0]?.id ?? null;
}

export type BudgetUpdateForReview = BudgetLiveUpdate & {
  status: UpdateRow["status"];
  evidence: BudgetLiveEvidence[];
  model: string | null;
  createdAt: string;
  reviewedBy: string | null;
};

export async function listBudgetUpdatesForReview(budget: string, database: Database = getDatabase()): Promise<BudgetUpdateForReview[]> {
  const rows = await database<UpdateRow[]>`
    SELECT id, kind, headline, body, sources, evidence, origin, status, pinned, model, created_at, published_at, reviewed_by
    FROM budget_live_updates
    WHERE budget = ${budget} AND (status = 'pending' OR created_at > now() - interval '3 days')
    ORDER BY (status = 'pending') DESC, created_at DESC
    LIMIT 60
  `;
  return rows.map((row) => ({
    ...toPublic(row),
    status: row.status,
    evidence: row.evidence,
    model: row.model,
    createdAt: row.created_at.toISOString(),
    reviewedBy: row.reviewed_by,
  }));
}

export type BudgetReviewDecision = "publish" | "reject" | "pin" | "unpin";

export async function reviewBudgetUpdate(id: string, decision: BudgetReviewDecision, actor: string, database: Database = getDatabase()) {
  const reviewer = actor.slice(0, 200);
  const rows = decision === "publish"
    ? await database`
        UPDATE budget_live_updates SET status = 'published', published_at = coalesce(published_at, now()),
          reviewed_by = ${reviewer}, reviewed_at = now()
        WHERE id = ${id} RETURNING id`
    : decision === "reject"
      ? await database`
          UPDATE budget_live_updates SET status = 'rejected', pinned = false, reviewed_by = ${reviewer}, reviewed_at = now()
          WHERE id = ${id} RETURNING id`
      : await database`
          UPDATE budget_live_updates SET pinned = ${decision === "pin"}, reviewed_by = ${reviewer}, reviewed_at = now()
          WHERE id = ${id} AND status = 'published' RETURNING id`;
  if (!rows.length) throw new AppError("NOT_FOUND", "Budget update not found.", 404);
}

/** Browser ids are stored only as a peppered hash. */
export function budgetVoterKey(browserId: string): string {
  return createHash("sha256").update(`${getTokenPepper()}:budget-poll:${browserId}`, "utf8").digest("hex");
}

/** One vote per browser per poll; voting again changes the answer. */
export async function recordBudgetPollVote(poll: string, voterKey: string, option: string, database: Database = getDatabase()) {
  await database`
    INSERT INTO budget_poll_votes (poll, voter_key, option)
    VALUES (${poll}, ${voterKey}, ${option})
    ON CONFLICT (poll, voter_key) DO UPDATE SET option = excluded.option, created_at = now()
  `;
}

export async function getBudgetPollResults(poll: string, voterKey: string | null, database: Database = getDatabase()) {
  const [counts, mine] = await Promise.all([
    database<{ option: string; votes: number }[]>`
      SELECT option, count(*)::INTEGER AS votes FROM budget_poll_votes WHERE poll = ${poll} GROUP BY option
    `,
    voterKey
      ? database<{ option: string }[]>`SELECT option FROM budget_poll_votes WHERE poll = ${poll} AND voter_key = ${voterKey}`
      : Promise.resolve([] as { option: string }[]),
  ]);
  return {
    counts: Object.fromEntries(counts.map((row) => [row.option, row.votes])) as Record<string, number>,
    total: counts.reduce((sum, row) => sum + row.votes, 0),
    mine: mine[0]?.option ?? null,
  };
}

/** Results for several polls at once, for the prediction cards. */
export async function getBudgetPollResultsMany(polls: string[], voterKey: string | null, database: Database = getDatabase()) {
  const ids = [...new Set(polls)].slice(0, 60);
  if (!ids.length) return {};
  const [counts, mine] = await Promise.all([
    database<{ poll: string; option: string; votes: number }[]>`
      SELECT poll, option, count(*)::INTEGER AS votes FROM budget_poll_votes
      WHERE poll = ANY(${ids}) GROUP BY poll, option
    `,
    voterKey
      ? database<{ poll: string; option: string }[]>`
          SELECT poll, option FROM budget_poll_votes WHERE poll = ANY(${ids}) AND voter_key = ${voterKey}
        `
      : Promise.resolve([] as { poll: string; option: string }[]),
  ]);
  const results: Record<string, { counts: Record<string, number>; total: number; mine: string | null }> = {};
  for (const id of ids) results[id] = { counts: {}, total: 0, mine: null };
  for (const row of counts) {
    results[row.poll].counts[row.option] = row.votes;
    results[row.poll].total += row.votes;
  }
  for (const row of mine) results[row.poll].mine = row.option;
  return results;
}
