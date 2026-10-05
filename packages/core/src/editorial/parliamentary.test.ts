import { describe, expect, it } from "vitest";
import type { NormalizedParliamentaryRecord } from "../oireachtas/types";
import { discoverParliamentaryStories, EditorialDiscoveryError, groupParliamentaryRecords } from "./parliamentary";

function record(overrides: Partial<NormalizedParliamentaryRecord>): NormalizedParliamentaryRecord {
  return {
    kind: "vote",
    subject: "Residential Tenancies Bill 2026",
    date: "2026-09-16",
    outcome: "Carried",
    sourceKey: "vote-1",
    url: "https://www.oireachtas.ie/en/debates/vote/1",
    participants: [{ name: "Mary Murphy", party: null, participation: "Tá" }],
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("parliamentary discovery", () => {
  it("joins votes to speeches by exact section identity, including the chamber", async () => {
    const uri = "https://data.oireachtas.ie/akn/ie/debateRecord/dail/2026-09-30/debate";
    const xml = `${uri}/mul@/dbsect_12.xml`;
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/questions") || url.searchParams.get("chamber") === "seanad") return jsonResponse({ results: [] });
      if (url.pathname.endsWith("/votes")) return jsonResponse({ results: [{ division: { date: "2026-09-30", outcome: "Carried",
        subject: { showAs: "Transport funding" }, debate: { uri: `${uri}/main`, debateSection: "dbsect_12" } } }] });
      return jsonResponse({ results: [{ debateRecord: { date: "2026-09-30", debateSections: [
        { debateSection: { uri: `${uri}/dbsect_12`, showAs: "Transport funding", formats: { xml: { uri: xml } },
          text: [{ speaker: { showAs: "Example Minister" }, text: "The route will be reviewed next month." }] } },
        { debateSection: { uri: uri.replace("/dail/", "/seanad/") + "/dbsect_12", showAs: "Unrelated business",
          text: [{ speaker: { showAs: "Other Speaker" }, text: "An unrelated statement." }] } },
      ] } }] });
    };
    const stories = await discoverParliamentaryStories("2026-09-30", "2026-09-30", fetchImpl);
    const vote = stories.find((story) => story.kind === "vote");
    expect(vote?.primaryUrls[0].url).toBe(xml);
    expect(vote?.passages?.[0]).toMatchObject({ speaker: "Example Minister", text: "The route will be reviewed next month." });
  });
  it("groups three TDs on the same subject and date into one candidate", () => {
    const grouped = groupParliamentaryRecords([
      record({ participants: [{ name: "Mary Murphy", party: null, participation: "Tá" }] }),
      record({ participants: [{ name: "Mary Murphy", party: null, participation: "Tá" }] }),
      record({ participants: [{ name: "John Smith", party: "Example", participation: "Níl" }] }),
    ]);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]?.participants.map((participant) => participant.name)).toEqual(["John Smith", "Mary Murphy"]);
    expect(grouped[0]?.primaryUrls[0]?.publisher).toBe("Houses of the Oireachtas");
  });

  it("keeps a question and a debate with different subjects apart", () => {
    const grouped = groupParliamentaryRecords([
      record({ kind: "question", subject: "Hospital waiting lists", outcome: null, url: "https://www.oireachtas.ie/questions/1" }),
      record({ kind: "debate", subject: "Housing supply", outcome: null, url: "https://www.oireachtas.ie/debates/1" }),
    ]);
    expect(grouped).toHaveLength(2);
  });

  it("drops procedural business", () => {
    expect(groupParliamentaryRecords([
      record({ subject: "Order of Business" }),
    ])).toEqual([]);
  });

  it("returns no stories when every category is empty", async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse({ results: [] });
    await expect(discoverParliamentaryStories("2026-09-14", "2026-09-20", fetchImpl)).resolves.toEqual([]);
  });

  it("fails closed when votes cannot be retrieved", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("/votes")) return jsonResponse({ message: "nope" }, 500);
      return jsonResponse({ results: [] });
    };
    await expect(discoverParliamentaryStories("2026-09-14", "2026-09-20", fetchImpl)).rejects.toBeInstanceOf(EditorialDiscoveryError);
  });
});
