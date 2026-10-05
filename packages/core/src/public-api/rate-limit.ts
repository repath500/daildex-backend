/**
 * In-process fixed-window rate limiting for the public API.
 *
 * The API runs as one Node process behind nginx, so counters live in memory: no database write per
 * request, and nothing for a flood of requests to amplify. Counters reset when the process restarts,
 * which only ever gives a caller a fresh window. If the API is ever scaled out, swap this class for a
 * shared store (Redis/Upstash) behind the same `hit` method.
 */

export type RateTierName = "anonymous" | "mcp-anonymous" | "free" | "partner";

export type RateTier = { name: RateTierName; limit: number; windowSeconds: number };

export const RATE_TIERS: Record<RateTierName, RateTier> = {
  anonymous: { name: "anonymous", limit: 60, windowSeconds: 3600 },
  // Connector hosts (Claude, ChatGPT, Cursor) share egress IPs and one tool call is several requests.
  "mcp-anonymous": { name: "mcp-anonymous", limit: 600, windowSeconds: 3600 },
  free: { name: "free", limit: 5000, windowSeconds: 86_400 },
  partner: { name: "partner", limit: 50_000, windowSeconds: 86_400 },
};

export type RateResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the window resets. */
  resetSeconds: number;
};

type Entry = { count: number; resetAt: number };

export class MemoryRateLimiter {
  private readonly entries = new Map<string, Entry>();
  private lastSweep = 0;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxEntries = 100_000,
  ) {}

  hit(key: string, tier: RateTier): RateResult {
    const now = this.now();
    this.sweep(now);
    const bucket = `${tier.name}:${key}`;
    let entry = this.entries.get(bucket);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + tier.windowSeconds * 1000 };
      this.entries.set(bucket, entry);
    }
    entry.count += 1;
    return {
      allowed: entry.count <= tier.limit,
      limit: tier.limit,
      remaining: Math.max(0, tier.limit - entry.count),
      resetSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
    };
  }

  get size(): number {
    return this.entries.size;
  }

  private sweep(now: number) {
    if (now - this.lastSweep < 60_000 && this.entries.size < this.maxEntries) return;
    this.lastSweep = now;
    for (const [bucket, entry] of this.entries) {
      if (entry.resetAt <= now) this.entries.delete(bucket);
    }
    // A flood of distinct keys must not grow memory without bound: drop the oldest tenth.
    if (this.entries.size >= this.maxEntries) {
      let toDrop = Math.ceil(this.maxEntries / 10);
      for (const bucket of this.entries.keys()) {
        this.entries.delete(bucket);
        if (--toDrop <= 0) break;
      }
    }
  }
}

/**
 * The caller's address as nginx saw it. nginx sets X-Real-IP from `$remote_addr`, which the client
 * cannot forge. X-Forwarded-For is client-controlled at its left end, so if X-Real-IP is absent only
 * its LAST entry (the one our own proxy appended) is trusted.
 */
export function clientAddress(headers: { get(name: string): string | null | undefined }): string {
  const real = headers.get("x-real-ip")?.trim();
  if (real) return real.slice(0, 64);
  const forwarded = headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
  if (forwarded) return forwarded.slice(0, 64);
  return "unknown-client";
}
