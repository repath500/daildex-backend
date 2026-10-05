import { describe, expect, it } from "vitest";
import { clientAddress, MemoryRateLimiter, RATE_TIERS } from "./rate-limit";

describe("MemoryRateLimiter", () => {
  it("allows up to the limit, then blocks until the window resets", () => {
    let now = 1_000_000;
    const limiter = new MemoryRateLimiter(() => now);
    const tier = { name: "anonymous" as const, limit: 3, windowSeconds: 60 };
    const results = [1, 2, 3, 4].map(() => limiter.hit("1.2.3.4", tier));
    expect(results.map((result) => result.allowed)).toEqual([true, true, true, false]);
    expect(results.map((result) => result.remaining)).toEqual([2, 1, 0, 0]);
    expect(results[3]!.resetSeconds).toBe(60);
    now += 61_000;
    expect(limiter.hit("1.2.3.4", tier)).toMatchObject({ allowed: true, remaining: 2 });
  });

  it("counts callers and tiers separately", () => {
    const limiter = new MemoryRateLimiter();
    const tier = { name: "anonymous" as const, limit: 1, windowSeconds: 60 };
    expect(limiter.hit("a", tier).allowed).toBe(true);
    expect(limiter.hit("a", tier).allowed).toBe(false);
    expect(limiter.hit("b", tier).allowed).toBe(true);
    expect(limiter.hit("a", { ...tier, name: "free" }).allowed).toBe(true);
  });

  it("bounds memory under a flood of distinct keys", () => {
    const limiter = new MemoryRateLimiter(Date.now, 100);
    for (let index = 0; index < 1000; index += 1) limiter.hit(`ip-${index}`, RATE_TIERS.anonymous);
    expect(limiter.size).toBeLessThanOrEqual(100);
  });

  it("documents the published tiers", () => {
    expect(RATE_TIERS.anonymous).toMatchObject({ limit: 60, windowSeconds: 3600 });
    expect(RATE_TIERS.free).toMatchObject({ limit: 5000, windowSeconds: 86_400 });
  });
});

describe("clientAddress", () => {
  const headers = (values: Record<string, string>) => ({ get: (name: string) => values[name] ?? null });

  it("prefers X-Real-IP, which nginx sets from the socket address", () => {
    expect(clientAddress(headers({ "x-real-ip": "203.0.113.9", "x-forwarded-for": "6.6.6.6, 203.0.113.9" }))).toBe("203.0.113.9");
  });

  it("cannot be steered by a forged left-most X-Forwarded-For entry", () => {
    expect(clientAddress(headers({ "x-forwarded-for": "6.6.6.6, 203.0.113.9" }))).toBe("203.0.113.9");
  });

  it("falls back to a shared bucket rather than skipping the limit", () => {
    expect(clientAddress(headers({}))).toBe("unknown-client");
  });
});
