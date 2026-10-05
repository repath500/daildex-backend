import { buildOpenApiDocument } from "@daildex/core/public-api/openapi";
import { MemoryRateLimiter } from "@daildex/core/public-api/rate-limit";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";

const KEY = `dd_live_${"a".repeat(32)}`;

function app(overrides: Parameters<typeof createApp>[0] = {}) {
  return createApp({
    limiter: new MemoryRateLimiter(),
    resolveKey: async (key) => (key === KEY ? { id: "00000000-0000-4000-8000-000000000001", tier: "free" } : null),
    ...overrides,
  });
}

const mcp = (instance: ReturnType<typeof app>, body: unknown, headers: Record<string, string> = {}) =>
  instance.request("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });

describe("public API surface", () => {
  it("describes itself at / and /v1", async () => {
    for (const path of ["/", "/v1"]) {
      const response = await app().request(path);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ openapi: "https://api.daildex.com/openapi.json" });
    }
  });

  it("serves an OpenAPI 3.1 document and the interactive docs", async () => {
    const spec = await app().request("/openapi.json");
    expect(spec.status).toBe(200);
    expect(spec.headers.get("access-control-allow-origin")).toBe("*");
    await expect(spec.json()).resolves.toMatchObject({ openapi: "3.1.0", info: { title: "DáilDex API" } });
    const docs = await app().request("/docs");
    expect(docs.status).toBe(200);
    expect(await docs.text()).toContain("/openapi.json");
  });

  it("documents exactly the /v1 routes that exist", () => {
    const documented = Object.entries(buildOpenApiDocument().paths as Record<string, Record<string, unknown>>)
      .flatMap(([path, methods]) => Object.keys(methods).map((method) => `${method.toUpperCase()} ${path.replace(/\{(\w+)\}/g, ":$1")}`))
      .sort();
    const implemented = app().routes
      .filter((route) => route.path.startsWith("/v1/") && route.method !== "ALL")
      .map((route) => `${route.method} ${route.path}`)
      .filter((entry, index, all) => all.indexOf(entry) === index)
      .filter((entry) => entry !== "GET /v1/")
      .sort();
    expect(implemented).toEqual(documented);
  });

  it("publishes the MCP registry description", async () => {
    const response = await app().request("/.well-known/mcp/server.json");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      name: "com.daildex/oireachtas",
      remotes: [{ type: "streamable-http", url: "https://api.daildex.com/mcp" }],
    });
  });

  it("opens CORS to any origin for reads and exposes the rate-limit headers", async () => {
    const preflight = await app().request("/v1/votes", {
      method: "OPTIONS",
      headers: { origin: "https://example.org", "access-control-request-method": "GET" },
    });
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    const response = await app().request("/v1/votes?limit=0", { headers: { origin: "https://example.org" } });
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-expose-headers")).toContain("RateLimit-Remaining");
  });

  it("answers bad input with structured field errors, including unknown parameters", async () => {
    const response = await app().request("/v1/votes?limit=500&nonsense=1");
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json() as { error: { code: string; fields: Array<{ field: string }> } };
    expect(body.error.code).toBe("INVALID_REQUEST");
    expect(body.error.fields.map((entry) => entry.field).sort()).toEqual(["limit", "nonsense"]);
    expect((await app().request("/v1/divisions?chamber=xyz")).status).toBe(400);
    expect((await app().request("/v1/representatives?chamber=xyz")).status).toBe(400);
    expect((await app().request("/v1/parties?x=1")).status).toBe(400);
  });

  it("returns a JSON 404 envelope for unknown /v1 routes and drops the old personal-data routes", async () => {
    for (const [method, path] of [["GET", "/v1/nope"], ["POST", "/v1/subscriptions"], ["GET", "/v1/manage/abc"], ["POST", "/v1/unsubscribe/abc"]] as const) {
      const response = await app().request(path, { method });
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({ error: { code: "NOT_FOUND" } });
    }
  });
});

describe("rate limiting", () => {
  it("publishes RateLimit headers and returns 429 with Retry-After", async () => {
    const instance = app({ limiter: new MemoryRateLimiter() });
    const headers = { "x-real-ip": "198.51.100.7" };
    let last: Response | undefined;
    for (let index = 0; index < 61; index += 1) last = await instance.request("/v1/votes?limit=0", { headers });
    expect(last!.status).toBe(429);
    expect(last!.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(last!.headers.get("ratelimit-limit")).toBe("60");
    expect(last!.headers.get("ratelimit-remaining")).toBe("0");
    await expect(last!.json()).resolves.toMatchObject({ error: { code: "RATE_LIMITED" } });
  });

  it("counts a request to /v1 once, not once per matching guard registration", async () => {
    const instance = app({ limiter: new MemoryRateLimiter() });
    const headers = { "x-real-ip": "198.51.100.9" };
    const first = await instance.request("/v1", { headers });
    const second = await instance.request("/v1", { headers });
    expect(Number(first.headers.get("ratelimit-remaining")) - Number(second.headers.get("ratelimit-remaining"))).toBe(1);
    expect(first.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("cannot be bypassed with a forged X-Forwarded-For", async () => {
    const instance = app({ limiter: new MemoryRateLimiter() });
    let last: Response | undefined;
    for (let index = 0; index < 61; index += 1) {
      last = await instance.request("/v1/votes?limit=0", {
        headers: { "x-real-ip": "198.51.100.8", "x-forwarded-for": `10.0.0.${index}, 198.51.100.8` },
      });
    }
    expect(last!.status).toBe(429);
  });

  it("gives a valid API key its own, larger allowance", async () => {
    const instance = app({ limiter: new MemoryRateLimiter() });
    const headers = { "x-real-ip": "198.51.100.9", authorization: `Bearer ${KEY}` };
    const response = await instance.request("/v1/votes?limit=0", headers ? { headers } : undefined);
    expect(response.headers.get("ratelimit-limit")).toBe("5000");
  });

  it("rejects a malformed or unknown key instead of silently treating it as anonymous", async () => {
    const wrong = await app().request("/v1/votes?limit=0", { headers: { authorization: "Bearer nope" } });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("www-authenticate")).toContain("Bearer");
    const unknown = await app().request("/v1/votes?limit=0", { headers: { authorization: `Bearer dd_live_${"b".repeat(32)}` } });
    expect(unknown.status).toBe(401);
  });

  it("requires a key for webhooks", async () => {
    const response = await app().request("/v1/webhooks");
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "UNAUTHORIZED" } });
  });
});

describe("public MCP server", () => {
  it("initialises and lists nine read-only tools", async () => {
    const instance = app();
    const init = await mcp(instance, {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    });
    expect(init.status).toBe(200);
    const initBody = await init.json() as { result: { instructions: string; serverInfo: { name: string } } };
    expect(initBody.result.serverInfo.name).toBe("daildex");
    expect(initBody.result.instructions).toContain("Oireachtas (Open Data) PSI Licence");

    const list = await mcp(instance, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, { "mcp-protocol-version": "2025-06-18" });
    const body = await list.json() as { result: { tools: Array<{ name: string; annotations: { readOnlyHint: boolean } }> } };
    expect(body.result.tools.map((tool) => tool.name).sort()).toEqual([
      "find_representative", "get_activity", "get_bill", "get_division", "get_representative",
      "how_did_they_vote", "search_debates", "search_divisions", "search_questions",
    ]);
    expect(body.result.tools.every((tool) => tool.annotations.readOnlyHint === true)).toBe(true);
  });

  it("answers a tool call with a clear error rather than failing the request", async () => {
    const response = await mcp(app(), {
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "get_bill", arguments: {} },
    }, { "mcp-protocol-version": "2025-06-18" });
    const body = await response.json() as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]!.text).toContain("year and number");
  });

  it("rate-limits on its own, roomier anonymous tier and refuses GET", async () => {
    const response = await mcp(app(), { jsonrpc: "2.0", id: 4, method: "ping" });
    expect(response.headers.get("ratelimit-limit")).toBe("600");
    expect((await app().request("/mcp")).status).toBe(405);
  });
});
