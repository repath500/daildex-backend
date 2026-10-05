import { describe, expect, it } from "vitest";
import { budgetLiveQueries } from "./budget-live-worker";

describe("budget live queries", () => {
  it("rotates through every topic within an hour of ten-minute runs", () => {
    const start = Date.parse("2026-10-06T12:00:00.000Z");
    const seen = new Set<string>();
    for (let run = 0; run < 6; run += 1) {
      for (const query of budgetLiveQueries(new Date(start + run * 10 * 60 * 1000))) seen.add(query);
    }
    expect(seen.size).toBe(8);
  });

  it("asks two different questions per run", () => {
    const [first, second] = budgetLiveQueries(new Date("2026-10-06T13:05:00.000Z"));
    expect(first).not.toBe(second);
  });
});
