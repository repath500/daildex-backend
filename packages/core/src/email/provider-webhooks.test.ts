import { describe, expect, it, vi } from "vitest";
import { Webhook } from "svix";
import {
  classifyReply,
  fetchResendReceivedEmail,
  fetchResendSentMessageId,
  normalizeResendInbound,
  verifyResendSignature,
} from "./provider-webhooks";

const webhookSecret = `whsec_${Buffer.from("daildex-resend-webhook-secret-key").toString("base64")}`;
const otherWebhookSecret = `whsec_${Buffer.from("different-resend-webhook-secret").toString("base64")}`;

describe("Resend inbound mapping", () => {
  it("retrieves the provider's delivered RFC Message-ID instead of assuming our custom ID survived", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ message_id: "<delivered@amazonses.com>" })));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(fetchResendSentMessageId("re_sent", "test-key")).resolves.toBe("<delivered@amazonses.com>");
      expect(fetchMock).toHaveBeenCalledWith("https://api.resend.com/emails/re_sent", expect.objectContaining({
        headers: { Authorization: "Bearer test-key" },
      }));
    } finally { vi.unstubAllGlobals(); }
  });

  it.each([null, "", "bad\r\nInjected: header", "not-an-rfc-id"])("rejects invalid delivered Message-IDs: %s", async (message_id) => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ message_id }))));
    try {
      await expect(fetchResendSentMessageId("re_sent", "test-key")).resolves.toBeNull();
    } finally { vi.unstubAllGlobals(); }
  });
  it("extracts the reply token and RFC headers from the Receiving API response", () => {
    const inbound = normalizeResendInbound({
      id: "re_123",
      from: "Person <person@example.test>",
      to: ["reply+thread-token@reply.example.test"],
      subject: "Re: Fixture",
      text: "What happened?\n\n> quoted alert",
      headers: {
        "message-id": "<inbound@example.test>",
        "in-reply-to": "<outbound@example.test>",
        references: "<outbound@example.test>",
      },
    });

    expect(inbound.mailboxToken).toBe("thread-token");
    expect(inbound.providerMessageId).toBe("re_123");
    expect(inbound.sender).toBe("Person <person@example.test>");
    expect(inbound.strippedTextReply).toBe("What happened?");
    expect(inbound.headers).toContainEqual({ Name: "in-reply-to", Value: "<outbound@example.test>" });
  });

  it("retrieves received content with the server-side Resend API key", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ id: "re_123", text: "Hello" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchResendReceivedEmail("re_123", "resend_test_key")).resolves.toMatchObject({ id: "re_123", text: "Hello" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.resend.com/emails/receiving/re_123",
      expect.objectContaining({ headers: { Authorization: "Bearer resend_test_key" } }),
    );
    vi.unstubAllGlobals();
  });
});

describe("Resend webhook signatures", () => {
  const id = "msg_test_123";
  const timestamp = new Date();
  const body = '{"type":"email.delivered","data":{"email_id":"abc-123"}}';
  const signature = new Webhook(webhookSecret).sign(id, timestamp, body);

  it("accepts a Svix signature over the raw body", () => {
    expect(verifyResendSignature(
      { "svix-id": id, "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)), "svix-signature": signature },
      body,
      webhookSecret,
    )).toBe(true);
  });

  it("rejects tampering, wrong secrets, stale timestamps, and missing headers", () => {
    expect(verifyResendSignature(
      { "svix-id": id, "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)), "svix-signature": signature },
      "tampered-body",
      webhookSecret,
    )).toBe(false);
    expect(verifyResendSignature(
      { "svix-id": id, "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)), "svix-signature": signature },
      body,
      otherWebhookSecret,
    )).toBe(false);
    const stale = new Date(Date.now() - 600_000);
    const staleSignature = new Webhook(webhookSecret).sign(id, stale, body);
    expect(verifyResendSignature(
      { "svix-id": id, "svix-timestamp": String(Math.floor(stale.getTime() / 1000)), "svix-signature": staleSignature },
      body,
      webhookSecret,
    )).toBe(false);
    expect(verifyResendSignature({ "svix-id": id, "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)) }, body, webhookSecret)).toBe(false);
  });
});

describe("deterministic inbound intent", () => {
  it.each([
    "unsubscribe",
    "Please remove me from these emails",
    "Stop sending me alerts, and what did the TD vote for?",
    "Díliostáil mé le do thoil",
    "I want to opt out",
  ])("classifies unsubscribe without a model: %s", (text) => {
    expect(classifyReply(text)).toBe("unsubscribe");
  });

  it.each(["manage my alerts", "Change my preferences", "update alerts"]) (
    "classifies preference management: %s",
    (text) => expect(classifyReply(text)).toBe("manage_subscription"),
  );

  it.each(["Is he corrupt?", "Why is that TD lying?", "Do you think she is dishonest?"]) (
    "classifies character judgements: %s",
    (text) => expect(classifyReply(text)).toBe("unsafe_or_sensitive"),
  );

  it.each(["What does the corruption bill change?", "How did she vote?", "Where is the source?"]) (
    "does not over-classify ordinary questions: %s",
    (text) => expect(classifyReply(text)).toBe("unknown"),
  );
});
