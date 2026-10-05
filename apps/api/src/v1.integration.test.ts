/* eslint-disable @typescript-eslint/no-explicit-any -- response bodies are asserted field by field */
import { createHmac } from "node:crypto";
import type { Database } from "@daildex/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.PUBLIC_API_TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

describeDb("public API over HTTP against a real database", () => {
  // The app and the test share one pooled connection (the app's own), so a single-connection
  // Postgres stand-in works as well as a real server.
  let database: Database;
  const ids: Record<string, string> = {};
  let key = "";
  let keyId = "";
  let app: ReturnType<typeof import("./app").createApp>;
  let queueWebhookEvents: typeof import("@daildex/core/public-api/webhooks").queueWebhookEvents;
  let deliverDueWebhooks: typeof import("@daildex/core/public-api/webhooks").deliverDueWebhooks;
  let webhookSecret: typeof import("@daildex/core/public-api/webhooks").webhookSecret;

  const get = (path: string, init?: RequestInit) => app.request(path, init);
  const authed = (extra: RequestInit = {}): RequestInit => ({
    ...extra,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...(extra.headers as Record<string, string> | undefined) },
  });
  const mcpCall = async (name: string, args: Record<string, unknown>) => {
    const response = await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    return (await response.json() as { result: { isError?: boolean; content: Array<{ text: string }>; structuredContent?: Record<string, any> } }).result;
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.DATABASE_POOL_SIZE = "1";
    process.env.TOKEN_HASH_PEPPER = "integration-pepper";
    const { getDatabase } = await import("@daildex/db");
    database = getDatabase();
    const { createApp } = await import("./app");
    const keys = await import("@daildex/core/public-api/keys");
    const fixtures = await import("@daildex/core/public-api/test-fixtures");
    ({ queueWebhookEvents, deliverDueWebhooks, webhookSecret } = await import("@daildex/core/public-api/webhooks"));
    app = createApp();
    Object.assign(ids, await fixtures.seedPublicApiFixtures(database));
    const [profile] = await database<{ id: string }[]>`
      INSERT INTO chat_profiles (email, first_name, token_hash) VALUES ('api-test@example.org', 'Api', 'test-token-hash') RETURNING id
    `;
    ids.profile = profile!.id;
    const created = await keys.createApiKey({ profileId: profile!.id, name: "integration" }, database);
    key = created.key;
    keyId = created.id;
  });

  afterAll(async () => {
    const fixtures = await import("@daildex/core/public-api/test-fixtures");
    await database`DELETE FROM td_facts WHERE source_url LIKE 'https://example.org/test-%'`;
    await database`DELETE FROM api_webhook_checkpoints`;
    await database`DELETE FROM chat_profiles WHERE email = 'api-test@example.org'`;
    await fixtures.cleanupPublicApiFixtures(database);
    const { closeDatabase } = await import("@daildex/db");
    await closeDatabase();
  });

  it("serves a division with party breakdown and members over HTTP, with cache headers", async () => {
    const response = await get(`/v1/divisions/${ids.vote_2}?include=members`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=60, s-maxage=300");
    const body = await response.json() as { data: any; meta: any };
    expect(body.data.members).toHaveLength(2);
    expect(body.meta.licence.attribution).toContain("PSI Licence");
  });

  it("answers missing records with a JSON 404 and bad ids without a 500", async () => {
    for (const path of ["/v1/divisions/nope", "/v1/questions/nope", "/v1/speeches/nope", "/v1/bills/2026/1", "/v1/bills/abcd/1", "/v1/representatives/nobody", "/v1/representatives/nobody/votes"]) {
      const response = await get(path);
      expect(response.status, path).toBe(404);
      await expect(response.json()).resolves.toMatchObject({ error: { code: "NOT_FOUND" } });
    }
  });

  it("scopes member feeds by path and rejects a conflicting representative parameter", async () => {
    const ok = await get("/v1/representatives/t-jane-murphy/votes");
    const body = await ok.json() as { votes: any[]; meta: any };
    expect(body.votes).toHaveLength(2);
    expect(body.votes.every((vote) => vote.representative.id === "t-jane-murphy")).toBe(true);
    expect((await get("/v1/representatives/t-jane-murphy/votes?representative=x")).status).toBe(400);
  });

  it("returns the question's answer and the speech's section over HTTP", async () => {
    const question = await (await get(`/v1/questions/${ids.question}`)).json() as { data: any };
    expect(question.data.answer).toContain("10,000 homes");
    const speech = await (await get(`/v1/speeches/${ids.speech}`)).json() as { data: any };
    expect(speech.data.section).toBe("Housing Delivery Statements");
  });

  it("answers the MCP how_did_they_vote tool with sourced votes", async () => {
    const result = await mcpCall("how_did_they_vote", { representative: "t-jane-murphy", topic: "housing bill" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain("Tá 2");
    expect(result.structuredContent!.votes).toHaveLength(2);
    expect(result.structuredContent!.votes[0].sourceUrl).toContain("https://www.oireachtas.ie/en/debates/vote/");
    expect(result.structuredContent!.licence.name).toContain("PSI");

    const found = await mcpCall("find_representative", { query: "murphy" });
    expect(found.structuredContent!.representatives.map((rep: any) => rep.id)).toEqual(["t-jane-murphy"]);

    const withAnswers = await mcpCall("search_questions", { query: "social homes", include_answers: true });
    expect(withAnswers.structuredContent!.questions[0].answer).toContain("10,000 homes");

    const bill = await mcpCall("get_bill", { year: "2026", number: "9042" });
    expect(bill.structuredContent!.bill.stages).toHaveLength(2);
    expect((await mcpCall("get_division", { id: "00000000-0000-4000-8000-000000000000" })).isError).toBe(true);
  });

  it("manages webhooks for a key, rejecting unsafe URLs", async () => {
    for (const bad of ["http://example.org/hook", "https://127.0.0.1/hook", "https://localhost/hook"]) {
      const response = await get("/v1/webhooks", authed({ method: "POST", body: JSON.stringify({ url: bad, events: ["division.created"] }) }));
      expect(response.status, bad).toBe(400);
    }
    expect((await get("/v1/webhooks", authed({ method: "POST", body: "{not json" }))).status).toBe(400);
    expect((await get("/v1/webhooks", authed({ method: "POST", body: JSON.stringify({ url: "https://hooks.example.org/a", events: ["division.created"], representative: "nobody" }) }))).status).toBe(400);

    const created = await get("/v1/webhooks", authed({
      method: "POST",
      body: JSON.stringify({ url: "https://hooks.example.org/a", events: ["division.created", "question.created"], representative: "t-jane-murphy" }),
    }));
    expect(created.status).toBe(201);
    const { data } = await created.json() as { data: { id: string; secret: string; events: string[] } };
    expect(data.secret).toBe(webhookSecret(data.id));
    ids.webhook = data.id;

    const listed = await (await get("/v1/webhooks", authed())).json() as { data: Array<Record<string, unknown>> };
    expect(listed.data).toHaveLength(1);
    expect(listed.data[0]).not.toHaveProperty("secret");
  });

  it("queues each new division and question once and delivers them signed, retrying failures", async () => {
    await database`UPDATE api_webhooks SET created_at = now() - interval '30 minutes' WHERE id = ${ids.webhook!}::UUID`;
    await database`UPDATE official_contributions SET created_at = now() - interval '15 minutes' WHERE id = ${ids.question!}::UUID`;
    await database`UPDATE official_documents SET document_date = current_date WHERE title = 'Housing Policy'`;
    await database`
      INSERT INTO td_facts (representative_id, fact_type, fact_payload, source_url, source_event_id, effective_at, created_at)
      VALUES (${ids["t-jane-murphy"]!}::UUID, 'vote', jsonb_build_object('date', current_date::TEXT), 'https://example.org/test-fact', ${ids.vote_2!}::UUID, now(), now() - interval '15 minutes')
    `;

    // A record still inside the settle window is left for a later scan: its transaction may not have committed yet.
    await database`UPDATE td_facts SET created_at = now() - interval '2 minutes' WHERE source_url = 'https://example.org/test-fact'`;
    expect(await queueWebhookEvents(database)).toBe(1);
    await database`UPDATE td_facts SET created_at = now() - interval '15 minutes' WHERE source_url = 'https://example.org/test-fact'`;
    await database`UPDATE api_webhook_checkpoints SET scanned_through = now() - interval '1 hour'`;
    expect(await queueWebhookEvents(database)).toBe(1); // the question was already queued; only the division is new
    expect(await queueWebhookEvents(database)).toBe(0); // idempotent
    await database`DELETE FROM api_webhook_deliveries`;
    await database`UPDATE api_webhook_checkpoints SET scanned_through = now() - interval '1 hour'`;
    expect(await queueWebhookEvents(database)).toBe(2);
    await database`DELETE FROM api_webhook_deliveries`;

    // A backfill stores old records with a fresh created_at; those must not be announced.
    await database`UPDATE td_facts SET fact_payload = jsonb_build_object('date', '2024-12-01'), created_at = now() - interval '15 minutes' WHERE source_url = 'https://example.org/test-fact'`;
    await database`DELETE FROM api_webhook_deliveries`;
    await database`UPDATE api_webhook_checkpoints SET scanned_through = now() - interval '1 hour'`;
    await database`UPDATE official_documents SET document_date = '2024-12-01' WHERE title = 'Housing Policy'`;
    expect(await queueWebhookEvents(database)).toBe(0);
    await database`UPDATE td_facts SET fact_payload = jsonb_build_object('date', current_date::TEXT) WHERE source_url = 'https://example.org/test-fact'`;
    await database`UPDATE official_documents SET document_date = current_date WHERE title = 'Housing Policy'`;
    await database`UPDATE api_webhook_checkpoints SET scanned_through = now() - interval '1 hour'`;
    expect(await queueWebhookEvents(database)).toBe(2);

    const sent: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
    const first = await deliverDueWebhooks({
      post: async (target, body, headers) => {
        sent.push({ url: target, body, headers });
        return { status: sent.length === 1 ? 200 : 500 };
      },
    }, database);
    expect(first).toEqual({ delivered: 1, retried: 1, dead: 0 });
    expect(sent).toHaveLength(2);
    const delivered = sent[0]!;
    expect(delivered.url).toBe("https://hooks.example.org/a");
    // The signature covers the timestamp as well as the body, so a captured delivery can't be replayed later.
    expect(delivered.headers["x-daildex-signature"]).toBe(`sha256=${createHmac("sha256", webhookSecret(ids.webhook!)).update(`${delivered.headers["x-daildex-timestamp"]}.${delivered.body}`).digest("hex")}`);
    const payload = JSON.parse(delivered.body) as { id: string; type: string; data: any };
    expect(["division.created", "question.created"]).toContain(payload.type);
    expect(payload.data.id).toBeTruthy();

    const deliveries = await (await get(`/v1/webhooks/${ids.webhook}/deliveries`, authed())).json() as { data: any[] };
    expect(deliveries.data.map((entry) => entry.status).sort()).toEqual(["delivered", "pending"]);
    expect(deliveries.data.find((entry) => entry.status === "pending").lastError).toContain("HTTP 500");
    expect(await deliverDueWebhooks({ post: async () => ({ status: 200 }) }, database)).toEqual({ delivered: 0, retried: 0, dead: 0 }); // not due yet
  });

  it("keeps webhooks private to the key that owns them, and revoked keys stop working", async () => {
    const keys = await import("@daildex/core/public-api/keys");
    const other = await keys.createApiKey({ profileId: ids.profile!, name: "second" }, database);
    const stranger = await get(`/v1/webhooks/${ids.webhook}`, { method: "DELETE", headers: { authorization: `Bearer ${other.key}` } });
    expect(stranger.status).toBe(404);
    expect((await (await get("/v1/webhooks", { headers: { authorization: `Bearer ${other.key}` } })).json() as { data: unknown[] }).data).toHaveLength(0);

    const removed = await get(`/v1/webhooks/${ids.webhook}`, authed({ method: "DELETE" }));
    expect(removed.status).toBe(200);
    expect((await get(`/v1/webhooks/${ids.webhook}`, authed({ method: "DELETE" }))).status).toBe(404);

    expect(await keys.revokeApiKey(ids.profile!, other.id, database)).toBe(true);
    await database`UPDATE api_keys SET revoked_at = now() WHERE id = ${keyId}::UUID`;
    // The resolver caches for a minute, so a fresh app instance proves revocation is honoured.
    const { createApp } = await import("./app");
    expect((await createApp().request("/v1/webhooks", { headers: { authorization: `Bearer ${key}` } })).status).toBe(401);
  });
});
