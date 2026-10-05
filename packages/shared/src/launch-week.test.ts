import { describe, expect, it } from "vitest";
import { hasLaunchProAccess, isLaunchProWeekActive, LAUNCH_PRO_WEEK } from "./launch-week";

describe("launch Pro week", () => {
  it("runs from 29 September to the end of 5 October 2026", () => {
    expect(isLaunchProWeekActive(new Date("2026-09-28T22:00:00Z"))).toBe(false);
    expect(isLaunchProWeekActive(new Date("2026-09-29T06:00:00+01:00"))).toBe(true);
    expect(isLaunchProWeekActive(new Date("2026-10-05T23:30:00+01:00"))).toBe(true);
    expect(isLaunchProWeekActive(new Date("2026-10-06T00:00:01+01:00"))).toBe(false);
    expect(LAUNCH_PRO_WEEK.endsAt.getTime() - LAUNCH_PRO_WEEK.startsAt.getTime()).toBeLessThan(7 * 86_400_000);
  });

  it("only unlocks signed-in accounts", () => {
    const during = new Date("2026-10-01T12:00:00Z");
    expect(hasLaunchProAccess({ auth_subject: "auth0|abc" }, during)).toBe(true);
    expect(hasLaunchProAccess({ auth_subject: null }, during)).toBe(false);
    expect(hasLaunchProAccess({ auth_subject: "auth0|abc" }, new Date("2026-10-07T12:00:00Z"))).toBe(false);
  });
});
