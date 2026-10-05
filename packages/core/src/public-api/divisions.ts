import { getDatabase, type Database } from "@daildex/db";
import { AppError } from "@daildex/shared";
import { z } from "zod";
import { toPublicOireachtasUrl } from "../official-data/urls";
import {
  buildMeta,
  checkDateRange,
  dateRange,
  decodeCursor,
  encodeCursor,
  likePattern,
  parseStrict,
  type PublicMeta,
} from "./query";
import { VOTE_DATE_SQL, VOTE_DEBATE_SQL, VOTE_HOUSE_SQL, VOTE_TITLE_SQL } from "./vote-sql";

export type Division = {
  id: string;
  date: string;
  datetime: string | null;
  house: "Dáil" | "Seanad";
  title: string;
  debate: string | null;
  outcome: string | null;
  tallies: { ta: number; nil: number; staon: number };
  tellers: string | null;
  sourceUrl: string;
  debateUrl: string | null;
};

export type DivisionDetail = Division & {
  partyBreakdown: Array<{ party: string; ta: number; nil: number; staon: number }>;
  members?: Array<{
    representative: { id: string; name: string; party: string; area: string };
    vote: string | null;
  }>;
};

export const divisionListShape = {
  q: z.string().trim().min(1).max(200).optional(),
  representative: z.string().trim().min(1).max(160).optional(),
  chamber: z.enum(["Dáil", "Seanad"]).optional(),
  outcome: z.string().trim().min(1).max(40).optional(),
  ...dateRange,
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().trim().min(1).max(300).optional(),
};

export const divisionDetailShape = {
  include: z.enum(["members"]).optional(),
};

export type DivisionListQuery = z.infer<z.ZodObject<typeof divisionListShape>>;

export function parseDivisionListQuery(query: Record<string, string | undefined>): DivisionListQuery {
  return parseStrict(divisionListShape, query, checkDateRange);
}

export function parseDivisionDetailQuery(query: Record<string, string | undefined>) {
  return parseStrict(divisionDetailShape, query);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const tally = (name: string) => `CASE
  WHEN (raw.raw_payload #>> '{division,tallies,${name},tally}') ~ '^[0-9]+$'
    THEN (raw.raw_payload #>> '{division,tallies,${name},tally}')::INT
  WHEN jsonb_typeof(raw.raw_payload #> '{division,tallies,${name},members}') = 'array'
    THEN jsonb_array_length(raw.raw_payload #> '{division,tallies,${name},members}')
  ELSE 0
END`;

/** UTC sortable timestamp; falls back to the division date when no time was recorded. */
const SORT_KEY = `to_char(
  (CASE WHEN (raw.raw_payload #>> '{division,datetime}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
    THEN (raw.raw_payload #>> '{division,datetime}')::TIMESTAMPTZ
    ELSE (${VOTE_DATE_SQL})::DATE::TIMESTAMPTZ END) AT TIME ZONE 'UTC',
  'YYYY-MM-DD"T"HH24:MI:SS.US')`;

export type DivisionRow = {
  id: string;
  date: string;
  datetime: string | null;
  house: "Dáil" | "Seanad";
  title: string;
  debate: string | null;
  outcome: string | null;
  ta: number;
  nil: number;
  staon: number;
  tellers: string | null;
  division_uri: string | null;
  debate_uri: string | null;
  debate_section: string | null;
  source_url: string;
  sort_key: string;
};

export function divisionSelect(database: Database) {
  return database`
    SELECT
      raw.id::TEXT AS id,
      ${database.unsafe(VOTE_DATE_SQL)} AS date,
      raw.raw_payload #>> '{division,datetime}' AS datetime,
      ${database.unsafe(VOTE_HOUSE_SQL)} AS house,
      ${database.unsafe(VOTE_TITLE_SQL)} AS title,
      ${database.unsafe(VOTE_DEBATE_SQL)} AS debate,
      raw.raw_payload #>> '{division,outcome}' AS outcome,
      ${database.unsafe(tally("taVotes"))} AS ta,
      ${database.unsafe(tally("nilVotes"))} AS nil,
      ${database.unsafe(tally("staonVotes"))} AS staon,
      nullif(btrim(raw.raw_payload #>> '{division,tellers}'), '') AS tellers,
      raw.raw_payload #>> '{division,uri}' AS division_uri,
      raw.raw_payload #>> '{division,debate,uri}' AS debate_uri,
      raw.raw_payload #>> '{division,debate,debateSection}' AS debate_section,
      raw.source_url,
      ${database.unsafe(SORT_KEY)} AS sort_key
    FROM raw_events raw
    WHERE raw.source_type = 'oireachtas_vote'
  `;
}

export function toDivision(row: DivisionRow): Division {
  const debateUrl = toPublicOireachtasUrl(row.debate_uri);
  return {
    id: row.id,
    date: row.date,
    datetime: row.datetime,
    house: row.house,
    title: row.title,
    debate: row.debate,
    outcome: row.outcome,
    tallies: { ta: row.ta, nil: row.nil, staon: row.staon },
    tellers: row.tellers,
    sourceUrl: toPublicOireachtasUrl(row.division_uri) ?? debateUrl ?? row.source_url,
    debateUrl: debateUrl
      ? (row.debate_section && !debateUrl.includes("#") ? `${debateUrl}#${row.debate_section}` : debateUrl)
      : null,
  };
}

export async function listDivisions(
  query: DivisionListQuery,
  database: Database = getDatabase(),
): Promise<{ data: Division[]; meta: PublicMeta }> {
  const cursor = decodeCursor(query.cursor);
  const pattern = likePattern(query.q);
  const rows = await database<DivisionRow[]>`
    SELECT * FROM (${divisionSelect(database)}) division
    WHERE (${query.date_start ?? null}::DATE IS NULL OR division.date::DATE >= ${query.date_start ?? null}::DATE)
      AND (${query.date_end ?? null}::DATE IS NULL OR division.date::DATE <= ${query.date_end ?? null}::DATE)
      AND (${query.chamber ?? ""} = '' OR division.house = ${query.chamber ?? ""})
      AND (${query.outcome ?? ""} = '' OR lower(division.outcome) = ${(query.outcome ?? "").toLocaleLowerCase("en-IE")})
      AND (${query.q ?? ""} = '' OR lower(coalesce(division.title, '') || ' ' || coalesce(division.debate, '')) LIKE ${pattern})
      AND (${query.representative ?? ""} = '' OR EXISTS (
        SELECT 1 FROM raw_event_targets target
        JOIN representatives representative ON representative.id = target.representative_id
        WHERE target.raw_event_id = division.id::UUID
          AND representative.representative_key = ${query.representative ?? ""}
      ))
      AND ${cursor ? database`(division.sort_key, division.id) < (${cursor.k}::TEXT, ${cursor.i}::TEXT)` : database`TRUE`}
    ORDER BY division.sort_key DESC, division.id DESC
    LIMIT ${query.limit + 1}
  `;
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  const nextCursor = rows.length > query.limit && last ? encodeCursor({ k: last.sort_key, i: last.id }) : null;
  return { data: page.map(toDivision), meta: buildMeta(page.length, query.limit, nextCursor) };
}

export async function getDivision(
  id: string,
  options: { includeMembers?: boolean } = {},
  database: Database = getDatabase(),
): Promise<{ data: DivisionDetail; meta: PublicMeta }> {
  if (!UUID.test(id)) throw new AppError("NOT_FOUND", "Division not found.", 404);
  const rows = await database<DivisionRow[]>`
    SELECT * FROM (${divisionSelect(database)}) division WHERE division.id = ${id.toLowerCase()}
  `;
  const row = rows[0];
  if (!row) throw new AppError("NOT_FOUND", "Division not found.", 404);

  const breakdown = await database<{ party: string; ta: number; nil: number; staon: number }[]>`
    SELECT representative.party_name AS party,
      count(*) FILTER (WHERE target.participation = 'Tá')::INT AS ta,
      count(*) FILTER (WHERE target.participation = 'Níl')::INT AS nil,
      count(*) FILTER (WHERE target.participation = 'Staon')::INT AS staon
    FROM raw_event_targets target
    JOIN representatives representative ON representative.id = target.representative_id
    WHERE target.raw_event_id = ${id}::UUID
    GROUP BY representative.party_name
    ORDER BY count(*) DESC, representative.party_name
  `;
  const detail: DivisionDetail = { ...toDivision(row), partyBreakdown: breakdown };

  if (options.includeMembers) {
    const members = await database<{
      id: string; name: string; party: string; area: string; vote: string | null;
    }[]>`
      SELECT representative.representative_key AS id, representative.name,
        representative.party_name AS party, representative.area, target.participation AS vote
      FROM raw_event_targets target
      JOIN representatives representative ON representative.id = target.representative_id
      WHERE target.raw_event_id = ${id}::UUID
      ORDER BY representative.name
    `;
    detail.members = members.map((member) => ({
      representative: { id: member.id, name: member.name, party: member.party, area: member.area },
      vote: member.vote,
    }));
  }
  return { data: detail, meta: buildMeta(1, 1, null) };
}
