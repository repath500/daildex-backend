import { describe, expect, it } from "vitest";
import type { EditorialFinal, EditorialStoryCandidate } from "@daildex/shared";
import { withSupplyingRecord } from "./editorial-generate";

const record = "https://www.oireachtas.ie/en/debates/debate/dail/2026-09-24/12/";

const story = {
  origin: "parliamentary",
  subject: "Waste Management Bill 2026: Second Stage",
  primaryUrls: [{ url: record, publisher: "Houses of the Oireachtas", kind: "official" }],
} as unknown as EditorialStoryCandidate;

const output = {
  title: "Dáil defeats waste collection Bill",
  description: "The Bill was defeated.",
  period: { start: "2026-09-24", end: "2026-09-26" },
  sections: [{ heading: "What happened", paragraphs: ["It was defeated."], sourceUrls: ["https://www.rte.ie/news/x"] }],
  sources: [{ url: "https://www.rte.ie/news/x", title: "RTÉ", publisher: "RTÉ", kind: "reporting" }],
  disclosure: "d",
  verification: { passed: true, issues: [], checkedAt: "2026-09-26T18:00:00.000Z", checks: [] },
} as EditorialFinal;

describe("withSupplyingRecord", () => {
  it("attaches the Oireachtas record when the draft dropped it", () => {
    const fixed = withSupplyingRecord(output, story);
    expect(fixed.sources[0]).toMatchObject({ url: record, kind: "official" });
    expect(fixed.sections[0].sourceUrls[0]).toBe(record);
  });

  it("leaves drafts that already cite the record alone", () => {
    const cited = { ...output, sources: [{ url: `${record}?utm_source=x`, title: "r", publisher: "Houses of the Oireachtas", kind: "official" as const }] };
    expect(withSupplyingRecord(cited, story)).toBe(cited);
  });

  it("does nothing for non-parliamentary stories", () => {
    expect(withSupplyingRecord(output, { ...story, origin: "reported" } as EditorialStoryCandidate)).toBe(output);
  });
});
