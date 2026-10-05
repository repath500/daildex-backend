import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PublicApiValidationError } from "./query";
import {
  getBill,
  getDivision,
  getQuestion,
  getRepresentative,
  getSpeech,
  listBills,
  listConstituencies,
  listDivisions,
  listParties,
  listPublicActivity,
  listPublicLegislation,
  listPublicQuestions,
  listPublicSpeeches,
  listPublicVotes,
  listRepresentatives,
  parseBillListQuery,
  parseDivisionListQuery,
  parsePublicActivityQuery,
  parsePublicLegislationQuery,
  parsePublicListQuery,
  parseRepresentativeListQuery,
} from "./service";
import { cleanupPublicApiFixtures, seedPublicApiFixtures } from "./test-fixtures";

const url = process.env.PUBLIC_API_TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

describeDb("public API against a real database", () => {
  const database = postgres(url ?? "postgresql://unused", { max: 1, prepare: false, transform: { undefined: null } });
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    Object.assign(ids, await seedPublicApiFixtures(database));
  });

  afterAll(async () => {
    await cleanupPublicApiFixtures(database);
    await database.end({ timeout: 5 });
  });

  it("gives every vote row a unique id and its division id, with a readable title", async () => {
    const { votes } = await listPublicVotes(parsePublicListQuery({ representative: "t-jane-murphy" }), database);
    expect(votes).toHaveLength(2);
    expect(new Set(votes.map((vote) => vote.id)).size).toBe(2);
    const empty = votes.find((vote) => vote.divisionId === ids.vote_1)!;
    expect(empty.id).toBe(`${ids.vote_1}:t-jane-murphy`);
    expect(empty.title).toBe("Amendment put — Housing Bill 2026: Report Stage");
    expect(empty.participation).toBe("Tá");
    expect(empty.sourceUrl).toBe("https://www.oireachtas.ie/en/debates/vote/dail/34/2026-09-29/1/");
    expect(votes.find((vote) => vote.divisionId === ids.vote_2)!.title).toBe("That the Bill be now read a Second Time");
  });

  it("pages with an opaque cursor without gaps or repeats", async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await listPublicVotes(parsePublicListQuery({ limit: "1", ...(cursor ? { cursor } : {}) }), database);
      seen.push(...page.votes.map((vote) => vote.id));
      expect(page.has_more).toBe(page.next_cursor !== null);
      expect(page.meta.count).toBe(page.votes.length);
      cursor = page.next_cursor ?? undefined;
      pages += 1;
    } while (cursor && pages < 10);
    expect(seen).toHaveLength(4);
    expect(new Set(seen).size).toBe(4);
    // newest division first
    expect(seen[0]!.startsWith(ids.vote_2!)).toBe(true);
  });

  it("matches search input literally, so % and _ are not wildcards", async () => {
    expect((await listPublicSpeeches(parsePublicListQuery({ q: "%" }), database)).speeches).toHaveLength(1); // "100%" appears once
    expect((await listPublicSpeeches(parsePublicListQuery({ q: "100% sure" }), database)).speeches).toHaveLength(1);
    expect((await listPublicSpeeches(parsePublicListQuery({ q: "_" }), database)).speeches).toHaveLength(1); // "50_000"
    expect((await listPublicSpeeches(parsePublicListQuery({ q: "zzz" }), database)).speeches).toHaveLength(0);
    expect((await listPublicVotes(parsePublicListQuery({ q: "%" }), database)).votes).toHaveLength(0);
    expect((await listPublicVotes(parsePublicListQuery({ q: "housing bill" }), database)).votes).toHaveLength(4);
    expect((await listPublicLegislation(parsePublicLegislationQuery({ q: "_" }), database)).legislation).toHaveLength(0);
  });

  it("rejects unknown parameters and bad values with per-field issues", () => {
    expect.assertions(4);
    try {
      parsePublicListQuery({ nonsense: "1", limit: "500" });
    } catch (error) {
      expect(error).toBeInstanceOf(PublicApiValidationError);
      const fields = (error as PublicApiValidationError).fields.map((entry) => entry.field);
      expect(fields).toContain("nonsense");
      expect(fields).toContain("limit");
    }
    expect(() => parsePublicLegislationQuery({ representative: "x" })).toThrow(PublicApiValidationError);
  });

  it("returns one row per division with tallies and a public division link", async () => {
    const { data, meta } = await listDivisions(parseDivisionListQuery({ q: "housing" }), database);
    expect(data.map((entry) => entry.id)).toEqual([ids.vote_2, ids.vote_1]);
    expect(data[0]).toMatchObject({
      house: "Dáil",
      outcome: "Carried",
      tallies: { ta: 1, nil: 2, staon: 0 },
      sourceUrl: "https://www.oireachtas.ie/en/debates/vote/dail/34/2026-09-30/2/",
    });
    expect(meta.licence.name).toContain("PSI");
    const page1 = await listDivisions(parseDivisionListQuery({ limit: "1" }), database);
    expect(page1.meta.has_more).toBe(true);
    const page2 = await listDivisions(parseDivisionListQuery({ limit: "1", cursor: page1.meta.next_cursor! }), database);
    expect(page2.data[0]!.id).toBe(ids.vote_1);
    expect(page2.meta.has_more).toBe(false);
    expect((await listDivisions(parseDivisionListQuery({ outcome: "lost" }), database)).data).toHaveLength(1);
    expect((await listDivisions(parseDivisionListQuery({ representative: "t-old-td" }), database)).data).toHaveLength(0);
  });

  it("gives a division's party breakdown and, on request, each member's vote", async () => {
    const { data } = await getDivision(ids.vote_2!, { includeMembers: true }, database);
    expect(data.partyBreakdown).toEqual(expect.arrayContaining([
      { party: "Fianna Fáil", ta: 1, nil: 0, staon: 0 },
      { party: "Sinn Féin", ta: 0, nil: 1, staon: 0 },
    ]));
    expect(data.members?.map((member) => [member.representative.id, member.vote])).toEqual([
      ["t-jane-murphy", "Tá"],
      ["t-sean-byrne", "Níl"],
    ]);
    expect((await getDivision(ids.vote_2!, {}, database)).data.members).toBeUndefined();
    await expect(getDivision("not-a-uuid", {}, database)).rejects.toMatchObject({ status: 404 });
    await expect(getDivision("00000000-0000-4000-8000-000000000000", {}, database)).rejects.toMatchObject({ status: 404 });
  });

  it("returns the full question with its answer as plain text", async () => {
    const { data } = await getQuestion(ids.question!, database);
    expect(data).toMatchObject({ number: 77, type: "oral", department: "Department of Housing", title: "Housing Policy" });
    expect(data.answer).toBe("The Minister said 10,000 homes.\n\nMore & more.");
    expect(data.sourceUrl).toBe("https://www.oireachtas.ie/en/debates/question/2026-09-30/77/");
    expect(data.asker.id).toBe("t-jane-murphy");
    const list = await listPublicQuestions(parsePublicListQuery({ q: "social homes" }), database);
    expect(list.questions).toHaveLength(1);
  });

  it("titles speeches by their debate section and serves the full text", async () => {
    const { speeches } = await listPublicSpeeches(parsePublicListQuery({}), database);
    expect(speeches[0]!.title).toBe("Housing Delivery Statements");
    const { data } = await getSpeech(ids.speech!, database);
    expect(data).toMatchObject({ section: "Housing Delivery Statements", debate: "34th Dáil debate — 2026-10-01" });
    expect(data.text).toContain("50_000");
  });

  it("lists bills and gives stages, debates and documents on the detail route", async () => {
    const list = await listBills(parseBillListQuery({ year: "2026", q: "housing" }), database);
    expect(list.data[0]).toMatchObject({ id: "2026/9042", status: "Current", sourceUrl: "https://www.oireachtas.ie/en/bills/bill/2026/9042/" });
    const { data } = await getBill("2026", "9042", database);
    expect(data.sponsors).toEqual(["Minister for Housing"]);
    expect(data.stages.map((stage) => stage.stage)).toEqual(["Second Stage", "Report Stage"]);
    expect(data.debates[0]!.url).toBe("https://www.oireachtas.ie/en/debates/debate/dail/2026-10-01/#dbsect_13");
    expect(data.documents[0]).toMatchObject({ label: "As initiated", pdfUrl: "https://data.oireachtas.ie/doc/1.pdf" });
    await expect(getBill("2026", "1", database)).rejects.toMatchObject({ status: 404 });
  });

  it("serves representatives, parties and constituencies", async () => {
    const all = await listRepresentatives(parseRepresentativeListQuery({ party: "Fianna Fáil" }), database);
    expect(all.representatives.map((rep) => rep.id)).toContain("t-jane-murphy");
    expect((await listRepresentatives(parseRepresentativeListQuery({ status: "former" }), database)).representatives.map((rep) => rep.id)).toContain("t-old-td");
    expect((await listRepresentatives(parseRepresentativeListQuery({ constituency: "dublin bay north" }), database)).representatives.map((rep) => rep.id)).toContain("t-sean-byrne");
    const { data } = await getRepresentative("t-jane-murphy", database);
    expect(data.record).toMatchObject({ divisions: 2, votedIn: 2, ta: 2, questions: 1 });
    expect(data.sourceUrl).toBe("https://www.oireachtas.ie/en/members/member/T-Jane-Murphy/");
    await expect(getRepresentative("nobody", database)).rejects.toMatchObject({ status: 404 });
    expect((await listParties(database)).data.find((party) => party.id === "fianna-fail")?.members).toBeGreaterThanOrEqual(1);
    expect((await listConstituencies(database)).data.find((entry) => entry.id === "kerry")).toBeUndefined(); // former members are excluded
  });

  it("merges every source in the activity feed and paginates across them", async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const result = await listPublicActivity(parsePublicActivityQuery({ limit: "2", ...(cursor ? { cursor } : {}) }), database);
      seen.push(...result.items.map((item) => `${item.type}:${item.id}`));
      cursor = result.next_cursor ?? undefined;
      if (!cursor) break;
    }
    expect(new Set(seen).size).toBe(seen.length);
    for (const type of ["vote:", "question:", "speech:", "legislation:"]) {
      expect(seen.some((entry) => entry.startsWith(type))).toBe(true);
    }
    const onlyBills = await listPublicActivity(parsePublicActivityQuery({ type: "legislation" }), database);
    expect(onlyBills.items.every((item) => item.type === "legislation")).toBe(true);
  });
});
