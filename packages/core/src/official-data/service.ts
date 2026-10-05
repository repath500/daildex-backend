import { AppError, type TopicTag } from "@daildex/shared";
import { z } from "zod";
import { toPublicOireachtasUrl } from "./urls";

const resourceSchema = z.enum(["members", "votes", "debates", "questions", "legislation"]);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isCalendarDate, "Invalid calendar date");

export const officialSearchSchema = z.strictObject({
  resource: resourceSchema,
  query: z.string().trim().max(120).optional().describe("Words used to filter the returned records (a name, title or topic). Accents and word order do not matter."),
  member: z
    .string()
    .trim()
    .max(80)
    .optional()
    .describe("Votes only: a TD's name, e.g. \"Micheál Martin\". Returns how that member voted in each division and how their party colleagues voted."),
  dateStart: dateSchema.optional(),
  dateEnd: dateSchema.optional(),
  chamber: z.enum(["dail", "seanad", "all"]).default("dail"),
});

export type OfficialSearchInput = z.infer<typeof officialSearchSchema>;

type ApiPage = { results?: unknown[]; head?: { counts?: Record<string, number> } };
type VoteKind = "ta" | "nil" | "staon";
type Loose = Record<string, unknown>;

const PAGE_SIZE = 100;
const MAX_PAGES = 3;
const RESULT_LIMIT = 8;
const CURRENT_DAIL = process.env.OIREACHTAS_CURRENT_DAIL ?? "34";
const MEMBER_INDEX_TTL_MS = 6 * 60 * 60 * 1000;
const VOTE_GROUPS: Array<[VoteKind, string]> = [
  ["ta", "taVotes"],
  ["nil", "nilVotes"],
  ["staon", "staonVotes"],
];

/** Lower-case, accent-free, punctuation-free text so "Micheál Martin" matches "Martin, Micheál.". */
export function foldText(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-IE")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokensOf(value: string) {
  return foldText(value).split(" ").filter(Boolean);
}

function matchesAllTokens(haystack: string, tokens: string[]) {
  return tokens.every((token) => haystack.includes(token));
}

function apiBase() {
  return (process.env.OIREACHTAS_API_BASE_URL ?? "https://api.oireachtas.ie/v1").replace(/\/$/, "");
}

async function fetchApiPage(url: URL): Promise<ApiPage> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "DailDex/1.0 (official-data)" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new AppError("SERVICE_UNAVAILABLE", "The Houses of the Oireachtas API could not be reached.", 503, { cause: error });
  }
  if (!response.ok) throw new AppError("SERVICE_UNAVAILABLE", `The Oireachtas API returned HTTP ${response.status}.`, 503);
  try {
    return (await response.json()) as ApiPage;
  } catch (error) {
    throw new AppError("SERVICE_UNAVAILABLE", "The Oireachtas API returned invalid JSON.", 503, { cause: error });
  }
}

/** Read up to `maxPages` pages so a filter sees the whole window, not just the newest records. */
async function fetchPages(url: URL, pageSize: number, maxPages: number) {
  const results: unknown[] = [];
  let total: number | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const pageUrl = new URL(url);
    pageUrl.searchParams.set("limit", String(pageSize));
    if (page > 0) pageUrl.searchParams.set("skip", String(page * pageSize));
    const body = await fetchApiPage(pageUrl);
    const batch = body.results ?? [];
    results.push(...batch);
    const counts = body.head?.counts ?? {};
    total ??= Object.values(counts).find((value) => typeof value === "number");
    if (batch.length < pageSize || (total !== undefined && results.length >= total)) break;
  }
  return { results, total: total ?? results.length };
}

type MemberEntry = {
  code: string;
  name: string;
  folded: string;
  party: string;
  constituency?: string;
  uri?: string;
};

let memberIndexCache: { at: number; base: string; members: MemberEntry[] } | undefined;

function readMember(entry: unknown): MemberEntry | undefined {
  const member = ((entry as Loose)?.member ?? entry) as Loose | undefined;
  if (!member || typeof member.memberCode !== "string") return undefined;
  const name = String(member.fullName ?? member.showAs ?? "").trim();
  if (!name) return undefined;
  const memberships = Array.isArray(member.memberships) ? (member.memberships as Loose[]) : [];
  const current = memberships
    .map((item) => (item.membership ?? item) as Loose)
    .filter((item) => String(((item.house as Loose | undefined)?.houseNo ?? "")) === CURRENT_DAIL)
    .at(-1);
  const parties = Array.isArray(current?.parties) ? (current.parties as Loose[]) : [];
  const lastParty = (parties.at(-1)?.party ?? parties.at(-1)) as Loose | undefined;
  const represents = Array.isArray(current?.represents) ? (current.represents as Loose[]) : [];
  const seat = (represents[0]?.represent ?? represents[0]) as Loose | undefined;
  return {
    code: member.memberCode,
    name,
    folded: foldText(name),
    party: typeof lastParty?.showAs === "string" ? lastParty.showAs : "Independent / unknown",
    constituency: typeof seat?.showAs === "string" ? seat.showAs : undefined,
    uri: typeof member.uri === "string" ? member.uri : undefined,
  };
}

async function getMemberIndex(): Promise<MemberEntry[]> {
  const base = apiBase();
  if (memberIndexCache && memberIndexCache.base === base && Date.now() - memberIndexCache.at < MEMBER_INDEX_TTL_MS) {
    return memberIndexCache.members;
  }
  const url = new URL(`${base}/members`);
  url.searchParams.set("chamber", "dail");
  url.searchParams.set("house_no", CURRENT_DAIL);
  const { results } = await fetchPages(url, 200, 2);
  const members = results.map(readMember).filter((member): member is MemberEntry => Boolean(member));
  if (members.length) memberIndexCache = { at: Date.now(), base, members };
  return members;
}

/** Test hook: forget cached members between runs. */
export function resetOfficialDataCache() {
  memberIndexCache = undefined;
}

function resolveMember(name: string, index: MemberEntry[]) {
  const tokens = tokensOf(name);
  if (!tokens.length) return { matches: [] as MemberEntry[] };
  const folded = tokens.join(" ");
  const exact = index.filter((member) => member.folded === folded);
  if (exact.length) return { matches: exact };
  return { matches: index.filter((member) => matchesAllTokens(member.folded, tokens)) };
}

function divisionVoters(division: Loose) {
  const tallies = (division.tallies ?? {}) as Loose;
  const voters = new Map<string, { kind: VoteKind; name: string }>();
  for (const [kind, key] of VOTE_GROUPS) {
    const group = tallies[key] as Loose | undefined;
    const members = Array.isArray(group?.members) ? (group.members as Loose[]) : [];
    for (const entry of members) {
      const member = (entry.member ?? entry) as Loose;
      if (typeof member.memberCode === "string") voters.set(member.memberCode, { kind, name: String(member.showAs ?? member.memberCode) });
    }
  }
  return voters;
}

const KIND_LABEL: Record<VoteKind, string> = { ta: "Tá", nil: "Níl", staon: "Staon" };

function partySplit(voters: Map<string, { kind: VoteKind; name: string }>, member: MemberEntry, mine: VoteKind, index: MemberEntry[]) {
  const counts: Record<VoteKind, number> = { ta: 0, nil: 0, staon: 0 };
  const dissenters: Array<{ name: string; vote: string }> = [];
  for (const colleague of index) {
    if (colleague.party !== member.party || colleague.code === member.code) continue;
    const cast = voters.get(colleague.code);
    if (!cast) continue;
    counts[cast.kind] += 1;
    if (cast.kind !== mine) dissenters.push({ name: colleague.name, vote: KIND_LABEL[cast.kind] });
  }
  counts[mine] += 1;
  return {
    party: member.party,
    counts,
    dissenterCount: dissenters.length,
    dissenters: dissenters.slice(0, 10),
  };
}

export async function searchOfficialOireachtas(input: OfficialSearchInput) {
  const parsed = officialSearchSchema.parse(input);
  const end = parsed.dateEnd ?? isoDate(new Date());
  const endDate = parseCalendarDate(end);
  const earliestDate = new Date(endDate);
  earliestDate.setUTCDate(earliestDate.getUTCDate() - 120);
  const start = parsed.dateStart ?? isoDate(earliestDate);
  const startDate = parseCalendarDate(start);
  if (startDate > endDate) throw new AppError("INVALID_REQUEST", "dateStart must be on or before dateEnd.", 400);
  if (startDate < earliestDate) throw new AppError("INVALID_REQUEST", "The official-record search window cannot exceed 120 days.", 400);

  const retrievedAt = new Date().toISOString();
  const base = apiBase();

  if (parsed.resource === "members") {
    const index = await getMemberIndex();
    const tokens = tokensOf(parsed.query ?? parsed.member ?? "");
    const found = tokens.length
      ? index.filter((member) => matchesAllTokens(`${member.folded} ${foldText(member.party)} ${foldText(member.constituency ?? "")}`, tokens))
      : index;
    return {
      resource: "members" as const,
      source: "Houses of the Oireachtas API",
      retrievedAt,
      scanned: index.length,
      records: found.slice(0, RESULT_LIMIT).map((member) => ({
        name: member.name,
        party: member.party,
        constituency: member.constituency,
        memberCode: member.code,
        sourceUrl: toPublicOireachtasUrl(member.uri),
      })),
      note: found.length === 0 ? noMatchNote(index.length) : found.length > RESULT_LIMIT ? `Showing ${RESULT_LIMIT} of ${found.length} matching members.` : undefined,
    };
  }

  const url = new URL(`${base}/${parsed.resource === "votes" ? "divisions" : parsed.resource}`);
  url.searchParams.set("date_start", start);
  url.searchParams.set("date_end", end);
  if (parsed.chamber !== "all" && parsed.resource !== "legislation") url.searchParams.set("chamber", parsed.chamber);
  if (parsed.resource === "questions") url.searchParams.set("show_answers", "true");

  const needsWholeWindow = Boolean(parsed.query || parsed.member);
  const { results, total } = await fetchPages(url, needsWholeWindow || parsed.resource === "votes" ? PAGE_SIZE : 30, needsWholeWindow || parsed.resource === "votes" ? MAX_PAGES : 1);
  const dateRange = { start, end };
  const truncated = total > results.length;

  if (parsed.resource === "votes" && parsed.member) {
    const index = await getMemberIndex();
    const { matches } = resolveMember(parsed.member, index);
    if (matches.length !== 1) {
      return {
        resource: "votes" as const,
        source: "Houses of the Oireachtas API",
        retrievedAt,
        dateRange,
        scanned: results.length,
        records: [],
        note: matches.length === 0
          ? `No sitting Dáil member matched “${parsed.member}”. Check the spelling or try a surname.`
          : `“${parsed.member}” matches several members (${matches.slice(0, 6).map((member) => `${member.name}, ${member.party}`).join("; ")}). Ask again with the full name.`,
      };
    }
    const member = matches[0];
    const ordered = [...results].sort((a, b) => divisionSortKey(b).localeCompare(divisionSortKey(a)));
    const participated: Array<{ entry: unknown; kind: VoteKind; voters: Map<string, { kind: VoteKind; name: string }> }> = [];
    for (const entry of ordered) {
      const division = ((entry as Loose).division ?? entry) as Loose;
      const voters = divisionVoters(division);
      const cast = voters.get(member.code);
      if (cast) participated.push({ entry, kind: cast.kind, voters });
    }
    const shown = participated.slice(0, RESULT_LIMIT);
    return {
      resource: "votes" as const,
      source: "Houses of the Oireachtas API",
      retrievedAt,
      dateRange,
      scanned: results.length,
      member: {
        name: member.name,
        party: member.party,
        constituency: member.constituency,
        sourceUrl: toPublicOireachtasUrl(member.uri),
        divisionsInWindow: results.length,
        divisionsVoted: participated.length,
      },
      records: shown.map((item, position) => ({
        ...compactRecord("votes", item.entry),
        memberVote: KIND_LABEL[item.kind],
        partySplit: position < 3 ? partySplit(item.voters, member, item.kind, index) : undefined,
      })),
      note: participated.length === 0
        ? `${member.name} has no recorded vote in the ${results.length} divisions checked between ${start} and ${end}${truncated ? ` (the window holds ${total}; only the first ${results.length} were read)` : ""}. They may have been absent, or paired.`
        : truncated
          ? `Only ${results.length} of the ${total} divisions in this window were read; widen or narrow the dates to see the rest.`
          : undefined,
    };
  }

  const tokens = tokensOf(parsed.query ?? "");
  const ordered = parsed.resource === "votes" ? [...results].sort((a, b) => divisionSortKey(b).localeCompare(divisionSortKey(a))) : results;
  const filtered = tokens.length
    ? ordered.filter((entry) => matchesAllTokens(foldText(searchableText(parsed.resource, entry)), tokens))
    : ordered;
  return {
    resource: parsed.resource,
    source: "Houses of the Oireachtas API",
    retrievedAt,
    dateRange,
    scanned: results.length,
    totalInWindow: total,
    records: filtered.slice(0, RESULT_LIMIT).map((entry) => compactRecord(parsed.resource, entry)),
    note: filtered.length === 0
      ? noMatchNote(results.length, truncated ? total : undefined)
      : truncated
        ? `Only ${results.length} of ${total} records in this window were read.`
        : undefined,
  };
}

function noMatchNote(scanned: number, total?: number) {
  return `Nothing in the ${scanned} records checked matched${total ? ` (the window holds ${total})` : ""}. Try different wording or a different date range; this does not prove no such record exists.`;
}

function divisionSortKey(entry: unknown) {
  const division = ((entry as Loose).division ?? entry) as Loose;
  return String(division.datetime ?? division.date ?? "");
}

/** Text a query is matched against: titles and names, not every nested field. */
function searchableText(resource: z.infer<typeof resourceSchema>, entry: unknown) {
  if (resource === "votes") {
    const division = ((entry as Loose).division ?? entry) as Loose;
    return `${(division.subject as Loose | undefined)?.showAs ?? ""} ${(division.debate as Loose | undefined)?.showAs ?? ""} ${division.outcome ?? ""}`;
  }
  return JSON.stringify(entry);
}

function isoDate(value: Date) {
  return value.toISOString().slice(0, 10);
}

function isCalendarDate(value: string): boolean {
  const date = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(date.getTime()) && isoDate(date) === value;
}

function parseCalendarDate(value: string): Date {
  return new Date(`${value}T12:00:00Z`);
}

/** Many divisions carry only "Amendment put:" as their subject; borrow the debate title so the row says what was voted on. */
export function voteTitle(subject: unknown, debate: unknown) {
  const subjectText = typeof subject === "string" ? subject.trim() : "";
  const debateText = typeof debate === "string" ? debate.trim() : "";
  const bare = subjectText.match(/^(Question|Amendment|Motion)\s+put:?\s*$/i);
  if (bare && debateText) return `${debateText} (${bare[1].toLocaleLowerCase("en-IE")})`;
  return subjectText || debateText || undefined;
}

function tallyCount(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const group = value as { tally?: unknown; members?: unknown };
  if (typeof group.tally === "number" && Number.isFinite(group.tally)) return group.tally;
  return Array.isArray(group.members) ? group.members.length : undefined;
}

function compactRecord(resource: z.infer<typeof resourceSchema>, entry: unknown) {
  const record = entry as Record<string, unknown>;
  const value = (record[
    resource === "votes" ? "division" :
      resource === "debates" ? "debateRecord" :
        resource === "questions" ? "question" :
          resource === "legislation" ? "bill" : "member"
  ] ?? record) as Record<string, unknown>;
  if (resource === "votes") {
    const debate = value.debate as Record<string, unknown> | undefined;
    const subject = value.subject as Record<string, unknown> | undefined;
    const tallies = value.tallies as Record<string, unknown> | undefined;
    const ta = tallyCount(tallies?.taVotes);
    const nil = tallyCount(tallies?.nilVotes);
    const staon = tallyCount(tallies?.staonVotes);
    return {
      date: value.date,
      title: voteTitle(subject?.showAs, debate?.showAs),
      outcome: value.outcome,
      tally: ta === undefined && nil === undefined ? undefined : { ta: ta ?? 0, nil: nil ?? 0, staon: staon ?? 0 },
      sourceUrl: toPublicOireachtasUrl(value.uri) ?? toPublicOireachtasUrl(debate?.uri),
    };
  }
  if (resource === "questions") {
    const by = value.by as Record<string, unknown> | undefined;
    const to = value.to as Record<string, unknown> | undefined;
    const section = value.debateSection as Record<string, unknown> | undefined;
    return {
      date: value.date,
      title: value.showAs,
      askedBy: by?.showAs,
      addressedTo: to?.showAs,
      answer: value.answerText,
      sourceUrl: toPublicOireachtasUrl(section?.uri) ?? toPublicOireachtasUrl(value.uri),
    };
  }
  if (resource === "debates") {
    const house = value.house as Record<string, unknown> | undefined;
    return {
      date: value.date,
      title: value.debateType || house?.showAs,
      sourceUrl: toPublicOireachtasUrl(value.uri),
      sections: Array.isArray(value.debateSections) ? value.debateSections.slice(0, 5) : undefined,
    };
  }
  if (resource === "legislation") {
    const stage = value.mostRecentStage as Record<string, unknown> | undefined;
    return {
      title: value.shortTitleEn,
      billNumber: value.billNo,
      year: value.billYear,
      status: value.status,
      latestStage: stage,
      sourceUrl: toPublicOireachtasUrl(value.uri),
    };
  }
  return {
    name: value.showAs,
    memberCode: value.pId,
    sourceUrl: toPublicOireachtasUrl(value.uri),
    memberships: Array.isArray(value.memberships) ? value.memberships.slice(0, 3) : undefined,
  };
}

export type OfficialTopicTag = TopicTag;

export { toPublicOireachtasUrl } from "./urls";
