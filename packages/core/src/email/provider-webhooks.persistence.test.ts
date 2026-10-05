import { afterEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@daildex/db";
import { createThreadToken } from "../security/tokens";
import { persistResendInbound } from "./provider-webhooks";

const threadId = "00000000-0000-4000-8000-000000000001";
const pepper = "test-pepper";

function fixture(options: { sender?: string; deliveredId?: string; duplicate?: boolean } = {}) {
  vi.stubEnv("TOKEN_HASH_PEPPER", pepper);
  vi.stubEnv("RESEND_API_KEY", "test-key");
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  const query = Object.assign(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?");
    queries.push({ sql, values });
    if (sql.includes("INSERT INTO provider_webhook_events")) return options.duplicate ? [] : [{ id: "event" }];
    if (sql.includes("RETURNING id") && sql.includes("last_error IN")) return [{ id: "event" }];
    if (sql.includes("FROM email_threads thread")) return [{ id: threadId, token_version: 1, subscriber_id: "subscriber", email: "person@example.test", subscriber_status: "active" }];
    if (sql.includes("SELECT EXISTS")) return [{ exists: false }];
    if (sql.includes("SELECT id, provider_message_id")) return [{ id: "outbound", provider_message_id: "sent-provider-id" }];
    if (sql.includes("INSERT INTO email_messages")) return [{ id: "inbound" }];
    return [];
  }, { json: (value: unknown) => value });
  const database = Object.assign(query, { begin: async (callback: (transaction: typeof query) => unknown) => callback(query) }) as unknown as Database;
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ message_id: options.deliveredId ?? "<delivered@amazonses.com>" })));
  vi.stubGlobal("fetch", fetchMock);
  const payload = {
    id: "received-provider-id", from: options.sender ?? "person@example.test",
    to: [`reply+${createThreadToken(threadId, 1, pepper)}@reply.example.test`],
    text: null, html: "<p>Explained simpler</p><blockquote>Unsubscribe</blockquote>",
    headers: { "in-reply-to": "<delivered@amazonses.com>", "message-id": "<inbound@example.test>" },
  };
  return { database, payload, queries, fetchMock };
}

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("HTML-only reply persistence and provider threading", () => {
  it("recovers a rejected event and queues the extracted simplification question once", async () => {
    const f = fixture({ duplicate: true });
    await expect(persistResendInbound(f.payload, "event-id", f.database)).resolves.toMatchObject({ status: "processed", duplicate: false });
    expect(f.fetchMock).toHaveBeenCalledWith("https://api.resend.com/emails/sent-provider-id", expect.anything());
    expect(f.queries.find((query) => query.sql.includes("UPDATE email_messages SET rfc_message_id"))?.values)
      .toEqual(["<delivered@amazonses.com>", "outbound"]);
    expect(f.queries.find((query) => query.sql.includes("INSERT INTO ai_replies"))?.values)
      .toEqual(["inbound", "subscriber", "Explained simpler", "explain_event"]);
    expect(f.queries.some((query) => query.sql.includes("INSERT INTO email_outbox"))).toBe(false);
  });

  it("does not query provider data or queue a question for a mismatched sender", async () => {
    const f = fixture({ sender: "attacker@example.test" });
    await expect(persistResendInbound(f.payload, "event-id", f.database)).resolves.toMatchObject({ status: "needs_review" });
    expect(f.fetchMock).not.toHaveBeenCalled();
    expect(f.queries.some((query) => query.sql.includes("INSERT INTO ai_replies"))).toBe(false);
  });

  it("still quarantines a message referencing a different delivered email", async () => {
    const f = fixture({ deliveredId: "<other@amazonses.com>" });
    await expect(persistResendInbound(f.payload, "event-id", f.database)).resolves.toMatchObject({ status: "needs_review" });
    expect(f.queries.some((query) => query.sql.includes("INSERT INTO ai_replies"))).toBe(false);
  });
});
