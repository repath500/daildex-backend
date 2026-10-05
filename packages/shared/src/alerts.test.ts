import { describe, expect, it } from "vitest";
import { alertAgentDecisionSchema, alertDraftSchema } from "./alerts";

const valid = {
  eventType: "vote",
  headline: "TD votes on housing motion",
  summary: "The representative voted Tá on the motion.",
  explanation: "The division concerned a housing motion recorded in the Dáil.",
  topicTags: ["housing"],
  sourceLabel: "Houses of the Oireachtas division record",
  importanceScore: 0.6,
  confidence: 0.95,
};

describe("alertDraftSchema", () => {
  it("accepts a bounded factual draft", () => {
    expect(alertDraftSchema.parse(valid)).toMatchObject({ eventType: "vote" });
  });

  it("rejects character judgments and oversized headlines", () => {
    expect(() => alertDraftSchema.parse({ ...valid, summary: "The vote exposed a hypocrite." })).toThrow();
    expect(() => alertDraftSchema.parse({ ...valid, headline: "one two three four five six seven eight nine ten eleven twelve thirteen" })).toThrow();
    expect(() => alertDraftSchema.parse({ ...valid, unexpected: "extra key" })).toThrow();
  });

  it("keeps agent outcomes strict and bounded", () => {
    expect(alertAgentDecisionSchema.parse({ outcome: "skip", reason: "Routine procedural record." })).toMatchObject({ outcome: "skip" });
    expect(() => alertAgentDecisionSchema.parse({ outcome: "skip", unexpected: true })).toThrow();
    expect(() => alertAgentDecisionSchema.parse({ outcome: "merge", mergeAlertId: "not-a-uuid" })).toThrow();
  });
});

describe("characterization ban", () => {
  const draft = (explanation: string) => alertDraftSchema.safeParse({ ...valid, explanation }).success;

  it("still rejects the loaded words, including their endings", () => {
    for (const word of ["lied", "Lied", "liar", "liars", "betrayed", "corrupt", "corruption", "exposed", "hypocrite", "caught out"]) {
      expect(draft(`The record says the Minister ${word} to the public.`)).toBe(false);
    }
  });

  it("does not reject ordinary words that merely contain them", () => {
    for (const word of ["replied", "applied", "implied", "complied", "supplied", "relied", "allied", "familiar", "multiplied"]) {
      expect(draft(`The Minister ${word} in the Dáil on Tuesday.`)).toBe(true);
    }
  });
});
