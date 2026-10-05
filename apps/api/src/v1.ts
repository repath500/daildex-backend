import { getDatabase } from "@daildex/db";
import {
  getBill,
  getDivision,
  getQuestion,
  getRepresentative,
  getSpeech,
  listBills,
  listConstituencies,
  listDivisions,
  listParties,
  listPublicActivity,
  listPublicLegislation,
  listPublicQuestions,
  listPublicSpeeches,
  listPublicVotes,
  listRepresentatives,
  parseBillListQuery,
  parseDivisionDetailQuery,
  parseDivisionListQuery,
  parsePublicActivityQuery,
  parsePublicLegislationQuery,
  parsePublicListQuery,
  parseRepresentativeListQuery,
  PublicApiValidationError,
  API_LICENCE,
} from "@daildex/core/public-api";
import {
  createWebhook,
  createWebhookSchema,
  deleteWebhook,
  listWebhookDeliveries,
  listWebhooks,
} from "@daildex/core/public-api/webhooks";
import { AppError } from "@daildex/shared";
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ZodError } from "zod";
import { errorBody, type CallerVariables } from "./middleware";

type ListQuery = Record<string, string | undefined>;

export function queryParams(request: Request): ListQuery {
  return Object.fromEntries(new URL(request.url).searchParams.entries());
}

async function readJson(request: Request): Promise<unknown> {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > 8192) throw new AppError("INVALID_REQUEST", "Request is too large.", 413);
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > 8192) throw new AppError("INVALID_REQUEST", "Request is too large.", 413);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new PublicApiValidationError("Invalid request: body — Not valid JSON.", [{ field: "body", issue: "Not valid JSON." }]);
  }
}

export function apiIndex(baseUrl: string) {
  return {
    name: "DáilDex API",
    version: "1.0.0-beta",
    documentation: "https://daildex.com/developers",
    reference: `${baseUrl}/docs`,
    openapi: `${baseUrl}/openapi.json`,
    mcp: `${baseUrl}/mcp`,
    keys: "https://daildex.com/developers/keys",
    licence: API_LICENCE,
  };
}

export function createV1Routes(baseUrl: string) {
  const v1 = new Hono<CallerVariables>();

  v1.get("/", (context) => context.json(apiIndex(baseUrl)));

  v1.get("/representatives", async (context) => {
    return context.json(await listRepresentatives(parseRepresentativeListQuery(queryParams(context.req.raw))));
  });
  v1.get("/representatives/:id", async (context) => {
    return context.json(await getRepresentative(context.req.param("id")));
  });

  // Member-scoped feeds are the global feeds with the member fixed by the path.
  const scoped = <T>(list: (query: ReturnType<typeof parsePublicListQuery>) => Promise<T>) =>
    async (context: { req: { param(name: string): string; raw: Request } }) => {
      const id = context.req.param("id");
      const query = queryParams(context.req.raw);
      if ("representative" in query) {
        throw new PublicApiValidationError(
          "Invalid request: representative — The member is set by the path.",
          [{ field: "representative", issue: "The member is set by the path." }],
        );
      }
      const known = await getDatabase()`SELECT 1 FROM representatives WHERE representative_key = ${id}`;
      if (known.length === 0) throw new AppError("NOT_FOUND", "Representative not found.", 404);
      return list(parsePublicListQuery({ ...query, representative: id }));
    };
  v1.get("/representatives/:id/votes", async (context) => context.json(await scoped(listPublicVotes)(context)));
  v1.get("/representatives/:id/questions", async (context) => context.json(await scoped(listPublicQuestions)(context)));
  v1.get("/representatives/:id/speeches", async (context) => context.json(await scoped(listPublicSpeeches)(context)));

  v1.get("/divisions", async (context) => {
    return context.json(await listDivisions(parseDivisionListQuery(queryParams(context.req.raw))));
  });
  v1.get("/divisions/:id", async (context) => {
    const options = parseDivisionDetailQuery(queryParams(context.req.raw));
    return context.json(await getDivision(context.req.param("id"), { includeMembers: options.include === "members" }));
  });

  v1.get("/votes", async (context) => context.json(await listPublicVotes(parsePublicListQuery(queryParams(context.req.raw)))));
  v1.get("/questions", async (context) => context.json(await listPublicQuestions(parsePublicListQuery(queryParams(context.req.raw)))));
  v1.get("/questions/:id", async (context) => {
    parseNoQuery(context.req.raw);
    return context.json(await getQuestion(context.req.param("id")));
  });
  v1.get("/speeches", async (context) => context.json(await listPublicSpeeches(parsePublicListQuery(queryParams(context.req.raw)))));
  v1.get("/speeches/:id", async (context) => {
    parseNoQuery(context.req.raw);
    return context.json(await getSpeech(context.req.param("id")));
  });
  v1.get("/legislation", async (context) => context.json(await listPublicLegislation(parsePublicLegislationQuery(queryParams(context.req.raw)))));
  v1.get("/activity", async (context) => context.json(await listPublicActivity(parsePublicActivityQuery(queryParams(context.req.raw)))));

  v1.get("/bills", async (context) => context.json(await listBills(parseBillListQuery(queryParams(context.req.raw)))));
  v1.get("/bills/:year/:number", async (context) => {
    parseNoQuery(context.req.raw);
    return context.json(await getBill(context.req.param("year"), context.req.param("number")));
  });
  v1.get("/parties", async (context) => {
    parseNoQuery(context.req.raw);
    return context.json(await listParties());
  });
  v1.get("/constituencies", async (context) => {
    parseNoQuery(context.req.raw);
    return context.json(await listConstituencies());
  });

  // Webhooks belong to an API key, so they need one.
  const requireKey = (context: { get(name: "keyId"): string | null }): string => {
    const keyId = context.get("keyId");
    if (!keyId) throw new AppError("UNAUTHORIZED", "Webhooks need an API key. Send `Authorization: Bearer dd_live_...`.", 401);
    return keyId;
  };
  v1.get("/webhooks", async (context) => {
    const data = await listWebhooks(requireKey(context));
    return context.json({ data });
  });
  v1.post("/webhooks", async (context) => {
    const keyId = requireKey(context);
    const body = createWebhookSchema.parse(await readJson(context.req.raw));
    return context.json({ data: await createWebhook(keyId, body) }, 201);
  });
  v1.delete("/webhooks/:id", async (context) => {
    const deleted = await deleteWebhook(requireKey(context), context.req.param("id"));
    if (!deleted) throw new AppError("NOT_FOUND", "Webhook not found.", 404);
    return context.json({ data: { deleted: true } });
  });
  v1.get("/webhooks/:id/deliveries", async (context) => {
    const data = await listWebhookDeliveries(requireKey(context), context.req.param("id"));
    return context.json({ data });
  });

  v1.onError((error, context) => v1ErrorResponse(error, context));
  return v1;
}

function parseNoQuery(request: Request) {
  const query = queryParams(request);
  const unknown = Object.keys(query);
  if (unknown.length > 0) {
    throw new PublicApiValidationError(
      `Invalid request: ${unknown.join(", ")} — Unknown parameter. This route takes no parameters.`,
      unknown.map((field) => ({ field, issue: "Unknown parameter. This route takes no parameters." })),
    );
  }
}

export function v1ErrorResponse(error: unknown, context: Context) {
  const json = (body: unknown, status: number) => context.json(body as never, status as ContentfulStatusCode);
  if (error instanceof PublicApiValidationError) {
    return json(errorBody("INVALID_REQUEST", error.message, error.fields), 400);
  }
  if (error instanceof ZodError) {
    const fields = error.issues.map((issue) => ({ field: issue.path.join(".") || "body", issue: issue.message }));
    return json(errorBody("INVALID_REQUEST", `Invalid request: ${fields.map((entry) => `${entry.field} — ${entry.issue}`).join("; ")}`, fields), 400);
  }
  if (error instanceof AppError) {
    return json(errorBody(error.code, error.message), error.status);
  }
  console.error("Unhandled API error", error);
  return json(errorBody("INTERNAL_ERROR", "An unexpected error occurred."), 500);
}
