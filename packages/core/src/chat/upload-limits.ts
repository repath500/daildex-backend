/** Free readers: two files per chat and ten distinct files in any rolling week. Pro has no limit. */
export const FREE_UPLOADS_PER_CHAT = 2;
export const FREE_UPLOADS_PER_WEEK = 10;
export const UPLOAD_WINDOW_DAYS = 7;

export type UploadAllowance = {
  unlimited: boolean;
  weeklyLimit: number | null;
  usedThisWeek: number;
  /** Null when unlimited. */
  remainingThisWeek: number | null;
  perChatLimit: number | null;
};

export function uploadAllowance(pro: boolean, usedThisWeek: number): UploadAllowance {
  return pro
    ? { unlimited: true, weeklyLimit: null, usedThisWeek, remainingThisWeek: null, perChatLimit: null }
    : {
        unlimited: false,
        weeklyLimit: FREE_UPLOADS_PER_WEEK,
        usedThisWeek,
        remainingThisWeek: Math.max(0, FREE_UPLOADS_PER_WEEK - usedThisWeek),
        perChatLimit: FREE_UPLOADS_PER_CHAT,
      };
}
