import { describe, expect, it, vi } from "vitest";
import { ResendEmailProvider } from "./resend";

describe("ResendEmailProvider", () => {
  it("adds RFC one-click unsubscribe headers when an unsubscribe endpoint is supplied", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ id: "re_123" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await new ResendEmailProvider("resend_test_key", "DáilDex <alerts@example.test>").send({
      id: "outbox_123",
      recipient: "person@example.test",
      subject: "A civic alert",
      text: "An alert",
      html: "<p>An alert</p>",
      unsubscribeApiUrl: "https://daildex.example/api/unsubscribe/token-123",
    });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const requestBody = JSON.parse(String(init?.body)) as { headers: Record<string, string> };
    expect(requestBody.headers).toMatchObject({
      "List-Unsubscribe": "<https://daildex.example/api/unsubscribe/token-123>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
    vi.unstubAllGlobals();
  });
});
