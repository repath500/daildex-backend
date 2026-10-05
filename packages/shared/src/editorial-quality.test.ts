import { describe, expect, it } from "vitest";
import { EDITORIAL_FACETS, editorialFeaturedNames, editorialFormatForBrief, evaluateEditorialQuality, type EditorialResearchBrief } from "./editorial-quality";
import type { EditorialFinal } from "./editorial";

describe("evidence-led article depth", () => {
  const brief = (count: number, facets = [...EDITORIAL_FACETS]): EditorialResearchBrief => ({ facts: Array.from({ length: count }, (_, i) => ({
    facet: facets[i % facets.length], text: `Distinct fact ${i}`, sourceUrl: "https://oireachtas.ie/record", excerpt: "An exact supported passage from the official record.",
  })), missingFacets: [], followUpQueries: [] });
  it("keeps thin or incomplete evidence in a brief", () => {
    expect(editorialFormatForBrief(brief(3))).toBe("brief");
    expect(editorialFormatForBrief(brief(20, ["event", "background", "impact", "response"]))).toBe("brief");
  });
  it("promotes coverage with distinct supported facts", () => {
    expect(editorialFormatForBrief(brief(10))).toBe("article");
    expect(editorialFormatForBrief(brief(20))).toBe("explainer");
  });
  it("does not inflate depth for repeated facts", () => {
    const repeated = brief(20); repeated.facts.forEach((fact) => { fact.text = "One repeated fact"; });
    expect(editorialFormatForBrief(repeated)).toBe("brief");
  });
  it("flags thin output and repeated paragraphs independently of model approval", () => {
    const text = "This paragraph explains the official event but repeats the same information without adding any useful detail.";
    const post = { format: "article", sections: [{ heading: "Record", purpose: "event", paragraphs: [text, text], sourceUrls: ["https://oireachtas.ie/record"] }], sources: [] } as unknown as EditorialFinal;
    const result = evaluateEditorialQuality(post);
    expect(result.repeatedParagraphs).toBe(1);
    expect(result.issues).toHaveLength(2);
  });
  it("features only people named in the article, including bullets", () => {
    const post = { title: "Transport debate", description: "Mary Murphy spoke.", sections: [{ paragraphs: [], bullets: ["John Smith asked about access."] }] } as unknown as EditorialFinal;
    expect(editorialFeaturedNames(post, ["Mary Murphy", "Absent Voter", "John Smith", "Mary Murphy"])).toEqual(["Mary Murphy", "John Smith"]);
  });
});
