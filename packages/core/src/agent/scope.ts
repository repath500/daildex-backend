import { createHmac, timingSafeEqual } from "node:crypto";
import { AppError } from "@daildex/shared";

const DEFAULT_SCOPE_TTL_SECONDS = 10 * 60;

export type AgentScopeClaims = {
  targetId: string;
  workerId: string;
  runId: string;
  provider: string;
  model: string;
  providerVerified: boolean;
  promptVersion: string;
  issuedAt: number;
  expiresAt: number;
};

type ScopeInput = Omit<AgentScopeClaims, "issuedAt" | "expiresAt"> & {
  issuedAt?: number;
  expiresAt?: number;
};

export function createAgentScopeToken(
  input: ScopeInput,
  secret = requiredScopeSecret(),
): string {
  const issuedAt = input.issuedAt ?? Math.floor(Date.now() / 1000);
  const expiresAt = input.expiresAt ?? issuedAt + DEFAULT_SCOPE_TTL_SECONDS;
  const payload: AgentScopeClaims = {
    targetId: input.targetId,
    workerId: input.workerId,
    runId: input.runId,
    provider: input.provider,
    model: input.model,
    providerVerified: input.providerVerified,
    promptVersion: input.promptVersion,
    issuedAt,
    expiresAt,
  };
  const encoded = encode(JSON.stringify(payload));
  return `${encoded}.${sign(encoded, secret)}`;
}

export function verifyAgentScopeToken(
  token: string,
  secret = requiredScopeSecret(),
  now = Math.floor(Date.now() / 1000),
): AgentScopeClaims {
  const [encoded, signature, extra] = token.split(".");
  if (!encoded || !signature || extra) throw invalidScope();

  const expected = sign(encoded, secret);
  const signatureBuffer = Buffer.from(signature, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (
    signatureBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    throw invalidScope();
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw invalidScope();
  }
  if (!isScopeClaims(payload) || payload.expiresAt <= now || payload.issuedAt > now + 30) {
    throw invalidScope();
  }
  return payload;
}

function requiredScopeSecret(): string {
  const secret = process.env.DAILDEX_AGENT_TOKEN?.trim();
  if (!secret) throw new AppError("SERVICE_UNAVAILABLE", "DAILDEX_AGENT_TOKEN is not configured.", 503);
  return secret;
}

function encode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function sign(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function invalidScope(): AppError {
  return new AppError("UNAUTHORIZED", "Invalid or expired agent scope.", 401);
}

function isScopeClaims(value: unknown): value is AgentScopeClaims {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return ["targetId", "workerId", "runId", "provider", "model", "promptVersion"].every(
    (key) => typeof candidate[key] === "string" && candidate[key],
  ) && typeof candidate.providerVerified === "boolean" && ["issuedAt", "expiresAt"].every(
    (key) => typeof candidate[key] === "number" && Number.isSafeInteger(candidate[key]),
  );
}
