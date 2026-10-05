import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export function createOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashOpaqueToken(token: string, pepper: string): string {
  return createHmac("sha256", pepper).update(token, "utf8").digest("hex");
}

export function tokenHashesMatch(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export type SubscriberTokenKind = "manage" | "unsubscribe";

export function createSubscriberToken(
  subscriberId: string,
  kind: SubscriberTokenKind,
  version: number,
  pepper: string,
): string {
  const payload = Buffer.from(JSON.stringify({ subscriberId, kind, version }), "utf8").toString("base64url");
  const signature = createHmac("sha256", pepper).update(payload, "utf8").digest("base64url");
  return `${payload}.${signature}`;
}

export function verifySubscriberToken(token: string, pepper: string) {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) return null;
  const expected = createHmac("sha256", pepper).update(payload, "utf8").digest("base64url");
  const signatureBuffer = Buffer.from(signature, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (signatureBuffer.length !== expectedBuffer.length || !timingSafeEqual(signatureBuffer, expectedBuffer)) {
    return null;
  }

  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    if (
      typeof decoded.subscriberId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(decoded.subscriberId) ||
      (decoded.kind !== "manage" && decoded.kind !== "unsubscribe") ||
      typeof decoded.version !== "number" ||
      !Number.isSafeInteger(decoded.version) ||
      decoded.version < 1
    ) {
      return null;
    }
    return decoded as { subscriberId: string; kind: SubscriberTokenKind; version: number };
  } catch {
    return null;
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const THREAD_TOKEN_PATTERN = /^([0-9a-f]{32})-([1-9][0-9]{0,5})-([0-9a-f]{20})$/;

function threadSignature(compactId: string, version: number, pepper: string): string {
  // 80 bits of HMAC-SHA256 is ample for a token checked online, one reply at a time.
  return createHmac("sha256", pepper).update(`thread:v2:${compactId}:${version}`, "utf8").digest("hex").slice(0, 20);
}

/**
 * Token for the `reply+<token>@` address. It must fit an email local part
 * (64 characters with "reply+") and survive servers that lowercase addresses,
 * so it is lowercase hex: `<thread id without dashes>-<version>-<signature>`.
 */
export function createThreadToken(threadId: string, version: number, pepper: string): string {
  if (!UUID_PATTERN.test(threadId) || !Number.isSafeInteger(version) || version < 1 || version > 999_999) {
    throw new Error("Thread tokens need a UUID thread id and a version from 1 to 999999.");
  }
  const compactId = threadId.replace(/-/g, "").toLowerCase();
  return `${compactId}-${version}-${threadSignature(compactId, version, pepper)}`;
}

export function verifyThreadToken(token: string, pepper: string) {
  const match = THREAD_TOKEN_PATTERN.exec(token.trim().toLowerCase());
  if (!match) return null;
  const [, compactId, versionText, signature] = match;
  const version = Number(versionText);
  const expected = threadSignature(compactId, version, pepper);
  if (!timingSafeEqual(Buffer.from(signature, "utf8"), Buffer.from(expected, "utf8"))) return null;
  const threadId = `${compactId.slice(0, 8)}-${compactId.slice(8, 12)}-${compactId.slice(12, 16)}-${compactId.slice(16, 20)}-${compactId.slice(20)}`;
  if (!UUID_PATTERN.test(threadId)) return null;
  return { threadId, version };
}
