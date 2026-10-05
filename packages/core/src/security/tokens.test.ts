import { describe, expect, it } from "vitest";
import {
  createOpaqueToken,
  createSubscriberToken,
  createThreadToken,
  hashOpaqueToken,
  tokenHashesMatch,
  verifySubscriberToken,
  verifyThreadToken,
} from "./tokens";

describe("opaque tokens", () => {
  it("creates URL-safe high-entropy values", () => {
    const first = createOpaqueToken();
    const second = createOpaqueToken();
    expect(first).toHaveLength(43);
    expect(first).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(first).not.toBe(second);
  });

  it("hashes with an environment-specific pepper", () => {
    const token = createOpaqueToken();
    const first = hashOpaqueToken(token, "pepper-one");
    const same = hashOpaqueToken(token, "pepper-one");
    const other = hashOpaqueToken(token, "pepper-two");
    expect(tokenHashesMatch(first, same)).toBe(true);
    expect(tokenHashesMatch(first, other)).toBe(false);
  });
});

describe("subscriber tokens", () => {
  const subscriberId = "123e4567-e89b-42d3-a456-426614174000";

  it("round-trips a purpose-bound revocable token", () => {
    const token = createSubscriberToken(subscriberId, "manage", 3, "pepper");
    expect(verifySubscriberToken(token, "pepper")).toEqual({ subscriberId, kind: "manage", version: 3 });
  });

  it("rejects tampering and a different environment pepper", () => {
    const token = createSubscriberToken(subscriberId, "unsubscribe", 1, "pepper");
    expect(verifySubscriberToken(`${token}x`, "pepper")).toBeNull();
    expect(verifySubscriberToken(token, "other-pepper")).toBeNull();
  });
});

describe("thread tokens", () => {
  it("are purpose-bound and reject a subscriber-token signature", () => {
    const id = "123e4567-e89b-42d3-a456-426614174000";
    const thread = createThreadToken(id, 1, "pepper");
    expect(verifyThreadToken(thread, "pepper")).toEqual({ threadId: id, version: 1 });
    expect(verifySubscriberToken(thread, "pepper")).toBeNull();
  });

  it("fit an email local part and survive lowercasing", () => {
    const id = "123E4567-E89B-42D3-A456-426614174000";
    const thread = createThreadToken(id, 12, "pepper");
    expect(`reply+${thread}`.length).toBeLessThanOrEqual(64);
    expect(thread).toMatch(/^[0-9a-f-]+$/);
    expect(verifyThreadToken(thread.toUpperCase(), "pepper")).toEqual({ threadId: id.toLowerCase(), version: 12 });
  });

  it("reject tampering, the wrong pepper and a changed version", () => {
    const id = "123e4567-e89b-42d3-a456-426614174000";
    const thread = createThreadToken(id, 1, "pepper");
    expect(verifyThreadToken(thread, "other-pepper")).toBeNull();
    expect(verifyThreadToken(thread.replace("-1-", "-2-"), "pepper")).toBeNull();
    expect(verifyThreadToken(`${thread.slice(0, -1)}${thread.endsWith("0") ? "1" : "0"}`, "pepper")).toBeNull();
    expect(verifyThreadToken(`${thread}0`, "pepper")).toBeNull();
  });
});
