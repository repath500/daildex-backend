import {
  looksLikeApiKey,
  touchApiKey,
  verifyApiKey,
  type VerifiedApiKey,
} from "@daildex/core/public-api/keys";
import {
  clientAddress,
  MemoryRateLimiter,
  RATE_TIERS,
  type RateTierName,
} from "@daildex/core/public-api/rate-limit";
import type { Context, MiddlewareHandler } from "hono";

export type CallerVariables = {
  Variables: { tier: RateTierName; keyId: string | null };
};

export const errorBody = (code: string, message: string, fields?: Array<{ field: string; issue: string }>) => ({
  error: { code, message, ...(fields && fields.length > 0 ? { fields } : {}) },
});

type KeyVerifier = (key: string) => Promise<VerifiedApiKey | null>;

const KEY_CACHE_MS = 60_000;
const INVALID_KEY_CACHE_MS = 30_000;
const TOUCH_INTERVAL_MS = 10 * 60_000;

/** Verify keys with a short in-memory cache so a busy key is not a database lookup per request. */
export function createKeyResolver(verify: KeyVerifier = verifyApiKey, now: () => number = Date.now) {
  const cache = new Map<string, { value: VerifiedApiKey | null; expires: number }>();
  const touched = new Map<string, number>();

  return async function resolve(key: string): Promise<VerifiedApiKey | null> {
    const cached = cache.get(key);
    if (cached && cached.expires > now()) return cached.value;
    const value = await verify(key);
    if (cache.size > 5000) cache.clear();
    cache.set(key, { value, expires: now() + (value ? KEY_CACHE_MS : INVALID_KEY_CACHE_MS) });
    if (value && (touched.get(value.id) ?? 0) + TOUCH_INTERVAL_MS < now()) {
      touched.set(value.id, now());
      void touchApiKey(value.id).catch(() => undefined);
    }
    return value;
  };
}

type GuardOptions = {
  limiter: MemoryRateLimiter;
  resolveKey: (key: string) => Promise<VerifiedApiKey | null>;
  /** MCP callers share connector egress IPs, so they get a roomier anonymous tier. */
  anonymousTier: "anonymous" | "mcp-anonymous";
  maxConcurrent?: number;
};

/**
 * Identifies the caller (API key or IP), applies the in-memory rate limit, publishes the
 * RateLimit-* headers, sheds load when too many database-backed requests are in flight, and logs
 * one latency line per request. IPs are never logged.
 */
export function publicApiGuard(options: GuardOptions): MiddlewareHandler<CallerVariables> {
  let inflight = 0;
  const maxConcurrent = options.maxConcurrent ?? 24;

  return async (context, next) => {
    if (context.req.method === "OPTIONS") return next();
    const started = performance.now();

    const authorization = context.req.header("authorization");
    let verified: VerifiedApiKey | null = null;
    if (authorization !== undefined) {
      const token = /^Bearer\s+(\S+)$/i.exec(authorization)?.[1];
      verified = token && looksLikeApiKey(token) ? await options.resolveKey(token) : null;
      if (!verified) {
        context.header("WWW-Authenticate", 'Bearer error="invalid_token"');
        return context.json(errorBody("UNAUTHORIZED", "The API key is missing, malformed or revoked."), 401);
      }
    }

    const tierName: RateTierName = verified ? verified.tier : options.anonymousTier;
    const identity = verified ? `key:${verified.id}` : `ip:${clientAddress(context.req.raw.headers)}`;
    const result = options.limiter.hit(identity, RATE_TIERS[tierName]);
    context.header("RateLimit-Limit", String(result.limit));
    context.header("RateLimit-Remaining", String(result.remaining));
    context.header("RateLimit-Reset", String(result.resetSeconds));
    context.set("tier", tierName);
    context.set("keyId", verified?.id ?? null);
    if (!result.allowed) {
      context.header("Retry-After", String(result.resetSeconds));
      return context.json(errorBody(
        "RATE_LIMITED",
        verified
          ? "API key rate limit reached. Try again after the reset."
          : "Anonymous rate limit reached. Create a free API key for a higher limit, or try again after the reset.",
      ), 429);
    }

    if (inflight >= maxConcurrent) {
      context.header("Retry-After", "2");
      return context.json(errorBody("SERVICE_UNAVAILABLE", "The API is busy. Retry shortly."), 503);
    }
    inflight += 1;
    try {
      await next();
    } finally {
      inflight -= 1;
      logRequest(context, started);
    }
  };
}

function logRequest(context: Context<CallerVariables>, started: number) {
  if (process.env.NODE_ENV === "test") return;
  console.log(JSON.stringify({
    evt: "api_request",
    method: context.req.method,
    route: context.req.routePath,
    status: context.res.status,
    ms: Math.round(performance.now() - started),
    tier: context.get("tier"),
    keyed: Boolean(context.get("keyId")),
  }));
}

/** Cache successful reads: shared caches for anonymous traffic, private for keyed traffic. */
export const cacheHeaders: MiddlewareHandler<CallerVariables> = async (context, next) => {
  await next();
  if (context.req.method !== "GET") return;
  if (context.res.status !== 200) {
    context.header("Cache-Control", "no-store");
    return;
  }
  const keyed = Boolean(context.get("keyId"));
  const webhooks = context.req.path.startsWith("/v1/webhooks");
  context.header(
    "Cache-Control",
    webhooks ? "private, no-store" : keyed ? "private, max-age=60" : "public, max-age=60, s-maxage=300",
  );
  context.header("Vary", "Authorization");
};
