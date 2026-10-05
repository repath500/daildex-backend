import { describe, expect, it } from "vitest";
import { normalizeVote, normalizeQuestion, normalizeDebate } from "./normalize";

describe("substantive parliamentary passages", () => {
  it("uses the API's readable XML link rather than its protected record identifier", () => {
    const xml = "https://data.oireachtas.ie/akn/ie/debateRecord/dail/2026-09-30/debate/mul@/dbsect_12.xml";
    const result = normalizeQuestion({ question: { date: "2026-09-30", showAs: "What happens next?", answerText: "The confirmed answer.",
      debateSection: { showAs: "Transport funding", uri: "https://data.oireachtas.ie/akn/ie/debateRecord/dail/2026-09-30/debate/dbsect_12", formats: { xml: { uri: xml } } } } });
    expect(result?.url).toBe(xml);
    expect(result?.passages?.every((passage) => passage.url === xml)).toBe(true);
  });
  it("preserves the question and answer with their exact official URL", () => {
    const result = normalizeQuestion({ question: { date: "2026-09-30", uri: "https://oireachtas.ie/question/1",
      showAs: "What funding is available for the harbour route?", answerText: "The minister confirmed funding of €2 million for the route.",
      by: { showAs: "Example Deputy", memberCode: "Example-Deputy" }, debateSection: { showAs: "Transport funding" } } });
    expect(result?.passages?.map((passage) => passage.role)).toEqual(["question", "answer"]);
    expect(result?.passages?.[1].text).toContain("€2 million");
    expect(result?.participants[0].memberCode).toBe("Example-Deputy");
  });
  it("keeps each speech attached to its official speaker", () => {
    const records = normalizeDebate({ debateRecord: { date: "2026-09-30", debateSections: [{ debateSection: {
      uri: "https://oireachtas.ie/debate/1", showAs: "Transport funding", text: [{ speaker: { showAs: "Example Minister", memberCode: "Example-Minister" }, text: "The funding is approved." }],
    } }] } });
    expect(records[0].passages?.[0]).toMatchObject({ speaker: "Example Minister", text: "The funding is approved.", role: "speech" });
  });
});

function division(subject: string, debate = "Planning and Development (Amendment) Bill 2026: Second Stage") {
  return {
    division: {
      uri: "https://data.oireachtas.ie/ie/oireachtas/division/house/dail/34/2026-09-24/vote_12",
      date: "2026-09-24",
      outcome: "Carried",
      subject: { showAs: subject },
      debate: { showAs: debate, uri: "https://www.oireachtas.ie/en/debates/debate/dail/2026-09-24/12/" },
    },
  };
}

describe("normalizeVote", () => {
  it("names the Bill when the division subject is procedural", () => {
    const record = normalizeVote(division('Question put: "That the Bill be now read a Second Time"'));
    expect(record?.subject).toBe("Planning and Development (Amendment) Bill 2026: Second Stage");
    expect(record?.outcome).toBe('Question put: "That the Bill be now read a Second Time": Carried');
    expect(normalizeVote(division("Amendment put:"))?.subject).toContain("Planning and Development");
  });

  it("keeps a descriptive subject", () => {
    const record = normalizeVote(division("Motion re: Housing Emergency", "Private Members' Business"));
    expect(record?.subject).toBe("Motion re: Housing Emergency");
    expect(record?.outcome).toBe("Carried");
  });

  it("carries official totals and labels each vote with its question", () => {
    const input = division("Amendment put:", "Neutrality and Triple Lock: Motion (Resumed) [Private Members]");
    Object.assign(input.division, {
      tallies: {
        taVotes: { members: [{ member: { showAs: "Roderic O'Gorman" } }, { member: { showAs: "Mary Murphy" } }] },
        nilVotes: { members: [{ member: { showAs: "Seán Ó Briain" } }] },
      },
    });
    const record = normalizeVote(input);
    expect(record?.outcome).toBe("Amendment put: Carried (Tá 2, Níl 1)");
    expect(record?.participants).toContainEqual({ name: "Roderic O'Gorman", party: null, participation: "Tá on Amendment put" });
  });
});
