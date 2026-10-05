import { describe, expect, it } from "vitest";
import {
  budgetLiveFingerprint,
  figuresIn,
  headlineSimilarity,
  validateBudgetLiveDraft,
  type BudgetLiveDraft,
} from "./budget-live";

const URL = "https://www.rte.ie/news/budget-2027/2026/1006/example-pension/";
const PAGE = "Budget 2027 live. The Minister for Finance confirmed that the State pension will rise by €12 a week from January, bringing the contributory rate to €311.30. Opposition parties said it was not enough.";
const pages = new Map([[URL, PAGE]]);
const domains = ["rte.ie", "gov.ie"];

function draft(overrides: Partial<BudgetLiveDraft> = {}): BudgetLiveDraft {
  return {
    kind: "measure",
    headline: "State pension to rise by €12 a week",
    body: "The contributory State pension will rise to €311.30 a week from January, the Minister for Finance confirmed.",
    sources: [{ url: URL, title: "Budget 2027 live", publisher: "RTÉ News" }],
    evidence: [{ url: URL, quote: "the State pension will rise by €12 a week from January, bringing the contributory rate to €311.30" }],
    ...overrides,
  };
}

describe("budget live validation", () => {
  it("accepts a draft whose figures are all quoted from a read page", () => {
    expect(validateBudgetLiveDraft(draft(), pages, domains)).toEqual({ valid: true });
  });

  it("rejects a figure that is not in the evidence", () => {
    const result = validateBudgetLiveDraft(draft({ headline: "State pension to rise by €15 a week" }), pages, domains);
    expect(result.valid).toBe(false);
  });

  it("rejects an altered quote and an unread or unapproved source", () => {
    expect(validateBudgetLiveDraft(draft({
      evidence: [{ url: URL, quote: "the State pension will rise by €15 a week from January, bringing the contributory rate to €311.30" }],
    }), pages, domains).valid).toBe(false);
    expect(validateBudgetLiveDraft(draft({
      sources: [{ url: "https://example.com/budget", title: "x", publisher: "x" }],
    }), pages, domains).valid).toBe(false);
  });

  it("rejects a repeat of a recent headline", () => {
    const result = validateBudgetLiveDraft(draft(), pages, domains, ["State pension will rise by €12 a week"]);
    expect(result).toEqual({ valid: false, issues: ["Repeats an existing update"] });
  });

  it("normalises figures and ignores bare years", () => {
    expect(figuresIn("€1,000 in 2027 and 8.50 or €8.5bn")).toEqual(["1000", "8.5"]);
  });

  it("fingerprints headlines regardless of word order and punctuation", () => {
    expect(budgetLiveFingerprint("Pension up €12!")).toBe(budgetLiveFingerprint("€12 pension up"));
    expect(headlineSimilarity("Carbon tax on heating oil cut", "Heating oil carbon tax cut")).toBe(1);
  });
});
