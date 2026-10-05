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
  htmlToText,
  likePattern,
  parseStrict,
  slugify,
  type PublicMeta,
} from "./query";
import { summarizeRepresentativeRecord, type RepresentativeRecordSummary } from "./service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Envelope<T> = { data: T; meta: PublicMeta };
const single = <T>(data: T): Envelope<T> => ({ data, meta: buildMeta(1, 1, null) });

// ---------------------------------------------------------------------------------------------
// Representatives
// ---------------------------------------------------------------------------------------------

export type RepresentativeListItem = {
  id: string;
  name: string;
  area: string;
  party: string;
  role: "TD" | "Senator";
  chamber: "Dáil" | "Seanad";
};

export type RepresentativeDetail = RepresentativeListItem & {
  status: "active" | "former";
  firstElected: string | null;
  sourceUrl: string | null;
  record: RepresentativeRecordSummary;
};

export const representativeShape = {
  q: z.string().trim().min(1).max(120).optional(),
  chamber: z.enum(["Dáil", "Seanad"]).optional(),
  party: z.string().trim().min(1).max(120).optional(),
  constituency: z.string().trim().min(1).max(120).optional(),
  status: z.enum(["active", "former", "all"]).default("active"),
};

export type RepresentativeListQuery = z.infer<z.ZodObject<typeof representativeShape>>;

export function parseRepresentativeListQuery(query: Record<string, string | undefined>): RepresentativeListQuery {
  return parseStrict(representativeShape, query);
}

export async function listRepresentatives(
  query: RepresentativeListQuery,
  database: Database = getDatabase(),
): Promise<{ representatives: RepresentativeListItem[]; meta: PublicMeta }> {
  const partySlug = query.party ? slugify(query.party) : "";
  const areaSlug = query.constituency ? slugify(query.constituency) : "";
  const rows = await database<(RepresentativeListItem & { party_slug: string; area_slug: string })[]>`
    SELECT * FROM (
      SELECT representative_key AS id, name, area, party_name AS party, role, chamber,
        regexp_replace(lower(party_name), '[^a-z0-9]+', '-', 'g') AS party_slug,
        regexp_replace(lower(area), '[^a-z0-9]+', '-', 'g') AS area_slug
      FROM representatives
      WHERE (${query.status} = 'all' OR status = ${query.status})
        AND (${query.chamber ?? ""} = '' OR chamber = ${query.chamber ?? ""})
        AND (${query.q ?? ""} = '' OR lower(name || ' ' || area || ' ' || party_name) LIKE ${likePattern(query.q)})
    ) member
    WHERE (${partySlug} = '' OR member.party_slug = ${partySlug} OR lower(member.party) = ${(query.party ?? "").toLocaleLowerCase("en-IE")})
      AND (${areaSlug} = '' OR member.area_slug = ${areaSlug} OR lower(member.area) = ${(query.constituency ?? "").toLocaleLowerCase("en-IE")})
    ORDER BY member.name
    LIMIT 300
  `;
  const representatives: RepresentativeListItem[] = rows.map((row) => ({
    id: row.id, name: row.name, area: row.area, party: row.party, role: row.role, chamber: row.chamber,
  }));
  return { representatives, meta: buildMeta(representatives.length, 300, null) };
}

export async function getRepresentative(
  id: string,
  database: Database = getDatabase(),
): Promise<Envelope<RepresentativeDetail>> {
  const rows = await database<(RepresentativeListItem & {
    status: "active" | "former"; first_elected: string | null; source_uri: string | null;
  })[]>`
    SELECT representative_key AS id, name, area, party_name AS party, role, chamber, status,
      first_elected_date::TEXT AS first_elected, source_uri
    FROM representatives WHERE representative_key = ${id}
  `;
  const row = rows[0];
  if (!row) throw new AppError("NOT_FOUND", "Representative not found.", 404);
  const record = await summarizeRepresentativeRecord(row.id, database);
  return single({
    id: row.id,
    name: row.name,
    area: row.area,
    party: row.party,
    role: row.role,
    chamber: row.chamber,
    status: row.status,
    firstElected: row.first_elected,
    sourceUrl: toPublicOireachtasUrl(row.source_uri) ?? row.source_uri,
    record,
  });
}

// ---------------------------------------------------------------------------------------------
// Question and speech detail
// ---------------------------------------------------------------------------------------------

type PersonRow = { id: string; name: string; area: string; party: string; chamber: "Dáil" | "Seanad"; role: "TD" | "Senator" };

export type QuestionDetail = {
  id: string;
  date: string;
  number: number | null;
  type: string | null;
  title: string;
  department: string | null;
  question: string;
  answer: string | null;
  asker: PersonRow;
  sourceUrl: string;
};

export async function getQuestion(
  id: string,
  database: Database = getDatabase(),
): Promise<Envelope<QuestionDetail>> {
  if (!UUID.test(id)) throw new AppError("NOT_FOUND", "Question not found.", 404);
  const rows = await database<{
    id: string; date: string; title: string; question: string; source_uri: string; canonical_url: string;
    payload: { question?: { questionNumber?: number; questionType?: string; answerText?: string; to?: { showAs?: string } } } | null;
    asker: PersonRow;
  }[]>`
    SELECT contribution.id::TEXT AS id, document.document_date::TEXT AS date, document.title,
      contribution.text AS question, contribution.source_uri, document.canonical_url,
      event.raw_payload AS payload,
      jsonb_build_object('id', representative.representative_key, 'name', representative.name,
        'area', representative.area, 'party', representative.party_name,
        'chamber', representative.chamber, 'role', representative.role) AS asker
    FROM official_contributions contribution
    JOIN official_document_versions version ON version.id = contribution.official_document_version_id
    JOIN official_documents document ON document.id = version.official_document_id
    JOIN representatives representative ON representative.id = contribution.representative_id
    LEFT JOIN raw_events event
      ON event.source_type = 'oireachtas_question' AND event.source_external_id = contribution.source_uri
    WHERE contribution.id = ${id.toLowerCase()}::UUID AND contribution.contribution_type = 'question'
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) throw new AppError("NOT_FOUND", "Question not found.", 404);
  const question = row.payload?.question;
  return single({
    id: row.id,
    date: row.date,
    number: question?.questionNumber ?? null,
    type: question?.questionType ?? null,
    title: row.title,
    department: question?.to?.showAs?.trim() || null,
    question: htmlToText(row.question) ?? row.question,
    answer: htmlToText(question?.answerText),
    asker: row.asker,
    sourceUrl: toPublicOireachtasUrl(row.source_uri) ?? toPublicOireachtasUrl(row.canonical_url) ?? row.canonical_url,
  });
}

export type SpeechDetail = {
  id: string;
  date: string;
  debate: string;
  section: string | null;
  text: string;
  speaker: PersonRow;
  sourceUrl: string;
};

export async function getSpeech(
  id: string,
  database: Database = getDatabase(),
): Promise<Envelope<SpeechDetail>> {
  if (!UUID.test(id)) throw new AppError("NOT_FOUND", "Speech not found.", 404);
  const rows = await database<{
    id: string; date: string; debate: string; section: string | null; text: string;
    source_uri: string | null; canonical_url: string; speaker: PersonRow;
  }[]>`
    SELECT contribution.id::TEXT AS id, document.document_date::TEXT AS date, document.title AS debate,
      section.heading AS section, contribution.text, contribution.source_uri, document.canonical_url,
      jsonb_build_object('id', representative.representative_key, 'name', representative.name,
        'area', representative.area, 'party', representative.party_name,
        'chamber', representative.chamber, 'role', representative.role) AS speaker
    FROM official_contributions contribution
    JOIN official_document_versions version ON version.id = contribution.official_document_version_id
    JOIN official_documents document ON document.id = version.official_document_id
    JOIN representatives representative ON representative.id = contribution.representative_id
    LEFT JOIN LATERAL (
      SELECT event.raw_payload #>> '{section,title}' AS heading
      FROM raw_events event
      WHERE event.source_type = 'oireachtas_debate'
        AND event.source_url = split_part(contribution.source_uri, '#text-', 1)
      LIMIT 1
    ) section ON TRUE
    WHERE contribution.id = ${id.toLowerCase()}::UUID AND contribution.contribution_type = 'speech'
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) throw new AppError("NOT_FOUND", "Speech not found.", 404);
  return single({
    id: row.id,
    date: row.date,
    debate: row.debate,
    section: row.section?.trim() || null,
    text: row.text,
    speaker: row.speaker,
    sourceUrl: toPublicOireachtasUrl(row.source_uri) ?? toPublicOireachtasUrl(row.canonical_url) ?? row.canonical_url,
  });
}

// ---------------------------------------------------------------------------------------------
// Bills
// ---------------------------------------------------------------------------------------------

export type Bill = {
  id: string;
  year: string;
  number: string;
  title: string;
  longTitle: string;
  status: string;
  source: string;
  currentStage: string | null;
  currentStageDate: string | null;
  sourceUrl: string;
};

export type BillDetail = Bill & {
  sponsors: string[];
  stages: Array<{ stage: string; house: string | null; date: string | null; completed: boolean | null }>;
  debates: Array<{ label: string; date: string | null; url: string | null }>;
  documents: Array<{ label: string; type: string; language: string | null; pdfUrl: string | null; xmlUrl: string | null }>;
};

export const billShape = {
  q: z.string().trim().min(1).max(200).optional(),
  year: z.string().regex(/^\d{4}$/, "Expected a four-digit year").optional(),
  status: z.string().trim().min(1).max(60).optional(),
  ...dateRange,
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().trim().min(1).max(300).optional(),
};

export type BillListQuery = z.infer<z.ZodObject<typeof billShape>>;

export function parseBillListQuery(query: Record<string, string | undefined>): BillListQuery {
  return parseStrict(billShape, query, checkDateRange);
}

type BillRow = {
  id: string; year: string; number: string; title: string; long_title: string; status: string;
  source: string; current_stage: string | null; current_stage_date: string | null; source_uri: string;
  sort_key: string;
};

function toBill(row: BillRow): Bill {
  return {
    id: `${row.year}/${row.number}`,
    year: row.year,
    number: row.number,
    title: row.title,
    longTitle: row.long_title,
    status: row.status,
    source: row.source,
    currentStage: row.current_stage,
    currentStageDate: row.current_stage_date,
    sourceUrl: toPublicOireachtasUrl(row.source_uri) ?? row.source_uri,
  };
}

export async function listBills(
  query: BillListQuery,
  database: Database = getDatabase(),
): Promise<Envelope<Bill[]>> {
  const cursor = decodeCursor(query.cursor);
  const rows = await database<BillRow[]>`
    SELECT * FROM (
      SELECT document.id::TEXT AS id, document.bill_year AS year, document.bill_number AS number,
        document.title, document.long_title, document.status, document.source,
        document.current_stage, document.current_stage_date::TEXT AS current_stage_date,
        document.source_uri, coalesce(document.current_stage_date::TEXT, '') AS sort_key
      FROM legislation_documents document
      WHERE (${query.year ?? ""} = '' OR document.bill_year = ${query.year ?? ""})
        AND (${query.status ?? ""} = '' OR lower(document.status) = ${(query.status ?? "").toLocaleLowerCase("en-IE")})
        AND (${query.date_start ?? null}::DATE IS NULL OR document.current_stage_date >= ${query.date_start ?? null}::DATE)
        AND (${query.date_end ?? null}::DATE IS NULL OR document.current_stage_date <= ${query.date_end ?? null}::DATE)
        AND (${query.q ?? ""} = '' OR lower(document.title || ' ' || document.long_title || ' ' || coalesce(document.current_stage, '')) LIKE ${likePattern(query.q)})
    ) bill
    WHERE ${cursor ? database`(bill.sort_key, bill.id) < (${cursor.k}::TEXT, ${cursor.i}::TEXT)` : database`TRUE`}
    ORDER BY bill.sort_key DESC, bill.id DESC
    LIMIT ${query.limit + 1}
  `;
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  const nextCursor = rows.length > query.limit && last ? encodeCursor({ k: last.sort_key, i: last.id }) : null;
  return { data: page.map(toBill), meta: buildMeta(page.length, query.limit, nextCursor) };
}

type BillPayload = {
  bill?: {
    sponsors?: Array<{ sponsor?: { by?: { showAs?: string }; as?: { showAs?: string } } }>;
    stages?: Array<{
      event?: {
        showAs?: string;
        stageCompleted?: boolean;
        house?: { showAs?: string };
        dates?: Array<{ date?: string }>;
      };
    }>;
  };
};

export async function getBill(
  year: string,
  number: string,
  database: Database = getDatabase(),
): Promise<Envelope<BillDetail>> {
  if (!/^\d{4}$/.test(year) || !/^\d{1,5}$/.test(number)) throw new AppError("NOT_FOUND", "Bill not found.", 404);
  const rows = await database<BillRow[]>`
    SELECT document.id::TEXT AS id, document.bill_year AS year, document.bill_number AS number,
      document.title, document.long_title, document.status, document.source,
      document.current_stage, document.current_stage_date::TEXT AS current_stage_date,
      document.source_uri, '' AS sort_key
    FROM legislation_documents document
    WHERE document.bill_year = ${year} AND document.bill_number = ${number}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) throw new AppError("NOT_FOUND", "Bill not found.", 404);

  const [versions, debates, documents] = await Promise.all([
    database<{ raw_payload: BillPayload }[]>`
      SELECT raw_payload FROM legislation_versions
      WHERE legislation_document_id = ${row.id}::UUID ORDER BY fetched_at DESC LIMIT 1
    `,
    database<{ label: string; date: string | null; debate_uri: string; section: string | null }[]>`
      SELECT label, debate_date::TEXT AS date, debate_uri, nullif(debate_section_id, '') AS section
      FROM legislation_debate_links
      WHERE legislation_document_id = ${row.id}::UUID
      ORDER BY debate_date DESC NULLS LAST, label
    `,
    database<{ label: string; document_type: string; language: string | null; pdf_url: string | null; xml_url: string | null }[]>`
      SELECT label, document_type, language, pdf_url, xml_url
      FROM legislation_related_documents
      WHERE legislation_document_id = ${row.id}::UUID
      ORDER BY label
    `,
  ]);
  const bill = versions[0]?.raw_payload?.bill;
  const sponsors = (bill?.sponsors ?? [])
    .map((entry) => entry.sponsor?.by?.showAs ?? entry.sponsor?.as?.showAs)
    .filter((value): value is string => Boolean(value?.trim()));
  const stages = (bill?.stages ?? [])
    .map((entry) => entry.event)
    .filter((event): event is NonNullable<typeof event> => Boolean(event?.showAs))
    .map((event) => ({
      stage: event.showAs!,
      house: event.house?.showAs ?? null,
      date: event.dates?.map((entry) => entry.date).filter(Boolean).at(-1) ?? null,
      completed: typeof event.stageCompleted === "boolean" ? event.stageCompleted : null,
    }));

  return single({
    ...toBill(row),
    sponsors,
    stages,
    debates: debates.map((debate) => {
      const base = toPublicOireachtasUrl(debate.debate_uri);
      return {
        label: debate.label,
        date: debate.date,
        url: base && debate.section && !base.includes("#") ? `${base}#${debate.section}` : base ?? null,
      };
    }),
    documents: documents.map((doc) => ({
      label: doc.label, type: doc.document_type, language: doc.language,
      pdfUrl: doc.pdf_url, xmlUrl: doc.xml_url,
    })),
  });
}

// ---------------------------------------------------------------------------------------------
// Parties and constituencies
// ---------------------------------------------------------------------------------------------

export async function listParties(
  database: Database = getDatabase(),
): Promise<Envelope<Array<{ id: string; name: string; members: number }>>> {
  const rows = await database<{ name: string; members: number }[]>`
    SELECT party_name AS name, count(*)::INT AS members
    FROM representatives WHERE status = 'active'
    GROUP BY party_name ORDER BY count(*) DESC, party_name
  `;
  const data = rows.map((row) => ({ id: slugify(row.name), name: row.name, members: row.members }));
  return { data, meta: buildMeta(data.length, data.length, null) };
}

export async function listConstituencies(
  database: Database = getDatabase(),
): Promise<Envelope<Array<{ id: string; name: string; county: string | null; seats: number | null; members: number }>>> {
  const rows = await database<{ name: string; county: string | null; seats: number | null; members: number }[]>`
    SELECT member.area AS name, constituency.county, constituency.seat_count AS seats, member.members
    FROM (
      SELECT area, count(*)::INT AS members FROM representatives WHERE status = 'active' AND chamber = 'Dáil' GROUP BY area
    ) member
    LEFT JOIN constituencies constituency ON lower(constituency.name) = lower(member.area)
    ORDER BY member.area
  `;
  const data = rows.map((row) => ({ id: slugify(row.name), ...row }));
  return { data, meta: buildMeta(data.length, data.length, null) };
}
