import { describe, expect, it, vi } from "vitest";
import { foldText, resetOfficialDataCache, searchOfficialOireachtas, voteTitle } from "./service";

describe("official record search bounds", () => {
  it("rejects impossible calendar dates before making a request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(searchOfficialOireachtas({
      resource: "votes",
      dateStart: "2026-02-30",
      dateEnd: "2026-03-01",
      chamber: "dail",
    })).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("rejects a date range wider than 120 days", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(searchOfficialOireachtas({
      resource: "debates",
      dateStart: "2025-01-01",
      dateEnd: "2026-03-01",
      chamber: "dail",
    })).rejects.toThrow("120 days");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

function memberFixture(first: string, last: string, party: string, seat = "Cork South-Central") {
  const code = `${first}-${last}.D.2020-02-20`;
  return {
    member: {
      memberCode: code,
      fullName: `${first} ${last}`,
      showAs: `${first} ${last}`,
      uri: `https://data.oireachtas.ie/ie/oireachtas/member/id/${code}`,
      memberships: [{
        membership: {
          house: { houseNo: "34" },
          parties: [{ party: { showAs: party } }],
          represents: [{ represent: { showAs: seat } }],
        },
      }],
    },
  };
}

function voter(first: string, last: string) {
  const code = `${first}-${last}.D.2020-02-20`;
  return { member: { showAs: `${last}, ${first}.`, memberCode: code } };
}

function division(date: string, voteNo: number, ta: Array<[string, string]>, nil: Array<[string, string]>) {
  return {
    division: {
      date,
      datetime: `${date}T15:00:00+01:00`,
      outcome: "Carried",
      uri: `https://data.oireachtas.ie/ie/oireachtas/division/house/dail/34/${date}/vote_${voteNo}`,
      subject: { showAs: `Motion ${voteNo}` },
      tallies: {
        taVotes: { tally: ta.length, members: ta.map(([f, l]) => voter(f, l)) },
        nilVotes: { tally: nil.length, members: nil.map(([f, l]) => voter(f, l)) },
        staonVotes: { tally: 0, members: [] },
      },
    },
  };
}

describe("member-aware votes lookup", () => {
  const members = [
    memberFixture("Micheál", "Martin", "Fianna Fáil"),
    memberFixture("Jim", "O'Callaghan", "Fianna Fáil"),
    memberFixture("Mary", "Lou", "Sinn Féin"),
  ];
  const divisions = [
    division("2026-09-29", 205, [["Mary", "Lou"]], [["Micheál", "Martin"]]),
    division("2026-09-23", 190, [["Micheál", "Martin"], ["Mary", "Lou"]], [["Jim", "O'Callaghan"]]),
    division("2026-09-20", 180, [["Mary", "Lou"]], []),
  ];

  function mockApi() {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      const body = url.pathname.endsWith("/members")
        ? { head: { counts: { memberCount: members.length } }, results: members }
        : { head: { counts: { divisionCount: divisions.length } }, results: divisions };
      return new Response(JSON.stringify(body), { status: 200 });
    });
  }

  it("finds a member's votes despite surname-first names and accents, with the party split", async () => {
    resetOfficialDataCache();
    const spy = mockApi();
    const result = await searchOfficialOireachtas({
      resource: "votes",
      member: "Micheal Martin",
      dateStart: "2026-06-03",
      dateEnd: "2026-09-30",
      chamber: "dail",
    });
    spy.mockRestore();
    expect(result.member?.name).toBe("Micheál Martin");
    expect(result.member?.divisionsVoted).toBe(2);
    expect(result.records[0]).toMatchObject({ date: "2026-09-29", memberVote: "Níl" });
    const split = (result.records[0] as { partySplit?: { party: string; dissenters: Array<{ name: string; vote: string }> } }).partySplit;
    expect(split?.party).toBe("Fianna Fáil");
    expect(split?.dissenters).toEqual([]);
    const second = (result.records[1] as { partySplit?: { dissenters: Array<{ name: string; vote: string }> } }).partySplit;
    expect(second?.dissenters).toEqual([{ name: "Jim O'Callaghan", vote: "Níl" }]);
  });

  it("explains an unknown member instead of returning a silent empty list", async () => {
    resetOfficialDataCache();
    const spy = mockApi();
    const result = await searchOfficialOireachtas({ resource: "votes", member: "Nobody Atall", dateStart: "2026-06-03", dateEnd: "2026-09-30", chamber: "dail" });
    spy.mockRestore();
    expect(result.records).toHaveLength(0);
    expect(result.note).toMatch(/No sitting Dáil member matched/);
  });

  it("searches members by name, party or constituency", async () => {
    resetOfficialDataCache();
    const spy = mockApi();
    const result = await searchOfficialOireachtas({ resource: "members", query: "fianna fail", chamber: "dail" });
    spy.mockRestore();
    expect(result.records.map((record) => (record as { name: string }).name)).toEqual(["Micheál Martin", "Jim O'Callaghan"]);
  });
});

describe("foldText", () => {
  it("removes accents, punctuation and case", () => {
    expect(foldText("Martin, Micheál.")).toBe("martin micheal");
  });
});

describe("voteTitle", () => {
  it("borrows the debate title when the subject is only 'Amendment put:'", () => {
    expect(voteTitle("Amendment put: ", "Housing Bill 2026: Committee Stage")).toBe("Housing Bill 2026: Committee Stage (amendment)");
    expect(voteTitle("Question put:", "Order of Business")).toBe("Order of Business (question)");
    expect(voteTitle('Question put: "That the Bill be read a Second Time"', "Housing Bill")).toBe('Question put: "That the Bill be read a Second Time"');
    expect(voteTitle(undefined, undefined)).toBeUndefined();
  });
});
