import { getDatabase, type Database } from "@daildex/db";
import { AppError } from "@daildex/shared";
import { getTokenPepper } from "../config";
import { hashOpaqueToken } from "./tokens";

export type RateLimitInput = {
  namespace: string;
  key: string;
  limit: number;
  message?: string;
};

/**
 * Enforce a fixed, hourly rate limit without retaining the raw IP, email, or token.
 * The database upsert keeps the limit shared across server instances.
 */
export async function enforceHourlyRateLimit(
  input: RateLimitInput,
  database: Database = getDatabase(),
) {
  if (!input.namespace.trim() || !input.key.trim()) {
    throw new Error("A rate-limit namespace and key are required.");
  }
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 10_000) {
    throw new Error("A rate limit from 1 to 10000 is required.");
  }

  const bucketKey = hashOpaqueToken(
    `rate:${input.namespace}:${input.key}`,
    getTokenPepper(),
  );
  const rows = await database<{ request_count: number }[]>`
    INSERT INTO request_rate_limits (bucket_key, window_started_at, request_count)
    VALUES (${bucketKey}, date_trunc('hour', now()), 1)
    ON CONFLICT (bucket_key, window_started_at) DO UPDATE SET
      request_count = request_rate_limits.request_count + 1
    RETURNING request_count
  `;
  const requestCount = rows[0]?.request_count ?? 1;
  if (requestCount > input.limit) {
    throw new AppError(
      "RATE_LIMITED",
      input.message ?? "Too many requests. Please try again later.",
      429,
    );
  }

  return { requestCount, remaining: Math.max(0, input.limit - requestCount) };
}
