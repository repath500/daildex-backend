import { describe, expect, it } from "vitest";
import { flattenVotes, groupDebateContributions, ingestChambers, normalizeMember, normalizeQuestion, slugify, stripMarkup } from "./oireachtas";

describe("Oireachtas normalization", () => {
  it("creates stable representative keys", () => {
    expect(slugify("Pádraig O'Sullivan")).toBe("padraig-osullivan");
    expect(slugify("Peter 'Chap' Cleere")).toBe("peter-chap-cleere");
  });

  it("selects the active Dáil membership", () => {
    expect(
      normalizeMember({
        member: {
          showAs: "Example Member",
          uri: "https://data.oireachtas.ie/ie/oireachtas/member/id/Example-Member.D.2024-01-01",
          memberships: [
            {
              membership: {
                dateRange: { start: "2024-01-01", end: null },
                house: { houseCode: "dail" },
                parties: [{ party: { showAs: "Example Party", dateRange: { end: null } } }],
                represents: [{ represent: { showAs: "Example East" } }],
              },
            },
          ],
        },
      }),
    ).toMatchObject({ key: "example-member", area: "Example East", party: "Example Party" });
  });

  it("selects the active Seanad membership only when asked for the Seanad", () => {
    const senator = {
      member: {
        showAs: "Example Senator",
        uri: "https://data.oireachtas.ie/ie/oireachtas/member/id/Example-Senator.S.2025-02-01",
        memberships: [
          {
            membership: {
              dateRange: { start: "2025-02-01", end: null },
              house: { houseCode: "seanad" },
              parties: [{ party: { showAs: "Example Party", dateRange: { end: null } } }],
              represents: [{ represent: { showAs: "Cultural and Educational Panel" } }],
            },
          },
        ],
      },
    };
    expect(normalizeMember(senator, "seanad")).toMatchObject({ key: "example-senator", area: "Cultural and Educational Panel" });
    expect(normalizeMember(senator)).toBeNull();
  });

  it("ingests the Dáil only unless the Seanad is switched on", () => {
    expect(ingestChambers(undefined)).toEqual(["dail"]);
    expect(ingestChambers("")).toEqual(["dail"]);
    expect(ingestChambers("dail, Seanad")).toEqual(["dail", "seanad"]);
    expect(ingestChambers("seanad,seanad")).toEqual(["seanad"]);
    expect(() => ingestChambers("dail,lords")).toThrow(/lords/);
  });

  it("flattens all official vote buckets", () => {
    expect(
      flattenVotes({
        taVotes: { members: [{ member: { memberCode: "member-a" } }] },
        nilVotes: { members: [{ member: { memberCode: "member-b" } }] },
        staonVotes: { members: [{ member: { memberCode: "member-c" } }] },
      }),
    ).toEqual([
      { participation: "Tá", memberCode: "member-a" },
      { participation: "Níl", memberCode: "member-b" },
      { participation: "Staon", memberCode: "member-c" },
    ]);
  });

  it("normalizes a question only from official member identity", () => {
    expect(normalizeQuestion({
      question: {
        uri: "https://data.oireachtas.ie/ie/oireachtas/question/2026-07-02/pq_2",
        date: "2026-07-02",
        questionNumber: 2,
        questionType: "written",
        showAs: " Deputy Example asked a sourced question. ",
        answerText: " Official answer. ",
        by: {
          showAs: "Deputy Example",
          memberCode: "Example.D.2024-11-29",
          uri: "https://data.oireachtas.ie/ie/oireachtas/member/id/Example.D.2024-11-29",
        },
        debateSection: {
          uri: "https://data.oireachtas.ie/akn/ie/debateRecord/dail/2026-07-02/writtens/dbsect_1",
          debateSectionId: "dbsect_1",
          showAs: "Example topic",
        },
      },
    })).toMatchObject({
      memberCode: "Example.D.2024-11-29",
      questionText: "Deputy Example asked a sourced question.",
      answerText: "Official answer.",
    });
    expect(normalizeQuestion({ question: {
      uri: "https://data.oireachtas.ie/question/1",
      date: "2026-07-02",
      showAs: "Name-only question",
      by: { showAs: "Unverified Name" },
    } })).toBeNull();
  });

  it("groups debate speech by member URI and ignores name-only speakers", () => {
    expect(groupDebateContributions([
      {
        speaker: { showAs: "Verified", memberCode: "verified-1", uri: "https://data.oireachtas.ie/member/verified-1" },
        textType: "speech",
        text: "First contribution.",
      },
      {
        speaker: { showAs: "Unverified", memberCode: null, uri: null },
        textType: "speech",
        text: "Must not be attributed.",
      },
      {
        speaker: { showAs: "Verified", memberCode: "verified-1", uri: "https://data.oireachtas.ie/member/verified-1" },
        textType: "speech",
        text: "Second contribution.",
      },
      { speaker: null, textType: "summary", text: "Summary." },
    ])).toMatchObject([{
      memberCode: "verified-1",
      contributions: [
        { ordinal: 0, text: "First contribution." },
        { ordinal: 2, text: "Second contribution." },
      ],
    }]);
  });

  it("converts official bill title markup into bounded plain text", () => {
    expect(stripMarkup("<p>Bill entitled an Act &amp; related matters.</p>")).toBe("Bill entitled an Act & related matters.");
  });
});
