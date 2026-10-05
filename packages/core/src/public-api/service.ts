import { getDatabase, type Database } from "@daildex/db";
import { z } from "zod";
import { toPublicOireachtasUrl } from "../official-data/urls";
import {
  buildMeta,
  checkDateRange,
  checkPaging,
  dateRange,
  decodeCursor,
  encodeCursor,
  likePattern,
  paging,
  parseStrict,
  type Cursor,
  type PublicMeta,
} from "./query";
import { VOTE_DATE_SQL, VOTE_DEBATE_SQL, VOTE_TITLE_SQL } from "./vote-sql";

export { PublicApiValidationError, API_LICENCE, type PublicMeta } from "./query";

const sourceTypeSchema = z.enum(["vote", "question", "speech", "legislation"]);
const chamberSchema = z.enum(["Dáil", "Seanad"]);

export const listShape = {
  q: z.string().trim().min(1).max(200).optional(),
  representative: z.string().trim().min(1).max(160).optional(),
  chamber: chamberSchema.optional(),
  ...dateRange,
  ...paging,
};

/** Bills are not tied to a member or a chamber filter, so those parameters are not accepted. */
export const legislationShape = {
  q: listShape.q,
  ...dateRange,
  ...paging,
};

export const activityShape = { ...listShape, type: sourceTypeSchema.optional() };

export type PublicListQuery = z.infer<z.ZodObject<typeof listShape>>;
export type PublicActivityQuery = z.infer<z.ZodObject<typeof activityShape>>;
type FeedQuery = Omit<PublicListQuery, "representative" | "chamber"> & Partial<Pick<PublicListQuery, "representative" | "chamber">>;
export type PublicSourceType = z.infer<typeof sourceTypeSchema>;

type RepresentativeSummary = {
  id: string;
  name: string;
  area: string;
  party: string;
  chamber: "Dáil" | "Seanad";
  role: "TD" | "Senator";
};

export type PublicActivityItem = {
  /** Unique per row. For votes this is `<divisionId>:<representativeId>`. */
  id: string;
  type: "vote" | "question" | "speech" | "legislation";
  date: string | null;
  title: string;
  summary: string | null;
  sourceUrl: string;
  representative: RepresentativeSummary | null;
  participation: string | null;
  /** Votes only: the division this member's vote belongs to (see /v1/divisions/:id). */
  divisionId: string | null;
};

export type PublicFeed<Key extends string> = { [K in Key]: PublicActivityItem[] } & {
  limit: number;
  offset: number;
  next_cursor: string | null;
  has_more: boolean;
  meta: PublicMeta;
};

export function parsePublicListQuery(query: Record<string, string | undefined>): PublicListQuery {
  return parseStrict(listShape, query, (value) => [...checkDateRange(value), ...checkPaging(value)]);
}

export function parsePublicLegislationQuery(query: Record<string, string | undefined>): PublicListQuery {
  return parseStrict(legislationShape, query, (value) => [...checkDateRange(value), ...checkPaging(value)]);
}

export function parsePublicActivityQuery(query: Record<string, string | undefined>): PublicActivityQuery {
  return parseStrict(activityShape, query, (value) => [...checkDateRange(value), ...checkPaging(value)]);
}

type FeedRow = PublicActivityItem & { sort_date: string; source_alt: string | null };

export async function listPublicActivity(
  query: PublicActivityQuery,
  database: Database = getDatabase(),
): Promise<PublicFeed<"items">> {
  const types: PublicSourceType[] = query.type ? [query.type] : ["vote", "question", "speech", "legislation"];
  const page = await runFeed(database, types, query);
  return { items: page.items, ...pageFields(query, page.nextCursor, page.items.length) };
}

export async function listPublicVotes(
  query: PublicListQuery,
  database: Database = getDatabase(),
): Promise<PublicFeed<"votes">> {
  const page = await runFeed(database, ["vote"], query);
  return { votes: page.items, ...pageFields(query, page.nextCursor, page.items.length) };
}

export async function listPublicQuestions(
  query: PublicListQuery,
  database: Database = getDatabase(),
): Promise<PublicFeed<"questions">> {
  const page = await runFeed(database, ["question"], query);
  return { questions: page.items, ...pageFields(query, page.nextCursor, page.items.length) };
}

export async function listPublicSpeeches(
  query: PublicListQuery,
  database: Database = getDatabase(),
): Promise<PublicFeed<"speeches">> {
  const page = await runFeed(database, ["speech"], query);
  const speeches = await withSpeechSectionTitles(database, page.items);
  return { speeches, ...pageFields(query, page.nextCursor, speeches.length) };
}

export async function listPublicLegislation(
  query: PublicListQuery,
  database: Database = getDatabase(),
): Promise<PublicFeed<"legislation">> {
  const page = await runFeed(database, ["legislation"], query);
  return { legislation: page.items, ...pageFields(query, page.nextCursor, page.items.length) };
}

function pageFields(query: { limit: number; offset: number }, nextCursor: string | null, count: number) {
  return {
    limit: query.limit,
    offset: query.offset,
    next_cursor: nextCursor,
    has_more: nextCursor !== null,
    meta: buildMeta(count, query.limit, nextCursor),
  };
}

async function runFeed(
  database: Database,
  types: PublicSourceType[],
  query: FeedQuery,
): Promise<{ items: PublicActivityItem[]; nextCursor: string | null }> {
  const cursor = decodeCursor(query.cursor);
  const fetchCount = query.limit + 1;
  // Each source returns at most what the page can need, so the union never sorts whole tables.
  const perSource = query.offset + fetchCount;

  const parts = types.map((type) => {
    const branch = type === "vote" ? voteActivitySql(database, query)
      : type === "question" ? questionActivitySql(database, query)
      : type === "speech" ? speechActivitySql(database, query)
      : legislationActivitySql(database, query);
    return database`(
      SELECT * FROM (${branch}) branch
      WHERE ${cursorPredicate(database, cursor)}
      ORDER BY branch.sort_date DESC, branch.id DESC
      LIMIT ${perSource}
    )`;
  });
  let union = parts[0]!;
  for (const part of parts.slice(1)) union = database`${union} UNION ALL ${part}`;

  const rows = await database<FeedRow[]>`
    SELECT * FROM (${union}) activity
    ORDER BY sort_date DESC, id DESC
    LIMIT ${fetchCount}
    OFFSET ${query.offset}
  `;
  const hasMore = rows.length > query.limit;
  const pageRows = rows.slice(0, query.limit);
  const last = pageRows.at(-1);
  const items = pageRows.map(toPublicItem);
  return {
    items,
    nextCursor: hasMore && last ? encodeCursor({ k: last.sort_date, i: last.id }) : null,
  };
}

function cursorPredicate(database: Database, cursor: Cursor | null) {
  if (!cursor) return database`TRUE`;
  return database`(branch.sort_date, branch.id) < (${cursor.k}::TEXT, ${cursor.i}::TEXT)`;
}

function toPublicItem(row: FeedRow): PublicActivityItem {
  return {
    id: row.id,
    type: row.type,
    date: row.date,
    title: row.title,
    summary: row.summary,
    sourceUrl: toPublicOireachtasUrl(row.source_alt) ?? toPublicOireachtasUrl(row.sourceUrl) ?? row.sourceUrl,
    representative: row.representative,
    participation: row.participation,
    divisionId: row.divisionId,
  };
}

/** The debate section heading is a separate lookup so list queries stay cheap. */
async function withSpeechSectionTitles(database: Database, items: PublicActivityItem[]): Promise<PublicActivityItem[]> {
  if (items.length === 0) return items;
  const rows = await database<{ id: string; heading: string | null }[]>`
    SELECT contribution.id::TEXT AS id, section.heading
    FROM official_contributions contribution
    LEFT JOIN LATERAL (
      SELECT event.raw_payload #>> '{section,title}' AS heading
      FROM raw_events event
      WHERE event.source_type = 'oireachtas_debate'
        AND event.source_url = split_part(contribution.source_uri, '#text-', 1)
      LIMIT 1
    ) section ON TRUE
    WHERE contribution.id = ANY(${items.map((item) => item.id)}::UUID[])
  `;
  const headings = new Map(rows.map((row) => [row.id, row.heading]));
  return items.map((item) => {
    const heading = headings.get(item.id)?.trim();
    return heading ? { ...item, title: heading } : item;
  });
}

export type RepresentativeRecordSummary = {
  /** Dáil divisions DáilDex holds since `since`. */
  divisions: number;
  votedIn: number;
  ta: number;
  nil: number;
  staon: number;
  questions: number;
  /** Earliest division date held, as YYYY-MM-DD, or null when none are held. */
  since: string | null;
};

/** Counts one representative's recorded votes and questions across the ingested window. */
export async function summarizeRepresentativeRecord(
  representativeKey: string,
  database: Database = getDatabase(),
  /** Limit to records dated in the last N days; omit for the whole ingested window. */
  days?: number,
): Promise<RepresentativeRecordSummary> {
  const [row] = await database<RepresentativeRecordSummary[]>`
    WITH member AS (
      SELECT id FROM representatives WHERE representative_key = ${representativeKey}
    ),
    divisions AS (
      SELECT id, coalesce(raw_payload #>> '{division,date}', fetched_at::DATE::TEXT) AS date
      FROM raw_events
      WHERE source_type = 'oireachtas_vote'
        AND (${days ?? null}::INT IS NULL
          OR coalesce(raw_payload #>> '{division,date}', fetched_at::DATE::TEXT)::DATE > current_date - ${days ?? null}::INT)
    ),
    votes AS (
      SELECT target.participation
      FROM raw_event_targets target
      JOIN divisions ON divisions.id = target.raw_event_id
      WHERE target.representative_id = (SELECT id FROM member)
    )
    SELECT
      (SELECT count(*)::INT FROM divisions) AS divisions,
      (SELECT count(*)::INT FROM votes) AS "votedIn",
      (SELECT count(*)::INT FROM votes WHERE participation = 'Tá') AS ta,
      (SELECT count(*)::INT FROM votes WHERE participation = 'Níl') AS nil,
      (SELECT count(*)::INT FROM votes WHERE participation = 'Staon') AS staon,
      (
        SELECT count(*)::INT
        FROM raw_event_targets target
        JOIN raw_events raw ON raw.id = target.raw_event_id
        WHERE raw.source_type = 'oireachtas_question'
          AND target.representative_id = (SELECT id FROM member)
          AND (${days ?? null}::INT IS NULL
            OR coalesce(raw.raw_payload #>> '{question,date}', raw.fetched_at::DATE::TEXT)::DATE > current_date - ${days ?? null}::INT)
      ) AS questions,
      (SELECT min(date) FROM divisions) AS since
  `;
  return row ?? { divisions: 0, votedIn: 0, ta: 0, nil: 0, staon: 0, questions: 0, since: null };
}

const REPRESENTATIVE_JSON = `jsonb_build_object(
        'id', representative.representative_key,
        'name', representative.name,
        'area', representative.area,
        'party', representative.party_name,
        'chamber', representative.chamber,
        'role', representative.role
      )`;

function voteActivitySql(database: Database, query: FeedQuery) {
  return database`
    SELECT
      raw.id::TEXT || ':' || representative.representative_key AS id,
      'vote' AS type,
      ${database.unsafe(VOTE_DATE_SQL)} AS date,
      ${database.unsafe(VOTE_DATE_SQL)} AS sort_date,
      ${database.unsafe(VOTE_TITLE_SQL)} AS title,
      nullif(concat_ws(' · ', raw.raw_payload #>> '{division,outcome}', ${database.unsafe(VOTE_DEBATE_SQL)}), '') AS summary,
      raw.source_url AS "sourceUrl",
      raw.raw_payload #>> '{division,uri}' AS source_alt,
      ${database.unsafe(REPRESENTATIVE_JSON)} AS representative,
      target.participation,
      raw.id::TEXT AS "divisionId"
    FROM raw_events raw
    JOIN raw_event_targets target ON target.raw_event_id = raw.id
    JOIN representatives representative ON representative.id = target.representative_id
    WHERE raw.source_type = 'oireachtas_vote'
      ${commonFilters(database, query, VOTE_DATE_SQL, database`lower(coalesce(raw.raw_text, '')) LIKE ${likePattern(query.q)}`)}
  `;
}

function questionActivitySql(database: Database, query: FeedQuery) {
  return database`
    SELECT
      contribution.id::TEXT AS id,
      'question' AS type,
      document.document_date::TEXT AS date,
      document.document_date::TEXT AS sort_date,
      document.title,
      left(contribution.text, 500) AS summary,
      document.canonical_url AS "sourceUrl",
      contribution.source_uri AS source_alt,
      ${database.unsafe(REPRESENTATIVE_JSON)} AS representative,
      'asked' AS participation,
      NULL::TEXT AS "divisionId"
    FROM official_contributions contribution
    JOIN official_document_versions version ON version.id = contribution.official_document_version_id
    JOIN official_documents document ON document.id = version.official_document_id
    JOIN representatives representative ON representative.id = contribution.representative_id
    WHERE contribution.contribution_type = 'question'
      ${commonFilters(database, query, "document.document_date", textSearch(database, query))}
  `;
}

function speechActivitySql(database: Database, query: FeedQuery) {
  return database`
    SELECT
      contribution.id::TEXT AS id,
      'speech' AS type,
      document.document_date::TEXT AS date,
      document.document_date::TEXT AS sort_date,
      document.title,
      left(contribution.text, 500) AS summary,
      coalesce(contribution.source_uri, document.canonical_url) AS "sourceUrl",
      contribution.source_uri AS source_alt,
      ${database.unsafe(REPRESENTATIVE_JSON)} AS representative,
      'spoke' AS participation,
      NULL::TEXT AS "divisionId"
    FROM official_contributions contribution
    JOIN official_document_versions version ON version.id = contribution.official_document_version_id
    JOIN official_documents document ON document.id = version.official_document_id
    JOIN representatives representative ON representative.id = contribution.representative_id
    WHERE contribution.contribution_type = 'speech'
      ${commonFilters(database, query, "document.document_date", textSearch(database, query))}
  `;
}

function legislationActivitySql(database: Database, query: FeedQuery) {
  return database`
    SELECT
      document.id::TEXT AS id,
      'legislation' AS type,
      document.current_stage_date::TEXT AS date,
      coalesce(document.current_stage_date::TEXT, '') AS sort_date,
      document.title,
      nullif(concat_ws(' · ', document.status, document.current_stage), '') AS summary,
      document.source_uri AS "sourceUrl",
      document.source_uri AS source_alt,
      NULL::JSONB AS representative,
      NULL::TEXT AS participation,
      NULL::TEXT AS "divisionId"
    FROM legislation_documents document
    WHERE ${query.representative ? database`FALSE` : database`TRUE`}
      AND ${query.chamber ? database`FALSE` : database`TRUE`}
      AND (${query.date_start ?? null}::DATE IS NULL OR document.current_stage_date >= ${query.date_start ?? null}::DATE)
      AND (${query.date_end ?? null}::DATE IS NULL OR document.current_stage_date <= ${query.date_end ?? null}::DATE)
      AND (${query.q ?? ""} = '' OR lower(document.title || ' ' || document.long_title || ' ' || coalesce(document.current_stage, '')) LIKE ${likePattern(query.q)})
  `;
}

/** Match the question or speech text, or its document title; both columns have trigram indexes. */
function textSearch(database: Database, query: FeedQuery) {
  const pattern = likePattern(query.q);
  return database`(lower(contribution.text) LIKE ${pattern} OR lower(document.title) LIKE ${pattern})`;
}

function commonFilters(
  database: Database,
  query: FeedQuery,
  dateExpression: string,
  search: ReturnType<Database["unsafe"]> | ReturnType<Database>,
) {
  return database`
    AND (${query.representative ?? ""} = '' OR representative.representative_key = ${query.representative ?? ""})
    AND (${query.chamber ?? ""} = '' OR representative.chamber = ${query.chamber ?? ""})
    AND (${query.date_start ?? null}::DATE IS NULL OR ${database.unsafe(dateExpression)}::DATE >= ${query.date_start ?? null}::DATE)
    AND (${query.date_end ?? null}::DATE IS NULL OR ${database.unsafe(dateExpression)}::DATE <= ${query.date_end ?? null}::DATE)
    AND (${query.q ?? ""} = '' OR ${search})
  `;
}

export * from "./divisions";
export * from "./resources";
