import { describe, expect, it } from "vitest";
import {
  alertDailyEmailCap,
  evaluateAutoPublish,
  importantAlertThreshold,
  type AutoPublishCandidate,
} from "./service";

const now = new Date("2026-09-27T12:00:00Z");
const vote: AutoPublishCandidate = {
  eventType: "vote",
  headline: "Dáil carries energy policy motion",
  summary: "The motion was carried.",
  explanation: "The record shows Denise Mitchell voted against the motion as amended. The motion was carried.",
  sourceUrl: "https://data.oireachtas.ie/akn/ie/debateRecord/dail/2026-09-23/debate/main",
  confidence: 0.9,
  representativeName: "Denise Mitchell",
  participation: "Níl",
  eventDate: "2026-09-25",
};

describe("auto-publishing alert drafts", () => {
  it("approves a sourced, consistent, recent draft", () => {
    expect(evaluateAutoPublish(vote, now)).toEqual({ decision: "approve" });
  });

  it("holds a draft whose stated vote contradicts the record", () => {
    const result = evaluateAutoPublish({ ...vote, participation: "Tá" }, now);
    expect(result).toMatchObject({ decision: "hold", reasons: [expect.stringContaining("Tá")] });
  });

  it("holds low confidence, unofficial sources, links and unnamed representatives", () => {
    expect(evaluateAutoPublish({ ...vote, confidence: 0.5 }, now).decision).toBe("hold");
    expect(evaluateAutoPublish({ ...vote, sourceUrl: "https://example.com/vote" }, now).decision).toBe("hold");
    expect(evaluateAutoPublish({ ...vote, sourceUrl: "http://data.oireachtas.ie/x" }, now).decision).toBe("hold");
    expect(evaluateAutoPublish({ ...vote, summary: "See www.example.com" }, now).decision).toBe("hold");
    expect(evaluateAutoPublish({ ...vote, representativeName: "Mary Butler" }, now).decision).toBe("hold");
  });

  it("matches names regardless of apostrophe style", () => {
    const draft = { ...vote, representativeName: "Cian O'Callaghan", explanation: "Cian O’Callaghan voted against it." };
    expect(evaluateAutoPublish(draft, now)).toEqual({ decision: "approve" });
  });

  it("expires records too old to be news instead of sending them late", () => {
    expect(evaluateAutoPublish({ ...vote, eventDate: "2026-09-01" }, now).decision).toBe("expire");
    expect(evaluateAutoPublish({ ...vote, eventDate: "2026-09-23" }, now).decision).toBe("expire");
  });

  it("does not apply vote checks to parliamentary questions", () => {
    const question = { ...vote, eventType: "pq", participation: "asked", explanation: "Denise Mitchell asked the Minister for Health about waiting lists." };
    expect(evaluateAutoPublish(question, now)).toEqual({ decision: "approve" });
  });
});

describe("delivery limits", () => {
  it("defaults to a threshold the drafting model actually reaches, and a daily cap", () => {
    expect(importantAlertThreshold(undefined)).toBe(0.3);
    expect(importantAlertThreshold("0.4")).toBe(0.4);
    expect(importantAlertThreshold("7")).toBe(0.3);
    expect(alertDailyEmailCap(undefined)).toBe(5);
    expect(alertDailyEmailCap("0")).toBe(5);
    expect(alertDailyEmailCap("12")).toBe(12);
  });
});
