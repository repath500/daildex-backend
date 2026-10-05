import { describe, expect, it } from "vitest";
import {
  CHAT_CLOUD_DAILY_LIMIT,
  CHAT_DAILY_LIMIT,
  CHAT_PRO_DAILY_LIMIT,
  chatDailyLimit,
  chatMessagesRemaining,
  canStoreCloudConversations,
  isProActive,
} from "./service";

describe("chat allowance", () => {
  it("gives Pro a flat 500 messages while the paid period is active", () => {
    expect(chatDailyLimit(false, 1, true)).toBe(CHAT_PRO_DAILY_LIMIT);
    expect(chatDailyLimit(true, 2, true)).toBe(CHAT_PRO_DAILY_LIMIT);
    expect(chatMessagesRemaining(20, false, 1, true)).toBe(480);
    const now = new Date("2026-09-24T12:00:00Z");
    expect(isProActive({ plan: "pro", pro_until: new Date("2026-10-24T00:00:00Z") }, now)).toBe(true);
    expect(isProActive({ plan: "pro", pro_until: new Date("2026-09-01T00:00:00Z") }, now)).toBe(false);
    expect(isProActive({ plan: "free", pro_until: null }, now)).toBe(false);
  });

  it("never reports a negative remainder on the free pass", () => {
    expect(chatMessagesRemaining(0)).toBe(CHAT_DAILY_LIMIT);
    expect(chatMessagesRemaining(49)).toBe(1);
    expect(chatMessagesRemaining(50)).toBe(0);
    expect(chatMessagesRemaining(99)).toBe(0);
  });

  it("doubles the daily limit when cloud training is on", () => {
    expect(chatDailyLimit(false)).toBe(CHAT_DAILY_LIMIT);
    expect(chatDailyLimit(true)).toBe(CHAT_CLOUD_DAILY_LIMIT);
    expect(chatMessagesRemaining(0, true)).toBe(100);
    expect(chatMessagesRemaining(50, true)).toBe(50);
    expect(chatMessagesRemaining(100, true)).toBe(0);
  });

  it("applies a promo multiplier on top of the current pass", () => {
    expect(chatDailyLimit(false, 2)).toBe(100);
    expect(chatDailyLimit(true, 2)).toBe(200);
    expect(chatMessagesRemaining(50, false, 2)).toBe(50);
    expect(chatMessagesRemaining(100, true, 2)).toBe(100);
  });
});

describe("chat history storage", () => {
  it("allows signed-in accounts or cloud-training profiles to store conversations", () => {
    expect(canStoreCloudConversations({ signedIn: true, cloudTrainingConsent: false })).toBe(true);
    expect(canStoreCloudConversations({ signedIn: false, cloudTrainingConsent: true })).toBe(true);
    expect(canStoreCloudConversations({ signedIn: true, cloudTrainingConsent: true })).toBe(true);
    expect(canStoreCloudConversations({ signedIn: false, cloudTrainingConsent: false })).toBe(false);
  });
});
