/**
 * Launch week: every signed-in Dex account gets Dex Pro for free, from the
 * start date to the end date below (Ireland, IST, UTC+1).
 */
export const LAUNCH_PRO_WEEK = {
  code: "launch-pro-week-2026-09",
  startsAt: new Date("2026-09-29T00:00:00+01:00"),
  endsAt: new Date("2026-10-05T23:59:59+01:00"),
  startsLabel: "Tuesday 29 September 2026",
  endsLabel: "Monday 5 October 2026",
} as const;

export function isLaunchProWeekActive(now = new Date()) {
  return now >= LAUNCH_PRO_WEEK.startsAt && now <= LAUNCH_PRO_WEEK.endsAt;
}

/** Launch-week Pro needs a real sign-in, so it never reaches anonymous passes. */
export function hasLaunchProAccess(row: { auth_subject: string | null }, now = new Date()) {
  return Boolean(row.auth_subject) && isLaunchProWeekActive(now);
}
