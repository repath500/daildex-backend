import { describe, expect, it } from "vitest";
import { AI_REVIEW_MODEL, aiReviewEnabled, reviewAlertWithModel } from "./ai-review";

const input = {
  eventType: "vote",
  representativeName: "Denise Mitchell",
  participation: "Níl",
  headline: "Denise Mitchell votes against the motion",
  summary: "Mitchell voted Níl.",
  explanation: "The Dáil divided on the motion and Mitchell voted against.",
  recordText: "Division 12. Níl: Mitchell, Denise.",
};

function reply(content: string): typeof fetch {
  return (async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }))) as typeof fetch;
}

describe("alert AI review", () => {
  it("sends the draft and record to the pinned model and reads an approval", async () => {
    let body: { model: string; messages: Array<{ content: string }> } | undefined;
    const fetcher = (async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"verdict":"approve","reasons":[]}' } }] }));
    }) as typeof fetch;
    const result = await reviewAlertWithModel(input, { fetch: fetcher, apiKey: "key" });
    expect(result.verdict).toBe("approve");
    expect(body?.model).toBe(AI_REVIEW_MODEL);
    expect(body?.messages[1]?.content).toContain("Division 12");
  });

  it("holds with the reviewer's reasons, even when the JSON is wrapped in prose", async () => {
    const result = await reviewAlertWithModel(input, {
      fetch: reply('Here you go: {"verdict":"hold","reasons":["date not in record"]}'),
      apiKey: "key",
    });
    expect(result).toEqual({ verdict: "hold", reasons: ["date not in record"] });
  });

  it("throws on bad output or an HTTP error so the draft is retried, never approved", async () => {
    await expect(reviewAlertWithModel(input, { fetch: reply("looks fine"), apiKey: "key" })).rejects.toThrow();
    await expect(reviewAlertWithModel(input, { fetch: reply('{"verdict":"maybe"}'), apiKey: "key" })).rejects.toThrow();
    const failing = (async () => new Response("no", { status: 503 })) as typeof fetch;
    await expect(reviewAlertWithModel(input, { fetch: failing, apiKey: "key" })).rejects.toThrow("503");
  });

  it("is on when a key exists and can be switched off", () => {
    expect(aiReviewEnabled({ OPENROUTER_API_KEY: "k" } as NodeJS.ProcessEnv)).toBe(true);
    expect(aiReviewEnabled({ OPENROUTER_API_KEY: "k", ALERT_AI_REVIEW: "false" } as NodeJS.ProcessEnv)).toBe(false);
    expect(aiReviewEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });
});
