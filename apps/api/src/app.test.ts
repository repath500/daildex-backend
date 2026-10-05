import { describe, expect, it } from "vitest";
import { Webhook } from "svix";
import { createApp } from "./app";

describe("API health", () => {
  it("exposes a liveness endpoint without dependencies", async () => {
    const response = await createApp().request("/health/live");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  it("returns a stable JSON 404", async () => {
    const response = await createApp().request("/missing");
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: "NOT_FOUND" });
  });
});

describe("API security boundaries", () => {
  it("fails closed when internal authentication is absent or wrong", async () => {
    const previous = process.env.INTERNAL_API_TOKEN;
    delete process.env.INTERNAL_API_TOKEN;
    expect((await createApp().request("/internal/operations")).status).toBe(503);
    process.env.INTERNAL_API_TOKEN = "test-internal-token";
    expect((await createApp().request("/internal/operations", {
      headers: { authorization: "Bearer wrong-token" },
    })).status).toBe(401);
    if (previous === undefined) delete process.env.INTERNAL_API_TOKEN;
    else process.env.INTERNAL_API_TOKEN = previous;
  });

  it("keeps agent routes on their separate token and scope boundary", async () => {
    const previous = process.env.DAILDEX_AGENT_TOKEN;
    try {
      delete process.env.DAILDEX_AGENT_TOKEN;
      expect((await createApp().request("/internal/agent/claimed-target")).status).toBe(503);
      process.env.DAILDEX_AGENT_TOKEN = "test-agent-token";
      expect((await createApp().request("/internal/agent/claimed-target", {
        headers: { authorization: "Bearer wrong-token" },
      })).status).toBe(401);
      expect((await createApp().request("/internal/agent/claimed-target", {
        headers: { authorization: "Bearer test-agent-token" },
      })).status).toBe(401);
    } finally {
      if (previous === undefined) delete process.env.DAILDEX_AGENT_TOKEN;
      else process.env.DAILDEX_AGENT_TOKEN = previous;
    }
  });

  it("rejects a forged Resend webhook before database access", async () => {
    const previous = process.env.RESEND_WEBHOOK_SECRET;
    process.env.RESEND_WEBHOOK_SECRET = "webhook-test-secret";
    const response = await createApp().request("/webhooks/email/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "svix-id": "msg_test_123",
        "svix-timestamp": String(Math.floor(Date.now() / 1000)),
        "svix-signature": "v1,Zm9yZ2Vk",
      },
      body: JSON.stringify({ type: "email.delivered", data: { email_id: "abc" } }),
    });
    expect(response.status).toBe(403);
    if (previous === undefined) delete process.env.RESEND_WEBHOOK_SECRET;
    else process.env.RESEND_WEBHOOK_SECRET = previous;
  });

  it("fails closed when a received Resend email cannot be fetched", async () => {
    const previousSecret = process.env.RESEND_WEBHOOK_SECRET;
    const previousApiKey = process.env.RESEND_API_KEY;
    const secret = `whsec_${Buffer.from("daildex-resend-webhook-secret-key").toString("base64")}`;
    const id = "msg_received_test";
    const timestamp = new Date();
    const body = JSON.stringify({ type: "email.received", data: { email_id: "re_received_test" } });
    const signature = new Webhook(secret).sign(id, timestamp, body);
    process.env.RESEND_WEBHOOK_SECRET = secret;
    delete process.env.RESEND_API_KEY;
    try {
      const response = await createApp().request("/webhooks/email/events", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "svix-id": id,
          "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
          "svix-signature": signature,
        },
        body,
      });
      expect(response.status).toBe(503);
    } finally {
      if (previousSecret === undefined) delete process.env.RESEND_WEBHOOK_SECRET;
      else process.env.RESEND_WEBHOOK_SECRET = previousSecret;
      if (previousApiKey === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = previousApiKey;
    }
  });
});
