import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { alertRecentDays } from "./service";

describe("alert claiming", () => {
  it("defaults to a two-week window and stays bounded", () => {
    expect(alertRecentDays(undefined)).toBe(3);
    expect(alertRecentDays("30")).toBe(30);
    expect(alertRecentDays("0")).toBe(3);
    expect(alertRecentDays("5000")).toBe(365);
  });

  it("only claims recent events for representatives an active subscriber follows", () => {
    const source = readFileSync(new URL("./service.ts", import.meta.url), "utf8");
    expect(source).toContain("subscriber.status = 'active'");
    expect(source).toContain("make_interval(days => ${alertRecentDays()})");
    expect(source).toContain("FOR UPDATE OF target SKIP LOCKED");
    // Backfilled votes are dated by their division, not by when they were fetched.
    expect(source).toContain("(source_event.raw_payload #>> '{division,date}')::DATE");
  });
});
