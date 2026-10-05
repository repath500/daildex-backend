import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { extractJsonMiddleware, wrapLanguageModel } from "ai";
import { resolveEditorialModelId } from "@daildex/shared";
import { OPENROUTER_REFERER } from "@daildex/shared/openrouter";

/** Inject OpenRouter's server-tool `allowed_domains` without adding a source cap. */
export function editorialOpenRouterFetch(allowedDomains: readonly string[], baseFetch: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    if (typeof init?.body !== "string") return baseFetch(input, init);
    try {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      if (!Array.isArray(body.tools)) return baseFetch(input, init);
      body.tools = body.tools.map((tool) => {
        if (typeof tool !== "object" || tool === null || !("type" in tool) || tool.type !== "openrouter:web_search") return tool;
        const record = tool as Record<string, unknown>;
        const { type, parameters, ...flatArgs } = record;
        return {
          type,
          parameters: {
            ...(typeof parameters === "object" && parameters !== null ? parameters : {}),
            ...flatArgs,
            allowed_domains: [...allowedDomains],
          },
        };
      });
      return baseFetch(input, { ...init, body: JSON.stringify(body) });
    } catch {
      return baseFetch(input, init);
    }
  };
}

/** Structured JSON comes back in content only when reasoning is off. */
export function createEditorialModel(allowedDomains: readonly string[], baseFetch?: typeof fetch, modelOverride?: string) {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is required for editorial generation");
  const modelId = modelOverride ?? resolveEditorialModelId();
  const provider = createOpenRouter({
    apiKey,
    compatibility: "strict",
    appName: "DáilDex News",
    appUrl: OPENROUTER_REFERER,
    fetch: editorialOpenRouterFetch(allowedDomains, baseFetch),
  });
  return {
    modelId,
    model: wrapLanguageModel({
      model: provider.chat(modelId, {
        reasoning: { effort: "none" },
        structuredOutputs: { strict: false },
      }),
      middleware: extractJsonMiddleware(),
    }),
    webSearch: provider.tools.webSearch({ engine: "exa" }),
  };
}

/** OpenRouter's Exa web search regularly takes 60-90 seconds; allow for it. */
export function editorialSearchTimeoutMs(value = process.env.EDITORIAL_SEARCH_TIMEOUT_MS): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.max(10_000, Math.min(parsed, 5 * 60 * 1000)) : 150_000;
}

/**
 * OpenRouter bills web search per result, so the count is the main cost lever.
 * Story research needs a handful of pages; discovery needs a wider net.
 */
export const RESEARCH_SEARCH_RESULTS = 6;
export const DISCOVERY_SEARCH_RESULTS = 12;

export async function searchEditorialWeb(
  query: string,
  domains: readonly string[],
  maxResults: number = RESEARCH_SEARCH_RESULTS,
): Promise<unknown[]> {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is required for editorial generation");
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": OPENROUTER_REFERER,
      "X-Title": "DailDex News",
    },
    body: JSON.stringify({
      model: resolveEditorialModelId(),
      // Only the search annotations are used. A small completion stops the
      // model after its search call (~15 s instead of 35-150 s), and
      // max_results caps what OpenRouter charges for the search.
      max_tokens: 64,
      reasoning: { effort: "none" },
      messages: [{ role: "user", content: query }],
      tools: [{
        type: "openrouter:web_search",
        parameters: { engine: "exa", allowed_domains: [...domains], max_results: Math.max(1, Math.min(Math.floor(maxResults), 25)) },
      }],
    }),
    signal: AbortSignal.timeout(editorialSearchTimeoutMs()),
  });
  if (!response.ok) throw new Error(`OpenRouter search returned HTTP ${response.status}`);
  const payload = await response.json() as {
    choices?: Array<{ message?: { annotations?: unknown[] } }>;
  };
  const annotations = payload.choices?.[0]?.message?.annotations;
  return Array.isArray(annotations) ? annotations : [];
}

export function editorialModelError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Editorial model call failed";
  const text = error && typeof error === "object" && "text" in error && typeof error.text === "string"
    ? error.text.replace(/\s+/g, " ").slice(0, 280)
    : "";
  return text ? `${message} Response: ${text}` : message;
}
