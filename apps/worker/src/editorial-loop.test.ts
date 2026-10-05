import { describe, expect, it } from "vitest";
import { editorialOpenRouterFetch } from "./editorial-loop";

describe("editorial OpenRouter middleware", () => {
  it("injects an allow-list without a per-run result cap", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const baseFetch: typeof fetch = async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response("ok");
    };
    const fetchWithPolicy = editorialOpenRouterFetch(["rte.ie", "waterford-news.ie"], baseFetch);
    await fetchWithPolicy("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        tools: [{ type: "openrouter:web_search", parameters: { engine: "exa" } }],
      }),
    });
    const tool = (requestBody?.tools as Array<Record<string, unknown>>)[0];
    expect((tool.parameters as Record<string, unknown>).allowed_domains).toEqual(["rte.ie", "waterford-news.ie"]);
    expect(tool.parameters).not.toHaveProperty("max_results");
    expect(tool.parameters).not.toHaveProperty("max_total_results");
  });
});


describe("editorial search timeout", () => {
  it("defaults long enough for OpenRouter web search and stays bounded", async () => {
    const { editorialSearchTimeoutMs } = await import("./editorial-openrouter");
    expect(editorialSearchTimeoutMs(undefined)).toBe(150_000);
    expect(editorialSearchTimeoutMs("1000")).toBe(10_000);
    expect(editorialSearchTimeoutMs("9999999")).toBe(300_000);
  });
});

describe("editorial event labels", () => {
  it("drops category names so the headline becomes the subject", async () => {
    const { usableEventLabel } = await import("./editorial-media");
    expect(usableEventLabel("policy_announcement")).toBeNull();
    expect(usableEventLabel("some_other_label")).toBeNull();
    expect(usableEventLabel("  ")).toBeNull();
    expect(usableEventLabel("Cabinet approves heating oil tax cut")).toBe("Cabinet approves heating oil tax cut");
  });
});
