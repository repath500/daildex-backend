import {
  API_LICENCE,
  getBill,
  getDivision,
  getQuestion,
  getRepresentative,
  listBills,
  listDivisions,
  listPublicActivity,
  listPublicQuestions,
  listPublicSpeeches,
  listPublicVotes,
  listRepresentatives,
  parseBillListQuery,
  parseDivisionListQuery,
  parsePublicActivityQuery,
  parsePublicListQuery,
  parseRepresentativeListQuery,
} from "@daildex/core/public-api";
import { AppError } from "@daildex/shared";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

const MAX_RESULTS = 25;
const MAX_TEXT = 60_000;

export const MCP_INSTRUCTIONS = `DáilDex exposes the official Irish parliamentary record (Houses of the Oireachtas): Dáil divisions (votes), parliamentary questions with their written answers, debate contributions and bills. Every result carries a sourceUrl on oireachtas.ie — cite it.

Coverage today: Dáil only (no Seanad, no committees). Votes start 26 May 2026; questions and debate contributions start around July 2026. Data refreshes about hourly. Do not conclude that a member did NOT vote or speak just because nothing is returned: the record may not cover that period, or the search term may not match the debate title. Say what the data covers.

Vote results: "Tá" = for, "Níl" = against, "Staon" = abstained. A division's tallies are for the whole Dáil; partyBreakdown counts members matched in DáilDex's directory, by their current party.

Read-only. All results are limited to ${MAX_RESULTS} items; use the cursor / next_cursor to page.

${API_LICENCE.attribution} ${API_LICENCE.url}`;

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function ok(summary: string, data: Record<string, unknown>): ToolResult {
  const body = JSON.stringify(data);
  const text = `${summary}\n\n${body.length > MAX_TEXT ? `${body.slice(0, MAX_TEXT)}… (truncated; narrow the query)` : body}`;
  return {
    content: [{ type: "text", text }],
    structuredContent: { ...data, licence: API_LICENCE },
  };
}

function failure(error: unknown): ToolResult {
  const message = error instanceof AppError ? error.message : "The DáilDex API had a problem. Try again shortly.";
  if (!(error instanceof AppError)) console.error("MCP tool error", error);
  return { isError: true, content: [{ type: "text", text: message }] };
}

const guarded = <Args>(handler: (args: Args) => Promise<ToolResult>) => async (args: Args): Promise<ToolResult> => {
  try {
    return await handler(args);
  } catch (error) {
    return failure(error);
  }
};

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const date = z.iso.date().describe("YYYY-MM-DD");
const limit = z.number().int().min(1).max(MAX_RESULTS).default(10);
const cursor = z.string().max(300).optional().describe("`next_cursor` from the previous page.");
const compact = <T extends Record<string, unknown>>(values: T) =>
  Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined && value !== null)) as Record<string, string | undefined>;

export function createPublicMcpServer(): McpServer {
  const server = new McpServer(
    { name: "daildex", version: "1.0.0-beta", title: "DáilDex — Oireachtas record" },
    { instructions: MCP_INSTRUCTIONS },
  );

  server.registerTool("find_representative", {
    title: "Find a TD",
    description: "Look up TDs by name, constituency or party and get their ids for the other tools. Returns active members unless include_former is set.",
    inputSchema: {
      query: z.string().min(1).max(120).describe("Name, constituency or party, e.g. 'Whitmore' or 'Cork'."),
      chamber: z.enum(["Dáil", "Seanad"]).optional(),
      party: z.string().max(120).optional(),
      constituency: z.string().max(120).optional(),
      include_former: z.boolean().default(false),
      limit,
    },
    annotations: readOnly,
  }, guarded(async (args) => {
    const result = await listRepresentatives(parseRepresentativeListQuery(compact({
      q: args.query, chamber: args.chamber, party: args.party, constituency: args.constituency,
      status: args.include_former ? "all" : "active",
    })));
    const representatives = result.representatives.slice(0, args.limit);
    return ok(`${representatives.length} of ${result.representatives.length} matching members.`, { representatives });
  }));

  server.registerTool("get_representative", {
    title: "Get a TD's profile",
    description: "Profile plus a count of the votes (Tá/Níl/Staon) and parliamentary questions DáilDex holds for them, and since when.",
    inputSchema: { id: z.string().min(1).max(160).describe("Representative id from find_representative.") },
    annotations: readOnly,
  }, guarded(async ({ id }) => {
    const { data } = await getRepresentative(id);
    return ok(`${data.name} (${data.party}, ${data.area}).`, { representative: data });
  }));

  server.registerTool("search_divisions", {
    title: "Search Dáil votes",
    description: "Find divisions (votes) by topic, date range, outcome or member. Each result has the outcome and Tá/Níl/Staon tallies. Newest first.",
    inputSchema: {
      query: z.string().min(1).max(200).optional().describe("Matches the motion/amendment and debate title, e.g. 'housing' or 'Finance Bill'."),
      date_start: date.optional(),
      date_end: date.optional(),
      outcome: z.string().max(40).optional().describe("e.g. Carried, Lost"),
      representative: z.string().max(160).optional().describe("Only divisions this member took part in."),
      limit,
      cursor,
    },
    annotations: readOnly,
  }, guarded(async (args) => {
    const result = await listDivisions(parseDivisionListQuery(compact({
      q: args.query, date_start: args.date_start, date_end: args.date_end, outcome: args.outcome,
      representative: args.representative, limit: String(args.limit), cursor: args.cursor,
    })));
    return ok(`${result.data.length} divisions${result.meta.has_more ? " (more available)" : ""}.`, { divisions: result.data, next_cursor: result.meta.next_cursor });
  }));

  server.registerTool("get_division", {
    title: "Get a division in full",
    description: "One division with its party breakdown and, with include_members, how every member voted.",
    inputSchema: {
      id: z.string().uuid().describe("Division id from search_divisions."),
      include_members: z.boolean().default(false),
    },
    annotations: readOnly,
  }, guarded(async ({ id, include_members }) => {
    const { data } = await getDivision(id, { includeMembers: include_members });
    return ok(`${data.title} — ${data.outcome ?? "outcome not recorded"} (${data.date}).`, { division: data });
  }));

  server.registerTool("how_did_they_vote", {
    title: "How did a TD vote on a topic?",
    description: "A member's recorded votes (Tá/Níl/Staon) in divisions whose title or debate matches a topic, newest first, each with a source link and the division outcome. Absence of a result is not evidence they did not vote.",
    inputSchema: {
      representative: z.string().min(1).max(160).describe("Representative id from find_representative."),
      topic: z.string().min(1).max(200).describe("e.g. 'Health Bill', 'rent', 'Finance'."),
      date_start: date.optional(),
      date_end: date.optional(),
      limit,
      cursor,
    },
    annotations: readOnly,
  }, guarded(async (args) => {
    const result = await listPublicVotes(parsePublicListQuery(compact({
      representative: args.representative, q: args.topic, date_start: args.date_start,
      date_end: args.date_end, limit: String(args.limit), cursor: args.cursor,
    })));
    const counts = { Tá: 0, Níl: 0, Staon: 0 } as Record<string, number>;
    for (const vote of result.votes) if (vote.participation) counts[vote.participation] = (counts[vote.participation] ?? 0) + 1;
    return ok(
      `${result.votes.length} matching votes on this page: Tá ${counts.Tá}, Níl ${counts.Níl}, Staon ${counts.Staon}.`,
      { votes: result.votes, next_cursor: result.next_cursor },
    );
  }));

  server.registerTool("search_questions", {
    title: "Search parliamentary questions",
    description: "Parliamentary questions by member, topic or date. The list shows a 500-character excerpt; set include_answers to also fetch the full question and written answer (limited to 10 results).",
    inputSchema: {
      query: z.string().min(1).max(200).optional().describe("Matches the question text and its topic heading."),
      representative: z.string().max(160).optional().describe("Representative id of the TD who asked."),
      date_start: date.optional(),
      date_end: date.optional(),
      include_answers: z.boolean().default(false),
      limit,
      cursor,
    },
    annotations: readOnly,
  }, guarded(async (args) => {
    const size = args.include_answers ? Math.min(args.limit, 10) : args.limit;
    const result = await listPublicQuestions(parsePublicListQuery(compact({
      q: args.query, representative: args.representative, date_start: args.date_start,
      date_end: args.date_end, limit: String(size), cursor: args.cursor,
    })));
    const questions = args.include_answers
      ? await Promise.all(result.questions.map(async (item) => (await getQuestion(item.id)).data))
      : result.questions;
    return ok(`${questions.length} questions${result.has_more ? " (more available)" : ""}.`, { questions, next_cursor: result.next_cursor });
  }));

  server.registerTool("search_debates", {
    title: "Search Dáil debate contributions",
    description: "Contributions to Dáil debates by member, topic or date, with the debate section heading. Text is an excerpt of up to 500 characters.",
    inputSchema: {
      query: z.string().min(1).max(200).optional(),
      representative: z.string().max(160).optional(),
      date_start: date.optional(),
      date_end: date.optional(),
      limit,
      cursor,
    },
    annotations: readOnly,
  }, guarded(async (args) => {
    const result = await listPublicSpeeches(parsePublicListQuery(compact({
      q: args.query, representative: args.representative, date_start: args.date_start,
      date_end: args.date_end, limit: String(args.limit), cursor: args.cursor,
    })));
    return ok(`${result.speeches.length} contributions${result.has_more ? " (more available)" : ""}.`, { contributions: result.speeches, next_cursor: result.next_cursor });
  }));

  server.registerTool("get_bill", {
    title: "Find or read a bill",
    description: "Give year and number for a bill's stages, sponsors, linked debates and documents. Or give a query (and optionally status/year) to search bills first.",
    inputSchema: {
      year: z.string().regex(/^\d{4}$/).optional(),
      number: z.string().regex(/^\d{1,5}$/).optional(),
      query: z.string().min(1).max(200).optional(),
      status: z.string().max(60).optional().describe("e.g. Current, Enacted, Lapsed"),
      limit,
    },
    annotations: readOnly,
  }, guarded(async (args) => {
    if (args.year && args.number) {
      const { data } = await getBill(args.year, args.number);
      return ok(`${data.title} — ${data.status}${data.currentStage ? `, ${data.currentStage}` : ""}.`, { bill: data });
    }
    if (!args.query && !args.year && !args.status) {
      throw new AppError("INVALID_REQUEST", "Give a bill's year and number, or a query to search.", 400);
    }
    const result = await listBills(parseBillListQuery(compact({
      q: args.query, year: args.year, status: args.status, limit: String(args.limit),
    })));
    return ok(`${result.data.length} bills. Call again with year and number for one bill in full.`, { bills: result.data });
  }));

  server.registerTool("get_activity", {
    title: "Recent parliamentary activity",
    description: "A cross-record feed (votes, questions, speeches, bills) newest first, optionally for one member, one record type, a topic or a date range.",
    inputSchema: {
      representative: z.string().max(160).optional(),
      type: z.enum(["vote", "question", "speech", "legislation"]).optional(),
      query: z.string().min(1).max(200).optional(),
      date_start: date.optional(),
      date_end: date.optional(),
      limit,
      cursor,
    },
    annotations: readOnly,
  }, guarded(async (args) => {
    const result = await listPublicActivity(parsePublicActivityQuery(compact({
      representative: args.representative, type: args.type, q: args.query, date_start: args.date_start,
      date_end: args.date_end, limit: String(args.limit), cursor: args.cursor,
    })));
    return ok(`${result.items.length} items${result.has_more ? " (more available)" : ""}.`, { items: result.items, next_cursor: result.next_cursor });
  }));

  server.registerResource(
    "representative",
    new ResourceTemplate("daildex://representative/{id}", { list: undefined }),
    { title: "TD profile", description: "A representative's profile and record summary.", mimeType: "application/json" },
    async (uri, variables) => {
      const { data } = await getRepresentative(String(variables.id));
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ ...data, licence: API_LICENCE }) }] };
    },
  );
  server.registerResource(
    "division",
    new ResourceTemplate("daildex://division/{id}", { list: undefined }),
    { title: "Division", description: "A division with party breakdown and every member's vote.", mimeType: "application/json" },
    async (uri, variables) => {
      const { data } = await getDivision(String(variables.id), { includeMembers: true });
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ ...data, licence: API_LICENCE }) }] };
    },
  );

  server.registerPrompt("fact_check_vote_claim", {
    title: "Fact-check a claim about a vote",
    description: "Check a claim such as 'TD X voted against Y' against the Dáil record.",
    argsSchema: { claim: z.string().min(1).max(500).describe("The claim to check, in the speaker's words.") },
  }, ({ claim }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: `Fact-check this claim against the Dáil record using the DáilDex tools: "${claim}"

1. find_representative to get the member's id.
2. how_did_they_vote (or search_divisions with the member) with the topic; try more than one phrasing of the topic.
3. get_division for any relevant result to confirm the outcome and the member's vote.
Report: what the record shows, with each division's date, title, outcome, the member's vote and its sourceUrl. State the date range DáilDex covers (votes from 26 May 2026) and, if nothing matches, say the record may not cover the claim rather than that the claim is false.`,
      },
    }],
  }));

  server.registerPrompt("member_record_summary", {
    title: "Summarise a TD's recent record",
    description: "A sourced summary of what a TD has voted on, asked and said recently.",
    argsSchema: { name: z.string().min(1).max(120).describe("The TD's name.") },
  }, ({ name }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: `Summarise the recent parliamentary record of ${name} using the DáilDex tools: find_representative, get_representative, get_activity (limit 25), and how_did_they_vote for notable topics. Keep it factual and neutral, include a sourceUrl for each item, and state the coverage period.`,
      },
    }],
  }));

  return server;
}

/** Stateless Streamable HTTP: a fresh server and transport per request, JSON (not SSE) replies. */
export async function handleMcpRequest(request: Request): Promise<Response> {
  const server = createPublicMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    // Replies are already built; release the per-request server.
    queueMicrotask(() => void server.close().catch(() => undefined));
  }
}
