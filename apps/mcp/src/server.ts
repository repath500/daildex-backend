import { officialSearchSchema, searchOfficialOireachtas } from "@daildex/core/official-data";
import { alertAgentDecisionSchema, alertDraftSchema } from "@daildex/shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const scopeTokenSchema = z.string().trim().min(1).max(4096);
const representativeIdSchema = z.string().trim().min(1).max(100);

type ApiConfig = { baseUrl: string; token: string };

function getApiConfig(): ApiConfig {
  const baseUrl = process.env.DAILDEX_INTERNAL_API_URL?.replace(/\/$/, "");
  const token = process.env.DAILDEX_AGENT_TOKEN?.trim();
  if (!baseUrl || !token) throw new Error("DAILDEX_INTERNAL_API_URL and DAILDEX_AGENT_TOKEN are required");
  return { baseUrl, token };
}

const server = new McpServer({ name: "daildex", version: "0.1.0" });

server.registerTool(
  "get_claimed_event",
  {
    description: "Read the one official event currently leased to this alert worker. The scope token is an opaque capability and must never be shown to the user.",
    inputSchema: { scopeToken: scopeTokenSchema },
  },
  async ({ scopeToken }) => toolResult(await apiJson("/internal/agent/claimed-target", { scopeToken })),
);

server.registerTool(
  "get_td_history",
  {
    description: "Read a bounded, most-recent-first history of facts for a representative from DáilDex.",
    inputSchema: {
      scopeToken: scopeTokenSchema,
      representativeId: representativeIdSchema,
      limit: z.number().int().min(1).max(50).default(20),
    },
  },
  async ({ scopeToken, representativeId, limit }) => toolResult(await apiJson(
    `/internal/agent/representatives/${encodeURIComponent(representativeId)}/history?limit=${limit}`,
    { scopeToken },
  )),
);

server.registerTool(
  "find_similar_previous_alerts",
  {
    description: "Find bounded previous non-rejected alerts for a representative using a phrase match. This is context only; it does not authorize adding unsupported claims.",
    inputSchema: {
      scopeToken: scopeTokenSchema,
      representativeId: representativeIdSchema,
      query: z.string().trim().max(120).default(""),
      limit: z.number().int().min(1).max(25).default(10),
    },
  },
  async ({ scopeToken, representativeId, query, limit }) => toolResult(await apiJson(
    `/internal/agent/representatives/${encodeURIComponent(representativeId)}/alerts?q=${encodeURIComponent(query)}&limit=${limit}`,
    { scopeToken },
  )),
);

server.registerTool(
  "search_official_records",
  {
    description: "Search a bounded 120-day window of official Houses of the Oireachtas records. Use only for context and cite the returned official URLs in the application layer.",
    inputSchema: officialSearchSchema.shape,
  },
  async (input) => toolResult(await searchOfficialOireachtas(officialSearchSchema.parse(input))),
);

server.registerTool(
  "submit_alert_draft",
  {
    description: "Submit exactly one strictly validated DáilDex alert draft for the currently leased event. The application supplies source URL and entity IDs; never include them in the draft.",
    inputSchema: {
      scopeToken: scopeTokenSchema,
      draft: alertDraftSchema,
    },
  },
  async ({ scopeToken, draft }) => toolResult(await apiJson("/internal/agent/draft", {
    scopeToken,
    method: "POST",
    body: JSON.stringify({ draft }),
  })),
);

server.registerTool(
  "record_alert_outcome",
  {
    description: "Record a bounded non-draft outcome for the currently leased event: skip it, merge it into an existing alert for the same representative, or hold it for more context. Call this exactly once instead of submit_alert_draft when no new alert should be written.",
    inputSchema: {
      scopeToken: scopeTokenSchema,
      decision: alertAgentDecisionSchema,
    },
  },
  async ({ scopeToken, decision }) => toolResult(await apiJson("/internal/agent/outcome", {
    scopeToken,
    method: "POST",
    body: JSON.stringify({ decision }),
  })),
);

function toolResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

async function apiJson(
  path: string,
  options: { scopeToken?: string; method?: string; body?: string } = {},
) {
  const config = getApiConfig();
  const response = await fetch(`${config.baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: {
      Authorization: `Bearer ${config.token}`,
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.scopeToken ? { "x-daildex-agent-scope": options.scopeToken } : {}),
    },
    body: options.body,
    signal: AbortSignal.timeout(15_000),
  });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = { error: "DáilDex returned a non-JSON response." };
  }
  if (!response.ok) {
    const message = body && typeof body === "object" && "message" in body && typeof body.message === "string"
      ? body.message
      : `DáilDex returned HTTP ${response.status}.`;
    throw new Error(message.slice(0, 300));
  }
  return body;
}

async function main() {
  getApiConfig();
  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  process.stderr.write(`DáilDex MCP server failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
  process.exitCode = 1;
});
