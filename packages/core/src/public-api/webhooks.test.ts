import { beforeAll, describe, expect, it } from "vitest";
import { AppError } from "@daildex/shared";
import { assertPublicWebhookUrl, createWebhookSchema, isPrivateAddress, signWebhookBody, webhookSecret } from "./webhooks";

beforeAll(() => {
  process.env.TOKEN_HASH_PEPPER = "test-pepper";
});

describe("webhook SSRF guard", () => {
  it.each([
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254",
    "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fe80::1", "fd12:3456::1", "::ffff:10.0.0.1", "ff02::1",
    // The hex forms the URL parser produces for IPv4-mapped addresses, plus 6to4 and compatible embeddings.
    "::ffff:7f00:1", "::ffff:a00:1", "::ffff:a9fe:a9fe", "0:0:0:0:0:ffff:7f00:1", "2002:7f00:1::1", "::7f00:1", "fec0::1",
  ])("treats %s as private", (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "172.32.0.1", "193.1.2.3", "2606:4700:4700::1111", "::ffff:808:808", "2002:808:808::1"])("treats %s as public", (address) => {
    expect(isPrivateAddress(address)).toBe(false);
  });

  it("accepts only public https URLs", () => {
    expect(assertPublicWebhookUrl("https://hooks.example.org/daildex").hostname).toBe("hooks.example.org");
    for (const bad of [
      "http://example.org/hook", "https://localhost/hook", "https://user:pw@example.org/hook",
      "https://127.0.0.1/hook", "https://[::1]/hook", "https://[::ffff:127.0.0.1]/hook", "https://[::ffff:10.0.0.1]:8443/hook", "https://169.254.169.254/latest/meta-data",
      "https://printer.local/hook", "https://db.internal/hook", "not a url", "ftp://example.org",
    ]) {
      expect(() => assertPublicWebhookUrl(bad), bad).toThrow(AppError);
    }
  });
});

describe("webhook signing", () => {
  it("derives a stable per-webhook secret and signs the raw body", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    expect(webhookSecret(id)).toBe(webhookSecret(id));
    expect(webhookSecret(id)).not.toBe(webhookSecret("00000000-0000-4000-8000-000000000002"));
    expect(webhookSecret(id)).toMatch(/^whsec_[0-9a-f]{40}$/);
    const signature = signWebhookBody(webhookSecret(id), '{"a":1}', 1_700_000_000);
    expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(signature).not.toBe(signWebhookBody(webhookSecret(id), '{"a":2}', 1_700_000_000));
    // The timestamp is signed too, so a replay with a fresh timestamp fails verification.
    expect(signature).not.toBe(signWebhookBody(webhookSecret(id), '{"a":1}', 1_700_000_001));
  });

  it("validates the create payload strictly", () => {
    expect(createWebhookSchema.safeParse({ url: "https://example.org/hook", events: ["division.created"] }).success).toBe(true);
    expect(createWebhookSchema.safeParse({ url: "https://example.org/hook", events: [] }).success).toBe(false);
    expect(createWebhookSchema.safeParse({ url: "https://example.org/hook", events: ["speech.created"] }).success).toBe(false);
    expect(createWebhookSchema.safeParse({ url: "https://example.org/hook", events: ["division.created"], extra: 1 }).success).toBe(false);
  });
});
