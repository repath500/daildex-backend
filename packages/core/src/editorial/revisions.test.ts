import { describe, expect, it } from "vitest";
import { editorialStoryKey } from "@daildex/shared";
import { editorialBenchmarkCases } from "@daildex/shared/editorial-benchmark";
import { recoverLegacyEditorialCandidate } from "./revisions";

describe("legacy editorial event recovery", () => {
  const row = { storyKey: editorialStoryKey("policy_announcement", "harbour transport", "2026-09-30"), subject: "Harbour transport",
    normalizedSubject: "harbour transport", storyKind: "policy_announcement", storyOrigin: "government", sourceKey: null,
    participantNames: [], periodStart: "2026-09-28", periodEnd: "2026-09-30" };
  it("recovers the original date from the stored story key rather than guessing from prose", () => {
    const result = recoverLegacyEditorialCandidate(row, editorialBenchmarkCases[0].post);
    expect(result).toMatchObject({ occurredOn: "2026-09-30", origin: "government", subject: "Harbour transport" });
    expect(result?.primaryUrls).toHaveLength(1);
  });
  it("refuses an identity that cannot prove its date", () => {
    expect(recoverLegacyEditorialCandidate({ ...row, storyKey: "unknown" }, editorialBenchmarkCases[0].post)).toBeNull();
  });
  it("requires parliamentary candidates to come from the official API", () => {
    expect(recoverLegacyEditorialCandidate({ ...row, storyOrigin: "parliamentary" }, editorialBenchmarkCases[0].post)).toBeNull();
  });
});
