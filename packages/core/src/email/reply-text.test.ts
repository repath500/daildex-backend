import { describe, expect, it } from "vitest";
import { extractEmailReply } from "./reply-text";
import { classifyReply, normalizeResendInbound } from "./provider-webhooks";

describe("email reply extraction", () => {
  it("recovers an HTML-only Apple Mail reply without the signature or alert", () => {
    const inbound = normalizeResendInbound({
      id: "received-apple", text: null,
      html: '<html><head><style>hidden</style></head><body>Explained simpler&nbsp;<br id="lineBreakAtBeginningOfSignature"><div>Sent from my iPhone</div><blockquote type="cite">On 30 Sep, DáilDex wrote:<p>Manage alerts · Unsubscribe</p></blockquote></body></html>',
    });
    expect(inbound.strippedTextReply).toBe("Explained simpler");
    expect(classifyReply(inbound.strippedTextReply)).toBe("unknown");
  });

  it.each([
    '<p>Cad a chiallaíonn sé?</p><div class="gmail_quote"><p>Unsubscribe</p></div>',
    '<p>Cad a chiallaíonn sé?</p><div id="divRplyFwdMsg">From: DáilDex</div><p>Unsubscribe</p>',
    '<p>Cad a chiallaíonn sé?</p><blockquote><blockquote>Unsubscribe</blockquote></blockquote>',
  ])("removes quoted HTML and preserves Irish text", (html) => {
    expect(extractEmailReply("", html)).toBe("Cad a chiallaíonn sé?");
  });

  it("decodes entities and keeps paragraph boundaries while ignoring executable content", () => {
    expect(extractEmailReply("", '<script>unsubscribe</script><style>hidden</style><p>What &#100;oes &quot;Tá&quot; mean?</p><p>A &amp; B</p>'))
      .toBe('What does "Tá" mean?\n\nA & B');
  });

  it("prefers plain text and stops at unprefixed quoted history", () => {
    expect(extractEmailReply("Explain this\r\n\r\nOn Tue, DáilDex wrote:\r\nUnsubscribe", "<p>Other content</p>"))
      .toBe("Explain this");
  });

  it("does not turn a quote-only message into a question", () => {
    expect(extractEmailReply("> quoted alert", "<blockquote>quoted alert</blockquote>")).toBe("");
    expect(extractEmailReply("", "<blockquote>quoted alert</blockquote>")).toBe("");
  });

  it("bounds text length and removes null bytes", () => {
    expect(extractEmailReply("Hello\u0000", "")).toBe("Hello");
    expect(extractEmailReply("", `<p>${"a".repeat(9000)}</p>`)).toHaveLength(8000);
  });
});
