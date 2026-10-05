import { describe, expect, it } from "vitest";
import { parsePolicyManifest } from "./policy";

const valid = {
  version: 1,
  documents: [{
    partyName: "Example Party",
    sourceType: "policy_paper",
    sourceOwner: "Example Party",
    rightsBasis: "Reviewed publication permission",
    title: "Example housing policy",
    sourceUrl: "https://example.test/policy",
    reviewedAt: "2026-07-06T00:00:00Z",
    sections: [{ topicTag: "housing", heading: "Housing supply", text: "A sufficiently long reviewed policy section for deterministic ingestion." }],
  }],
};

describe("reviewed policy manifests", () => {
  it("accepts bounded reviewed source metadata", () => {
    expect(parsePolicyManifest(JSON.stringify(valid)).documents[0]?.sections[0]?.topicTag).toBe("housing");
  });

  it("rejects insecure sources and missing rights metadata", () => {
    expect(() => parsePolicyManifest(JSON.stringify({
      ...valid,
      documents: [{ ...valid.documents[0], sourceUrl: "http://example.test/policy" }],
    }))).toThrow();
    const withoutRights = { ...valid.documents[0], rightsBasis: undefined };
    expect(() => parsePolicyManifest(JSON.stringify({ ...valid, documents: [withoutRights] }))).toThrow();
  });
});
