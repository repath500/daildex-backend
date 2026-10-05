import { z } from "zod";
import { divisionDetailShape, divisionListShape } from "./divisions";
import { API_LICENCE } from "./query";
import { billShape, representativeShape } from "./resources";
import { activityShape, legislationShape, listShape } from "./service";
import { MAX_WEBHOOKS_PER_KEY, WEBHOOK_EVENTS } from "./webhooks";

type Json = Record<string, unknown>;

const PARAMETER_DESCRIPTIONS: Record<string, string> = {
  q: "Case-insensitive substring search. `%` and `_` are matched literally.",
  representative: "A representative id, e.g. `jennifer-whitmore` (see /v1/representatives).",
  chamber: "Filter by chamber.",
  date_start: "Earliest date, inclusive (YYYY-MM-DD).",
  date_end: "Latest date, inclusive (YYYY-MM-DD).",
  limit: "Page size.",
  offset: "Legacy offset paging. Prefer `cursor`; the two cannot be combined.",
  cursor: "Opaque cursor from `next_cursor` in the previous page.",
  type: "Restrict the activity feed to one record type.",
  outcome: "Division outcome, e.g. `Carried` or `Lost` (case-insensitive).",
  include: "`members` adds each member's vote.",
  party: "Party name or slug, e.g. `Fianna Fáil` or `fianna-fail`.",
  constituency: "Constituency name or slug.",
  status: "Record status filter.",
  year: "Four-digit bill year.",
};

function queryParameters(shape: z.ZodRawShape, omit: string[] = []): Json[] {
  const schema = z.toJSONSchema(z.object(shape), { io: "output", unrepresentable: "any" }) as {
    properties: Record<string, Json>;
  };
  return Object.entries(schema.properties)
    .filter(([name]) => !omit.includes(name))
    .map(([name, property]) => {
      const cleaned = { ...property };
      delete cleaned.$schema;
      // Zod's calendar regex is exact but unreadable in docs; `format: date` says the same thing.
      if (cleaned.format === "date") delete cleaned.pattern;
      return {
        name,
        in: "query",
        required: false,
        description: PARAMETER_DESCRIPTIONS[name],
        schema: cleaned,
      };
    });
}

const str = (extra: Json = {}): Json => ({ type: "string", ...extra });
const nullable = (schema: Json): Json => ({ ...schema, nullable: true });
const obj = (properties: Record<string, Json>, required?: string[]): Json => ({
  type: "object",
  properties,
  required: required ?? Object.keys(properties),
});
const ref = (name: string): Json => ({ $ref: `#/components/schemas/${name}` });
const arrayOf = (items: Json): Json => ({ type: "array", items });

const personFields = {
  id: str({ example: "jennifer-whitmore" }),
  name: str(),
  area: str(),
  party: str(),
  chamber: str({ enum: ["Dáil", "Seanad"] }),
  role: str({ enum: ["TD", "Senator"] }),
};

const schemas: Record<string, Json> = {
  Licence: obj({ name: str(), url: str({ format: "uri" }), attribution: str() }),
  Meta: obj({
    count: { type: "integer" },
    limit: { type: "integer" },
    next_cursor: nullable(str()),
    has_more: { type: "boolean" },
    licence: ref("Licence"),
    fetched_at: str({ format: "date-time" }),
  }),
  Error: obj({
    error: obj({
      code: str({ enum: ["INVALID_REQUEST", "UNAUTHORIZED", "NOT_FOUND", "RATE_LIMITED", "SERVICE_UNAVAILABLE", "INTERNAL_ERROR"] }),
      message: str(),
      fields: arrayOf(obj({ field: str(), issue: str() })),
    }, ["code", "message"]),
  }),
  RepresentativeSummary: obj(personFields),
  Representative: obj(personFields),
  RepresentativeDetail: obj({
    ...personFields,
    status: str({ enum: ["active", "former"] }),
    firstElected: nullable(str({ format: "date" })),
    sourceUrl: nullable(str({ format: "uri" })),
    record: obj({
      divisions: { type: "integer" }, votedIn: { type: "integer" }, ta: { type: "integer" },
      nil: { type: "integer" }, staon: { type: "integer" }, questions: { type: "integer" },
      since: nullable(str({ format: "date" })),
    }),
  }),
  ActivityItem: obj({
    id: str({ description: "Unique per row. For votes: `<divisionId>:<representativeId>`." }),
    type: str({ enum: ["vote", "question", "speech", "legislation"] }),
    date: nullable(str({ format: "date" })),
    title: str(),
    summary: nullable(str({ description: "Truncated to 500 characters. Use the detail routes for full text." })),
    sourceUrl: str({ format: "uri" }),
    representative: nullable(ref("RepresentativeSummary")),
    participation: nullable(str({ description: "`Tá`, `Níl`, `Staon`, `asked` or `spoke`." })),
    divisionId: nullable(str({ format: "uuid" })),
  }),
  Division: obj({
    id: str({ format: "uuid" }),
    date: str({ format: "date" }),
    datetime: nullable(str({ format: "date-time" })),
    house: str({ enum: ["Dáil", "Seanad"] }),
    title: str(),
    debate: nullable(str()),
    outcome: nullable(str()),
    tallies: obj({ ta: { type: "integer" }, nil: { type: "integer" }, staon: { type: "integer" } }),
    tellers: nullable(str()),
    sourceUrl: str({ format: "uri" }),
    debateUrl: nullable(str({ format: "uri" })),
  }),
  DivisionDetail: {
    allOf: [ref("Division"), obj({
      partyBreakdown: arrayOf(obj({ party: str(), ta: { type: "integer" }, nil: { type: "integer" }, staon: { type: "integer" } })),
      members: arrayOf(obj({
        representative: obj({ id: str(), name: str(), party: str(), area: str() }),
        vote: nullable(str()),
      })),
    }, ["partyBreakdown"])],
  },
  QuestionDetail: obj({
    id: str({ format: "uuid" }), date: str({ format: "date" }), number: nullable({ type: "integer" }),
    type: nullable(str()), title: str(), department: nullable(str()), question: str(), answer: nullable(str()),
    asker: ref("RepresentativeSummary"), sourceUrl: str({ format: "uri" }),
  }),
  SpeechDetail: obj({
    id: str({ format: "uuid" }), date: str({ format: "date" }), debate: str(), section: nullable(str()),
    text: str(), speaker: ref("RepresentativeSummary"), sourceUrl: str({ format: "uri" }),
  }),
  Bill: obj({
    id: str({ example: "2026/42" }), year: str(), number: str(), title: str(), longTitle: str(), status: str(),
    source: str(), currentStage: nullable(str()), currentStageDate: nullable(str({ format: "date" })),
    sourceUrl: str({ format: "uri" }),
  }),
  BillDetail: {
    allOf: [ref("Bill"), obj({
      sponsors: arrayOf(str()),
      stages: arrayOf(obj({ stage: str(), house: nullable(str()), date: nullable(str({ format: "date" })), completed: nullable({ type: "boolean" }) })),
      debates: arrayOf(obj({ label: str(), date: nullable(str({ format: "date" })), url: nullable(str({ format: "uri" })) })),
      documents: arrayOf(obj({ label: str(), type: str(), language: nullable(str()), pdfUrl: nullable(str()), xmlUrl: nullable(str()) })),
    })],
  },
  Party: obj({ id: str(), name: str(), members: { type: "integer" } }),
  Constituency: obj({ id: str(), name: str(), county: nullable(str()), seats: nullable({ type: "integer" }), members: { type: "integer" } }),
  Webhook: obj({
    id: str({ format: "uuid" }), url: str({ format: "uri" }),
    events: arrayOf(str({ enum: [...WEBHOOK_EVENTS] })), representative: nullable(str()),
    status: str({ enum: ["active", "disabled"] }), createdAt: str({ format: "date-time" }),
  }),
  WebhookCreated: {
    allOf: [ref("Webhook"), obj({ secret: str({ description: "Shown once. Sign check: `sha256=` + HMAC-SHA256(secret, raw body)." }) })],
  },
  WebhookDelivery: obj({
    id: str({ format: "uuid" }), event: str(), status: str({ enum: ["pending", "delivered", "dead"] }),
    attempts: { type: "integer" }, lastError: nullable(str()), createdAt: str({ format: "date-time" }),
    deliveredAt: nullable(str({ format: "date-time" })), nextAttemptAt: nullable(str({ format: "date-time" })),
  }),
  CreateWebhook: obj({
    url: str({ format: "uri", description: "Public https URL." }),
    events: arrayOf(str({ enum: [...WEBHOOK_EVENTS] })),
    representative: str({ description: "Only send events involving this representative id." }),
  }, ["url", "events"]),
};

const envelope = (data: Json, extraMeta = true): Json => obj({ data, ...(extraMeta ? { meta: ref("Meta") } : {}) });

const jsonResponse = (description: string, schema: Json): Json => ({
  description,
  headers: {
    "RateLimit-Limit": { schema: { type: "integer" }, description: "Requests allowed in the current window." },
    "RateLimit-Remaining": { schema: { type: "integer" }, description: "Requests left in the current window." },
    "RateLimit-Reset": { schema: { type: "integer" }, description: "Seconds until the window resets." },
  },
  content: { "application/json": { schema } },
});

const errorResponses: Json = {
  "400": jsonResponse("Invalid request. `error.fields` lists each problem, including unknown parameters.", ref("Error")),
  "429": {
    ...jsonResponse("Rate limit reached. Wait `Retry-After` seconds.", ref("Error")),
  },
};

const notFound = { "404": jsonResponse("No such record.", ref("Error")) };

type OperationInput = {
  summary: string;
  description?: string;
  tag: string;
  parameters?: Json[];
  response: Json;
  responseDescription?: string;
  withNotFound?: boolean;
  auth?: "optional" | "required";
  requestBody?: Json;
  status?: string;
};

function operation(input: OperationInput): Json {
  return {
    summary: input.summary,
    description: input.description,
    tags: [input.tag],
    parameters: input.parameters,
    requestBody: input.requestBody,
    security: input.auth === "required" ? [{ bearer: [] }] : [{}, { bearer: [] }],
    responses: {
      [input.status ?? "200"]: jsonResponse(input.responseDescription ?? "OK", input.response),
      ...errorResponses,
      ...(input.withNotFound ? notFound : {}),
      ...(input.auth === "required" ? { "401": jsonResponse("A valid API key is required.", ref("Error")) } : {}),
    },
  };
}

const idParam = (name: string, description: string): Json => ({
  name, in: "path", required: true, description, schema: { type: "string" },
});

const feedResponse = (key: string): Json => obj({
  [key]: arrayOf(ref("ActivityItem")),
  limit: { type: "integer" },
  offset: { type: "integer" },
  next_cursor: nullable(str()),
  has_more: { type: "boolean" },
  meta: ref("Meta"),
});

export function buildOpenApiDocument(baseUrl = "https://api.daildex.com"): Json {
  const recordParams = queryParameters(listShape);
  const memberScoped = queryParameters(listShape, ["representative"]);
  const feedPaths = (kind: string, key: string, label: string) => ({
    [`/v1/${kind}`]: {
      get: operation({
        summary: `List ${label}`,
        description: "Newest first. Text fields are truncated to 500 characters; use the detail route for full text.",
        tag: "Records",
        parameters: recordParams,
        response: feedResponse(key),
      }),
    },
    [`/v1/representatives/{id}/${kind}`]: {
      get: operation({
        summary: `List ${label} for one representative`,
        tag: "Representatives",
        parameters: [idParam("id", "Representative id."), ...memberScoped],
        response: feedResponse(key),
        withNotFound: true,
      }),
    },
  });

  return {
    openapi: "3.1.0",
    info: {
      title: "DáilDex API",
      version: "1.0.0-beta",
      summary: "Structured Oireachtas records with a source link on every item.",
      description: [
        "Votes (divisions), parliamentary questions, debate contributions and bills from the Houses of the Oireachtas, structured and sourced. Dáil only for now; the Seanad is not yet covered. Best-effort beta, no uptime SLA.",
        "",
        "**Authentication** is optional. Anonymous callers get 60 requests/hour per IP. A free API key (`Authorization: Bearer dd_live_...`, create one at https://daildex.com/developers/keys) raises that to 5,000 requests/day. Responses carry `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset`; a 429 adds `Retry-After`.",
        "",
        "**Pagination:** pass `meta.next_cursor` (or the legacy list routes' `next_cursor`) back as `cursor`. `offset` still works on legacy list routes for one version.",
        "",
        "**Updates:** votes, questions and debates are ingested hourly, legislation every 6 hours, members daily.",
        "",
        `**Licence:** ${API_LICENCE.attribution} ${API_LICENCE.url}`,
      ].join("\n"),
      contact: { email: "support@daildex.com", url: "https://daildex.com/developers" },
      license: { name: API_LICENCE.name, url: API_LICENCE.url },
      termsOfService: "https://daildex.com/developers/terms",
    },
    servers: [{ url: baseUrl }],
    tags: [
      { name: "Representatives" }, { name: "Divisions" }, { name: "Records" },
      { name: "Bills" }, { name: "Reference" }, { name: "Webhooks" },
    ],
    paths: {
      "/v1/representatives": {
        get: operation({
          summary: "List representatives",
          description: "Up to 300 members. Defaults to active members.",
          tag: "Representatives",
          parameters: queryParameters(representativeShape),
          response: obj({ representatives: arrayOf(ref("Representative")), meta: ref("Meta") }),
        }),
      },
      "/v1/representatives/{id}": {
        get: operation({
          summary: "Get a representative",
          description: "Includes a summary of the votes and questions DáilDex holds for them.",
          tag: "Representatives",
          parameters: [idParam("id", "Representative id.")],
          response: envelope(ref("RepresentativeDetail")),
          withNotFound: true,
        }),
      },
      ...feedPaths("votes", "votes", "per-member vote rows"),
      ...feedPaths("questions", "questions", "parliamentary questions"),
      ...feedPaths("speeches", "speeches", "debate contributions"),
      "/v1/divisions": {
        get: operation({
          summary: "List divisions",
          description: "One row per division, with outcome and Tá/Níl/Staon tallies.",
          tag: "Divisions",
          parameters: queryParameters(divisionListShape),
          response: envelope(arrayOf(ref("Division"))),
        }),
      },
      "/v1/divisions/{id}": {
        get: operation({
          summary: "Get a division",
          description: "Adds the party breakdown; `?include=members` adds every member's vote.",
          tag: "Divisions",
          parameters: [idParam("id", "Division id (UUID)."), ...queryParameters(divisionDetailShape)],
          response: envelope(ref("DivisionDetail")),
          withNotFound: true,
        }),
      },
      "/v1/questions/{id}": {
        get: operation({
          summary: "Get a parliamentary question",
          description: "Full question text and, when the department has replied, the written answer as plain text.",
          tag: "Records",
          parameters: [idParam("id", "Question id (UUID) from /v1/questions.")],
          response: envelope(ref("QuestionDetail")),
          withNotFound: true,
        }),
      },
      "/v1/speeches/{id}": {
        get: operation({
          summary: "Get a debate contribution",
          description: "Full text, with the debate section heading.",
          tag: "Records",
          parameters: [idParam("id", "Contribution id (UUID) from /v1/speeches.")],
          response: envelope(ref("SpeechDetail")),
          withNotFound: true,
        }),
      },
      "/v1/legislation": {
        get: operation({
          summary: "List bills as activity items",
          description: "Legacy shape. Prefer /v1/bills.",
          tag: "Bills",
          parameters: queryParameters(legislationShape),
          response: feedResponse("legislation"),
        }),
      },
      "/v1/activity": {
        get: operation({
          summary: "Cross-record activity feed",
          description: "Votes, questions, speeches and legislation on one timeline.",
          tag: "Records",
          parameters: queryParameters(activityShape),
          response: feedResponse("items"),
        }),
      },
      "/v1/bills": {
        get: operation({
          summary: "List bills",
          tag: "Bills",
          parameters: queryParameters(billShape),
          response: envelope(arrayOf(ref("Bill"))),
        }),
      },
      "/v1/bills/{year}/{number}": {
        get: operation({
          summary: "Get a bill",
          description: "Stage history, sponsors, linked debates and documents.",
          tag: "Bills",
          parameters: [idParam("year", "Four-digit year, e.g. 2026."), idParam("number", "Bill number within the year.")],
          response: envelope(ref("BillDetail")),
          withNotFound: true,
        }),
      },
      "/v1/parties": {
        get: operation({
          summary: "List parties",
          description: "Parties of active members, with member counts.",
          tag: "Reference",
          response: envelope(arrayOf(ref("Party"))),
        }),
      },
      "/v1/constituencies": {
        get: operation({
          summary: "List constituencies",
          tag: "Reference",
          response: envelope(arrayOf(ref("Constituency"))),
        }),
      },
      "/v1/webhooks": {
        get: operation({
          summary: "List your webhooks",
          tag: "Webhooks",
          auth: "required",
          response: envelope(arrayOf(ref("Webhook")), false),
        }),
        post: operation({
          summary: "Create a webhook",
          description: `Events: ${WEBHOOK_EVENTS.join(", ")}. At most ${MAX_WEBHOOKS_PER_KEY} per key. Deliveries are POSTed as JSON with \`X-DailDex-Signature: sha256=<HMAC-SHA256 of the raw body with the secret>\`, retried with backoff, and the webhook is disabled after repeated failures.`,
          tag: "Webhooks",
          auth: "required",
          status: "201",
          requestBody: { required: true, content: { "application/json": { schema: ref("CreateWebhook") } } },
          response: envelope(ref("WebhookCreated"), false),
        }),
      },
      "/v1/webhooks/{id}": {
        delete: operation({
          summary: "Delete a webhook",
          tag: "Webhooks",
          auth: "required",
          parameters: [idParam("id", "Webhook id.")],
          response: envelope(obj({ deleted: { type: "boolean" } }), false),
          withNotFound: true,
        }),
      },
      "/v1/webhooks/{id}/deliveries": {
        get: operation({
          summary: "Recent deliveries for a webhook",
          tag: "Webhooks",
          auth: "required",
          parameters: [idParam("id", "Webhook id.")],
          response: envelope(arrayOf(ref("WebhookDelivery")), false),
          withNotFound: true,
        }),
      },
    },
    components: {
      schemas,
      securitySchemes: {
        bearer: { type: "http", scheme: "bearer", description: "Optional API key: `dd_live_...`." },
      },
    },
  };
}
