import { getDatabase } from "@daildex/db";
import {
  findSimilarPreviousAlerts,
  getClaimedAlertTarget,
  getRepresentativeHistory,
  submitScopedAlertOutcome,
  submitScopedAlertDraft,
} from "@daildex/core/agent";
import { verifyAgentScopeToken, type AgentScopeClaims } from "@daildex/core/agent/scope";
import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { editAlert, listReviewAlerts, reviewAlert } from "@daildex/core/review";
import { editReply, listReviewReplies, reviewReply } from "@daildex/core/replies";
import { getOperationalSnapshot, listRuntimeControls, setRuntimeControl } from "@daildex/core/operations";
import { buildOpenApiDocument } from "@daildex/core/public-api/openapi";
import { MemoryRateLimiter } from "@daildex/core/public-api/rate-limit";
import {
  fetchResendReceivedEmail,
  persistResendInbound,
  persistResendDelivery,
  verifyResendSignature,
} from "@daildex/core/email/webhooks";
import {
  AppError,
  alertAgentDecisionSchema,
  alertDraftSchema,
  toPublicError,
} from "@daildex/shared";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { ZodError } from "zod";
import { z } from "zod";
import { handleMcpRequest } from "./mcp";
import {
  cacheHeaders,
  createKeyResolver,
  errorBody,
  publicApiGuard,
} from "./middleware";
import { apiIndex, createV1Routes, v1ErrorResponse } from "./v1";

export type AppOptions = {
  /** Replace the in-memory limiter (tests). */
  limiter?: MemoryRateLimiter;
  resolveKey?: Parameters<typeof publicApiGuard>[0]["resolveKey"];
};

const PUBLIC_BASE_URL = (process.env.PUBLIC_API_BASE_URL ?? "https://api.daildex.com").replace(/\/$/, "");

const DOCS_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>DáilDex API reference</title>
</head>
<body>
  <script id="api-reference" data-url="/openapi.json" data-configuration='{"hideClientButton":true,"showDeveloperTools":"never","telemetry":false,"agent":{"disabled":true},"mcp":{"disabled":true}}'></script>
  <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@1"></script>
</body>
</html>`;

export function createApp(options: AppOptions = {}) {
  const app = new Hono();

  app.use("*", secureHeaders({
    strictTransportSecurity: "max-age=63072000; includeSubDomains; preload",
    referrerPolicy: "no-referrer",
    xFrameOptions: "DENY",
    // The public record is meant to be fetched from other origins; CORS still gates who may read it.
    crossOriginResourcePolicy: "cross-origin",
  }));

  const limiter = options.limiter ?? new MemoryRateLimiter();
  const resolveKey = options.resolveKey ?? createKeyResolver();
  const publicCors = cors({
    origin: "*",
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowHeaders: ["Authorization", "Content-Type", "Accept", "MCP-Protocol-Version", "Mcp-Session-Id"],
    exposeHeaders: ["RateLimit-Limit", "RateLimit-Remaining", "RateLimit-Reset", "Retry-After", "Mcp-Session-Id"],
    maxAge: 86_400,
  });
  // Hono's "/v1/*" also matches "/v1", so one registration covers both and the guard runs once.
  app.use("/v1/*", publicCors);
  app.use("/mcp", publicCors);
  app.use("/openapi.json", publicCors);

  const apiGuard = publicApiGuard({ limiter, resolveKey, anonymousTier: "anonymous" });
  app.use("/v1/*", apiGuard);
  app.use("/v1/*", cacheHeaders);
  app.use("/mcp", publicApiGuard({ limiter, resolveKey, anonymousTier: "mcp-anonymous" }));

  app.use("/internal/*", async (context, next) => {
    const isAgentRoute = new URL(context.req.url).pathname.startsWith("/internal/agent/");
    const expected = isAgentRoute ? process.env.DAILDEX_AGENT_TOKEN : process.env.INTERNAL_API_TOKEN;
    if (!expected) return context.json({ error: "SERVICE_UNAVAILABLE" }, 503);
    if (!secretsMatch(context.req.header("authorization") ?? "", `Bearer ${expected}`)) {
      return context.json({ error: "UNAUTHORIZED" }, 401);
    }
    await next();
  });

  app.get("/health/live", (context) => context.json({ status: "ok" }));
  app.get("/health/ready", async (context) => {
    const rows = await getDatabase()<{
      schema_ready: boolean;
      database_time: Date;
    }[]>`
      SELECT
        to_regclass('public.runtime_controls') IS NOT NULL
          AND to_regclass('public.email_outbox') IS NOT NULL
          AND to_regclass('public.ingest_runs') IS NOT NULL AS schema_ready,
        now() AS database_time
    `;
    if (!rows[0]?.schema_ready) return context.json({ status: "not_ready", reason: "schema" }, 503);
    return context.json({ status: "ready", databaseTime: rows[0].database_time });
  });

  app.route("/v1", createV1Routes(PUBLIC_BASE_URL));

  app.get("/", (context) => context.json(apiIndex(PUBLIC_BASE_URL)));
  app.get("/openapi.json", (context) => {
    context.header("Cache-Control", "public, max-age=300");
    return context.json(buildOpenApiDocument(PUBLIC_BASE_URL));
  });
  app.get("/docs", (context) => {
    context.header("Cache-Control", "public, max-age=300");
    return context.html(DOCS_HTML);
  });

  app.get("/.well-known/mcp/server.json", (context) => {
    context.header("Cache-Control", "public, max-age=3600");
    context.header("Content-Type", "application/json; charset=utf-8");
    return context.body(readFileSync(new URL("../server.json", import.meta.url), "utf8"));
  });

  app.post("/mcp", (context) => handleMcpRequest(context.req.raw));
  const mcpMethodNotAllowed = (context: import("hono").Context) => {
    context.header("Allow", "POST, OPTIONS");
    return context.json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed. POST JSON-RPC to this endpoint." }, id: null }, 405);
  };
  app.get("/mcp", mcpMethodNotAllowed);
  app.delete("/mcp", mcpMethodNotAllowed);

  app.post("/webhooks/email/events", async (context) => {
    const rawBody = await readRawWebhook(context.req.raw);
    const signingSecret = process.env.RESEND_WEBHOOK_SECRET;
    if (!signingSecret) throw new AppError("SERVICE_UNAVAILABLE", "Resend webhook verification is not configured.", 503);
    const headers = {
      "svix-id": context.req.header("svix-id"),
      "svix-timestamp": context.req.header("svix-timestamp"),
      "svix-signature": context.req.header("svix-signature"),
    };
    if (!verifyResendSignature(headers, rawBody, signingSecret)) {
      throw new AppError("UNAUTHORIZED", "Invalid Resend webhook signature.", 403);
    }
    const payload = parseWebhookJson(rawBody);
    if (payload.type === "email.received") {
      const emailId = receivedEmailId(payload);
      const apiKey = process.env.RESEND_API_KEY;
      if (!emailId) throw new AppError("INVALID_REQUEST", "Resend received-email id is missing.", 400);
      if (!apiKey) throw new AppError("SERVICE_UNAVAILABLE", "Resend receiving is not configured.", 503);
      const received = await fetchResendReceivedEmail(emailId, apiKey);
      return context.json(await persistResendInbound(received, context.req.header("svix-id") ?? ""));
    }
    return context.json(await persistResendDelivery(payload, context.req.header("svix-id") ?? ""));
  });

  app.get("/internal/agent/targets/:id", async (context) => {
    const scope = requireAgentScope(context.req.header("x-daildex-agent-scope"), context.req.param("id"));
    const target = await getClaimedAlertTarget(scope);
    if (!target) throw new AppError("CONFLICT", "The alert target lease is no longer owned by this worker.", 409);
    return context.json(target);
  });

  app.get("/internal/agent/claimed-target", async (context) => {
    const scope = requireAgentScope(context.req.header("x-daildex-agent-scope"));
    const target = await getClaimedAlertTarget(scope);
    if (!target) throw new AppError("CONFLICT", "The alert target lease is no longer owned by this worker.", 409);
    return context.json(target);
  });

  app.post("/internal/agent/targets/:id/draft", async (context) => {
    const scope = requireAgentScope(context.req.header("x-daildex-agent-scope"), context.req.param("id"));
    const body = z.strictObject({ draft: alertDraftSchema }).parse(await readJson(context.req.raw));
    return context.json(await submitScopedAlertDraft(scope, body.draft), 202);
  });

  app.post("/internal/agent/draft", async (context) => {
    const scope = requireAgentScope(context.req.header("x-daildex-agent-scope"));
    const body = z.strictObject({ draft: alertDraftSchema }).parse(await readJson(context.req.raw));
    return context.json(await submitScopedAlertDraft(scope, body.draft), 202);
  });

  app.post("/internal/agent/outcome", async (context) => {
    const scope = requireAgentScope(context.req.header("x-daildex-agent-scope"));
    const body = z.strictObject({ decision: alertAgentDecisionSchema }).parse(await readJson(context.req.raw));
    return context.json(await submitScopedAlertOutcome(scope, body.decision), 202);
  });

  app.get("/internal/agent/representatives/:id/history", async (context) => {
    const representativeId = z.string().trim().min(1).max(100).parse(context.req.param("id"));
    const scope = requireAgentScope(context.req.header("x-daildex-agent-scope"));
    await requireScopedRepresentative(scope, representativeId);
    const limit = parseBoundedQueryInt(context.req.query("limit"), 20, 50);
    return context.json({ facts: await getRepresentativeHistory(representativeId, limit) });
  });

  app.get("/internal/agent/representatives/:id/alerts", async (context) => {
    const representativeId = z.string().trim().min(1).max(100).parse(context.req.param("id"));
    const scope = requireAgentScope(context.req.header("x-daildex-agent-scope"));
    await requireScopedRepresentative(scope, representativeId);
    const query = z.string().trim().max(120).parse(context.req.query("q") ?? "");
    const limit = parseBoundedQueryInt(context.req.query("limit"), 10, 25);
    return context.json({ alerts: await findSimilarPreviousAlerts(representativeId, query, limit) });
  });

  app.get("/internal/review/alerts", async (context) => {
    return context.json({ alerts: await listReviewAlerts() });
  });

  app.post("/internal/review/alerts/:id", async (context) => {
    const body = z.object({
      action: z.enum(["approved", "rejected", "edited"]),
      reason: z.string().trim().max(1000).optional(),
      revision: z.object({
        headline: z.string(), summary: z.string(), explanation: z.string(),
      }).optional(),
    }).parse(await readJson(context.req.raw));
    const actor = context.req.header("x-daildex-actor")?.slice(0, 200) || "internal-operator";
    if (body.action === "edited") {
      if (!body.revision) throw new AppError("INVALID_REQUEST", "An edited alert requires a revision.", 400);
      return context.json(await editAlert(context.req.param("id"), body.revision, actor));
    }
    return context.json(await reviewAlert(context.req.param("id"), body.action, actor, body.reason));
  });

  app.get("/internal/review/replies", async (context) => {
    return context.json({ replies: await listReviewReplies() });
  });

  app.post("/internal/review/replies/:id", async (context) => {
    const body = z.object({
      action: z.enum(["approved", "rejected", "edited"]),
      reason: z.string().trim().max(1000).optional(),
      answer: z.string().optional(),
    }).parse(await readJson(context.req.raw));
    const actor = context.req.header("x-daildex-actor")?.slice(0, 200) || "internal-operator";
    if (body.action === "edited") {
      if (!body.answer) throw new AppError("INVALID_REQUEST", "An edited reply requires an answer.", 400);
      return context.json(await editReply(context.req.param("id"), body.answer, actor));
    }
    return context.json(await reviewReply(context.req.param("id"), body.action, actor, body.reason));
  });

  app.get("/internal/operations", async (context) => {
    const [controls, snapshot] = await Promise.all([listRuntimeControls(), getOperationalSnapshot()]);
    return context.json({ controls, ...snapshot });
  });

  app.patch("/internal/operations/:key", async (context) => {
    const body = z.object({
      enabled: z.boolean(),
      reason: z.string().trim().min(1).max(500),
    }).parse(await readJson(context.req.raw));
    const actor = context.req.header("x-daildex-actor")?.slice(0, 200) || "internal-operator";
    return context.json(await setRuntimeControl(context.req.param("key"), body.enabled, actor, body.reason));
  });

  app.notFound((context) => {
    if (new URL(context.req.url).pathname.startsWith("/v1")) {
      return context.json(errorBody("NOT_FOUND", "Route not found. See /openapi.json for the available routes."), 404);
    }
    return context.json({ error: "NOT_FOUND", message: "Route not found." }, 404);
  });

  app.onError((error, context) => {
    const path = new URL(context.req.url).pathname;
    if (path.startsWith("/v1") || path === "/mcp") return v1ErrorResponse(error, context);
    if (error instanceof ZodError || error instanceof SyntaxError) {
      return context.json({ error: "INVALID_REQUEST", message: "Invalid request." }, 400);
    }

    const publicError = toPublicError(error);
    if (!(error instanceof AppError)) console.error("Unhandled API error", error);
    return context.json(publicError.body, publicError.status as 400 | 404 | 409 | 410 | 429 | 500 | 503);
  });

  return app;
}

async function readJson(request: Request): Promise<unknown> {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > 32_768) throw new AppError("INVALID_REQUEST", "Request is too large.", 413);
  return request.json();
}

async function readRawWebhook(request: Request): Promise<string> {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > 1_048_576) throw new AppError("INVALID_REQUEST", "Webhook is too large.", 413);
  const body = await request.text();
  if (Buffer.byteLength(body, "utf8") > 1_048_576) {
    throw new AppError("INVALID_REQUEST", "Webhook is too large.", 413);
  }
  return body;
}

function parseWebhookJson(rawBody: string): Record<string, unknown> {
  const payload = JSON.parse(rawBody) as unknown;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new AppError("INVALID_REQUEST", "Invalid webhook payload.", 400);
  }
  return payload as Record<string, unknown>;
}

function receivedEmailId(payload: Record<string, unknown>): string {
  const data = payload.data;
  if (!data || typeof data !== "object") return "";
  const value = (data as Record<string, unknown>).email_id;
  return typeof value === "string" ? value.trim() : "";
}

function secretsMatch(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function requireAgentScope(value: string | undefined, targetId?: string): AgentScopeClaims {
  if (!value) throw new AppError("UNAUTHORIZED", "Agent scope is required.", 401);
  const scope = verifyAgentScopeToken(value);
  if (targetId !== undefined && scope.targetId !== targetId) {
    throw new AppError("UNAUTHORIZED", "Agent scope does not match the target.", 401);
  }
  return scope;
}

async function requireScopedRepresentative(scope: AgentScopeClaims, representativeId: string): Promise<void> {
  const target = await getClaimedAlertTarget(scope);
  if (!target || target.representative.id !== representativeId) {
    throw new AppError("UNAUTHORIZED", "Agent scope does not include this representative.", 401);
  }
}

function parseBoundedQueryInt(value: string | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new AppError("INVALID_REQUEST", "Invalid limit.", 400);
  return Math.min(parsed, maximum);
}
