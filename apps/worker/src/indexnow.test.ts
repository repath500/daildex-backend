import { describe, expect, it, vi } from "vitest";
import { INDEXNOW_KEY, submitIndexNow } from "./indexnow";

describe("IndexNow", () => {
  it("submits same-host URLs with the published key location", async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 202 }));
    const result = await submitIndexNow(
      ["https://www.daildex.com/news/a", "https://www.daildex.com/news/a", "https://evil.example/x"],
      { siteUrl: "https://www.daildex.com", fetch: fetchFn as unknown as typeof fetch },
    );
    expect(result).toEqual({ ok: true, status: 202 });
    const body = JSON.parse(String((fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body).toEqual({
      host: "www.daildex.com",
      key: INDEXNOW_KEY,
      keyLocation: `https://www.daildex.com/${INDEXNOW_KEY}.txt`,
      urlList: ["https://www.daildex.com/news/a"],
    });
  });

  it("never throws when the service is unreachable", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("offline");
    });
    expect(await submitIndexNow(["https://www.daildex.com/news/a"], { siteUrl: "https://www.daildex.com", fetch: fetchFn as unknown as typeof fetch })).toEqual({ ok: false, status: null });
  });
});
