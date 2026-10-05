import { createHash } from "node:crypto";
import { Webhook, WebhookVerificationError } from "svix";
import { getDatabase, type Database, type JsonValue, type TransactionDatabase } from "@daildex/db";
import { getAppBaseUrl, getEmailReplyDomain, getTokenPepper } from "../config";
import { createSubscriberToken, createThreadToken, verifyThreadToken } from "../security/tokens";
import { extractEmailReply } from "./reply-text";

const MAX_REPLY_CHARACTERS = 8_000;
const MAX_INBOUND_ATTACHMENTS = 10;
const MAX_INBOUND_ATTACHMENT_BYTES = 2_000_000;
const FIXED_REFUSAL = "I can't make that judgement. I can show you the public record and relevant sources.";

type Header = { Name?: unknown; Value?: unknown };
type InboundEmail = {
  providerMessageId: string;
  sender: string;
  recipient: string;
  mailboxToken: string;
  subject: string;
  textBody: string;
  htmlBody: string;
  strippedTextReply: string;
  headers: Header[];
  attachments: { ContentLength?: unknown }[];
  rawPayload: Record<string, unknown>;
};

type ResendWebhookHeaders = {
  "svix-id"?: string;
  "svix-timestamp"?: string;
  "svix-signature"?: string;
};

export type ResendReceivedEmail = Record<string, unknown>;

export function verifyResendSignature(
  headers: ResendWebhookHeaders,
  rawBody: string,
  signingSecret: string,
): boolean {
  const svixId = optionalString(headers["svix-id"]);
  const svixTimestamp = optionalString(headers["svix-timestamp"]);
  const svixSignature = optionalString(headers["svix-signature"]);
  if (!svixId || !svixTimestamp || !svixSignature || !signingSecret) return false;

  try {
    const webhook = new Webhook(signingSecret);
    webhook.verify(rawBody, {
      "svix-id": svixId,
      "svix-timestamp": svixTimestamp,
      "svix-signature": svixSignature,
    });
    return true;
  } catch (error) {
    if (error instanceof WebhookVerificationError) return false;
    return false;
  }
}

export async function fetchResendReceivedEmail(emailId: string, apiKey: string): Promise<ResendReceivedEmail> {
  const response = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15_000),
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`Resend could not retrieve the received email (HTTP ${response.status}): ${raw.slice(0, 300)}`);
  }
  if (Buffer.byteLength(raw, "utf8") > 1_048_576) {
    throw new Error("Resend received email is too large.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Resend returned invalid received-email JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Resend returned an invalid received-email payload.");
  }
  return parsed as ResendReceivedEmail;
}

/** Resend/SES replaces our requested Message-ID with the delivered RFC ID. */
export async function fetchResendSentMessageId(emailId: string, apiKey: string): Promise<string | null> {
  const response = await fetch(`https://api.resend.com/emails/${encodeURIComponent(emailId)}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Resend could not retrieve the sent email (HTTP ${response.status})`);
  const result = await response.json() as { message_id?: unknown };
  const id = optionalString(result.message_id);
  return /^<[^<>\s]{1,998}>$/.test(id) ? id : null;
}

export function classifyReply(text: string): "unsubscribe" | "manage_subscription" | "unsafe_or_sensitive" | "unknown" {
  const normalized = text.normalize("NFKC").toLocaleLowerCase("en-IE").replace(/\s+/g, " ").trim();
  if (/\b(unsubscribe|cancel (?:my )?subscription|stop (?:sending )?(?:me )?(?:the )?(?:emails?|alerts?)|remove me|opt[ -]?out)\b/u.test(normalized) ||
      /\b(díliostáil|bain den liosta|stad na ríomhphoist)\b/u.test(normalized)) return "unsubscribe";
  if (/\b(manage (?:my )?(?:subscription|alerts?)|change (?:my )?(?:preferences|alerts?)|update (?:my )?(?:preferences|alerts?))\b/u.test(normalized)) {
    return "manage_subscription";
  }
  if (/\b(?:is|are|was|were|why is|why are|do you think)\b.{0,80}\b(?:corrupt|a liar|lying|dishonest|a criminal|a traitor|evil|racist|sexist)\b/u.test(normalized) ||
      /\b(?:corrupt|a liar|lying|dishonest|a criminal|a traitor|evil|racist|sexist)\b.{0,30}\b(?:he|she|they|td|politician|minister)\b/u.test(normalized)) {
    return "unsafe_or_sensitive";
  }
  return "unknown";
}

export async function persistResendDelivery(
  event: Record<string, unknown>,
  eventId: string,
  database: Database = getDatabase(),
) {
  const eventType = optionalString(event.type) || "Unknown";
  const providerEventId = eventId || `${eventType}:${createHash("sha256").update(JSON.stringify(event)).digest("hex")}`;
  const inserted = await database<{ id: string }[]>`
    INSERT INTO provider_webhook_events (provider, event_type, provider_event_id, payload)
    VALUES ('resend', ${eventType}, ${providerEventId}, ${database.json(toJson(event))})
    ON CONFLICT (provider, provider_event_id) DO NOTHING
    RETURNING id
  `;
  if (inserted.length === 0) return { duplicate: true };
  return { duplicate: false };
}

export async function persistResendInbound(
  received: ResendReceivedEmail,
  eventId: string,
  database: Database = getDatabase(),
) {
  const payload = normalizeResendInbound(received);
  const providerEventId = eventId || `email.received:${payload.providerMessageId}`;

  return database.begin(async (transaction) => {
    const events = await transaction<{ id: string }[]>`
      INSERT INTO provider_webhook_events (provider, event_type, provider_event_id, payload)
      VALUES ('resend', 'email.received', ${providerEventId}, ${transaction.json(toJson(payload.rawPayload))})
      ON CONFLICT (provider, provider_event_id) DO NOTHING
      RETURNING id
    `;
    if (events.length === 0) {
      // A retried webhook can recover HTML-only mail rejected by the old parser.
      // The update locks the event, so concurrent retries cannot enqueue it twice.
      const recovered = await transaction<{ id: string }[]>`
        UPDATE provider_webhook_events SET status = 'processing', last_error = NULL,
          processed_at = NULL
        WHERE provider = 'resend' AND provider_event_id = ${providerEventId}
          AND status = 'needs_review'
          AND last_error IN ('Reply body is empty', 'In-Reply-To does not belong to this thread')
          AND payload->>'id' = ${payload.providerMessageId}
          AND ${Boolean(payload.strippedTextReply)}
        RETURNING id
      `;
      if (recovered.length === 0) return { duplicate: true, status: "processed" as const };
    }

    if (payload.attachments.length > MAX_INBOUND_ATTACHMENTS) {
      return quarantine(transaction, "resend", providerEventId, "Too many attachments");
    }
    const attachmentBytes = payload.attachments.reduce((total, attachment) => total + Number(attachment.ContentLength ?? 0), 0);
    if (Number.isFinite(attachmentBytes) && attachmentBytes > MAX_INBOUND_ATTACHMENT_BYTES) {
      return quarantine(transaction, "resend", providerEventId, "Attachments are too large");
    }

    const token = payload.mailboxToken ? verifyThreadToken(payload.mailboxToken, getTokenPepper()) : null;
    if (!token) return quarantine(transaction, "resend", providerEventId, "Unknown or invalid thread token");

    const threads = await transaction<{
      id: string;
      token_version: number;
      subscriber_id: string;
      email: string;
      subscriber_status: string;
    }[]>`
      SELECT thread.id, thread.token_version, thread.subscriber_id,
        subscriber.email::TEXT AS email, subscriber.status AS subscriber_status
      FROM email_threads thread
      JOIN subscribers subscriber ON subscriber.id = thread.subscriber_id
      WHERE thread.id = ${token.threadId}
      FOR UPDATE
    `;
    const thread = threads[0];
    if (!thread || thread.token_version !== token.version) {
      return quarantine(transaction, "resend", providerEventId, "Thread token is stale or unknown");
    }

    const sender = normalizeEmail(payload.sender);
    if (!sender || sender !== normalizeEmail(thread.email)) {
      return quarantine(transaction, "resend", providerEventId, "Sender does not match the thread subscriber");
    }
    if (thread.subscriber_status !== "active") {
      return quarantine(transaction, "resend", providerEventId, "Subscriber is not active");
    }

    const headers = headerMap(payload.headers);
    if (isAutomated(headers)) return quarantine(transaction, "resend", providerEventId, "Automated email");
    const question = extractReply(payload);
    if (!question) return quarantine(transaction, "resend", providerEventId, "Reply body is empty");
    const inReplyTo = headers.get("in-reply-to")?.slice(0, 1000) ?? null;
    if (!inReplyTo) return quarantine(transaction, "resend", providerEventId, "Missing In-Reply-To header");
    const referencedMessages = await transaction<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM email_messages
        WHERE email_thread_id = ${thread.id} AND rfc_message_id = ${inReplyTo}
      ) AS exists
    `;
    let matched = referencedMessages[0]?.exists === true;
    if (!matched && process.env.RESEND_API_KEY) {
      // Only query provider IDs already associated with this authenticated thread.
      // Never trust the inbound Message-ID as a provider API identifier.
      const sentMessages = await transaction<{ id: string; provider_message_id: string }[]>`
        SELECT id, provider_message_id FROM email_messages
        WHERE email_thread_id = ${thread.id}
          AND direction IN ('outbound_alert', 'outbound_ai') AND provider_message_id IS NOT NULL
        ORDER BY created_at DESC LIMIT 5
      `;
      for (const sent of sentMessages) {
        const deliveredId = await fetchResendSentMessageId(sent.provider_message_id, process.env.RESEND_API_KEY);
        if (deliveredId) {
          await transaction`UPDATE email_messages SET rfc_message_id = ${deliveredId} WHERE id = ${sent.id}`;
        }
        if (deliveredId === inReplyTo) {
          matched = true;
          break;
        }
      }
    }
    if (!matched) {
      return quarantine(transaction, "resend", providerEventId, "In-Reply-To does not belong to this thread");
    }

    const messages = await transaction<{ id: string }[]>`
      INSERT INTO email_messages (
        email_thread_id, direction, subject, body_text, body_html, provider_message_id,
        rfc_message_id, in_reply_to, references_header
      ) VALUES (
        ${thread.id}, 'inbound_user', ${payload.subject.slice(0, 500)}, ${question}, ${payload.htmlBody || null},
        ${payload.providerMessageId}, ${headers.get("message-id")?.slice(0, 1000) ?? null},
        ${inReplyTo},
        ${headers.get("references")?.slice(0, 4000) ?? null}
      )
      ON CONFLICT DO NOTHING
      RETURNING id
    `;
    const message = messages[0];
    if (!message) {
      await markProviderEventProcessed(transaction, "resend", providerEventId);
      return { duplicate: true, status: "processed" as const };
    }

    const questionType = classifyReply(question);
    await transaction`
      UPDATE email_threads SET last_message_at = now() WHERE id = ${thread.id}
    `;

    if (questionType === "unsubscribe") {
      await transaction`UPDATE subscribers SET status = 'unsubscribed', updated_at = now() WHERE id = ${thread.subscriber_id}`;
      await transaction`
        INSERT INTO consent_events (subscriber_id, event_type, consent_version)
        VALUES (${thread.subscriber_id}, 'unsubscribed', '2026-07-01')
      `;
      await queueFixedReply(transaction, message.id, thread, payload, "You are unsubscribed", "You have been unsubscribed from DáilDex alerts.");
    } else if (questionType === "manage_subscription") {
      const manageToken = createSubscriberToken(thread.subscriber_id, "manage", await subscriberTokenVersion(transaction, thread.subscriber_id), getTokenPepper());
      const url = `${getAppBaseUrl()}/manage/${encodeURIComponent(manageToken)}`;
      await queueFixedReply(transaction, message.id, thread, payload, "Manage your DáilDex alerts", `Manage your alerts here: ${url}`);
    } else if (questionType === "unsafe_or_sensitive") {
      await queueFixedReply(transaction, message.id, thread, payload, "About your question", FIXED_REFUSAL);
    } else {
      await transaction`
        INSERT INTO ai_replies (email_message_id, subscriber_id, question, question_type, status)
        VALUES (${message.id}, ${thread.subscriber_id}, ${question}, ${classifySupportedQuestion(question)}, 'pending')
      `;
    }

    await transaction`
      UPDATE provider_webhook_events SET status = 'processed', processed_at = now()
      WHERE provider = 'resend' AND provider_event_id = ${providerEventId}
    `;
    return { duplicate: false, status: "processed" as const, questionType };
  });
}

export function normalizeResendInbound(received: ResendReceivedEmail): InboundEmail {
  const headers = parseResendHeaders(received.headers);
  const recipients = stringList(received.to);
  const recipient = recipients.find((value) => extractMailboxToken(value)) || recipients[0] || "";
  const textBody = optionalString(received.text);
  const htmlBody = optionalString(received.html);
  return {
    providerMessageId: requiredString(received.id, "email id"),
    sender: optionalString(received.from),
    recipient,
    mailboxToken: extractMailboxToken(recipient),
    subject: optionalString(received.subject),
    textBody,
    htmlBody,
    strippedTextReply: extractEmailReply(textBody, htmlBody),
    headers,
    attachments: normalizeAttachments(received.attachments),
    rawPayload: received,
  };
}

function extractMailboxToken(recipient: string): string {
  const match = /^reply\+([^@]+)@/iu.exec(recipient.trim());
  return match?.[1] ?? "";
}

function parseResendHeaders(value: unknown): Header[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      if (Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string") {
        return [{ Name: entry[0], Value: entry[1] }];
      }
      if (entry && typeof entry === "object") {
        const record = entry as Record<string, unknown>;
        return [{ Name: record.name ?? record.Name, Value: record.value ?? record.Value }];
      }
      return [];
    });
  }
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).map(([Name, Value]) => ({ Name, Value }));
}

function extractReply(payload: InboundEmail): string {
  const source = payload.strippedTextReply;
  return source.replaceAll("\u0000", "").trim().slice(0, MAX_REPLY_CHARACTERS);
}

function headerMap(headers: Header[] | undefined): Map<string, string> {
  const result = new Map<string, string>();
  for (const header of headers ?? []) {
    const name = optionalString(header.Name).toLocaleLowerCase("en-IE");
    const value = optionalString(header.Value);
    if (name && value && !result.has(name)) result.set(name, value);
  }
  return result;
}

function isAutomated(headers: Map<string, string>): boolean {
  const autoSubmitted = headers.get("auto-submitted")?.toLowerCase();
  const precedence = headers.get("precedence")?.toLowerCase();
  return Boolean((autoSubmitted && autoSubmitted !== "no") || (precedence && /bulk|junk|list/.test(precedence)));
}

async function queueFixedReply(
  transaction: TransactionDatabase,
  inboundMessageId: string,
  thread: { id: string; subscriber_id: string; email: string; token_version: number },
  payload: InboundEmail,
  subject: string,
  text: string,
) {
  const threadToken = createThreadToken(thread.id, thread.token_version, getTokenPepper());
  const headers = headerMap(payload.headers);
  const inboundRfcMessageId = headers.get("message-id")?.slice(0, 1000);
  const priorReferences = headers.get("references")?.slice(0, 3000);
  const replies = await transaction<{ id: string }[]>`
    INSERT INTO ai_replies (
      email_message_id, subscriber_id, question, question_type, answer, confidence, status
    ) VALUES (
      ${inboundMessageId}, ${thread.subscriber_id}, ${extractReply(payload)}, ${classifyReply(extractReply(payload))},
      ${text}, 1, 'draft'
    )
    RETURNING id
  `;
  const reply = replies[0];
  if (!reply) throw new Error("Failed to persist deterministic reply");
  await transaction`
    INSERT INTO email_outbox (
      kind, recipient, payload, idempotency_key, subscriber_id, email_thread_id, ai_reply_id
    )
    VALUES (
      'ai_reply', ${thread.email},
      ${transaction.json({
        subject: payload.subject.toLowerCase().startsWith("re:") ? payload.subject : `Re: ${subject}`,
        text,
        html: `<p>${escapeHtml(text)}</p>`,
        replyTo: `reply+${threadToken}@${getEmailReplyDomain()}`,
        inReplyTo: inboundRfcMessageId,
        references: [priorReferences, inboundRfcMessageId].filter(Boolean).join(" ").slice(0, 4000) || undefined,
      })},
      ${`inbound-fixed:${inboundMessageId}`}, ${thread.subscriber_id}, ${thread.id}, ${reply.id}
    )
    ON CONFLICT (idempotency_key) DO NOTHING
  `;
}

async function subscriberTokenVersion(database: TransactionDatabase, subscriberId: string): Promise<number> {
  const rows = await database<{ token_version: number }[]>`
    SELECT token_version FROM subscribers WHERE id = ${subscriberId}
  `;
  return rows[0]?.token_version ?? 1;
}

async function quarantine(database: TransactionDatabase, provider: string, providerEventId: string, reason: string) {
  await database`
    UPDATE provider_webhook_events
    SET status = 'needs_review', last_error = ${reason.slice(0, 1000)}, processed_at = now()
    WHERE provider = ${provider} AND provider_event_id = ${providerEventId}
  `;
  return { duplicate: false, status: "needs_review" as const };
}

function requiredString(value: unknown, name: string): string {
  const result = optionalString(value);
  if (!result) throw new Error(`Webhook payload is missing ${name}`);
  return result;
}

function optionalString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((entry) => optionalString(entry) ? [optionalString(entry)] : []);
  const single = optionalString(value);
  return single ? [single] : [];
}

function normalizeAttachments(value: unknown): { ContentLength?: unknown }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    return [{ ContentLength: record.size ?? record.content_length ?? record.contentLength }];
  });
}

function normalizeEmail(value: string): string {
  const address = /<([^>]+)>/u.exec(value)?.[1] ?? value;
  return address.trim().toLocaleLowerCase("en-IE");
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function classifySupportedQuestion(text: string): "explain_event" | "ask_vote_breakdown" | "ask_source" | "ask_history" | "ask_bill_impact" | "ask_party_position" | "unknown" {
  const normalized = text.toLocaleLowerCase("en-IE");
  if (/\b(source|link|record|where (?:did|can)|citation)\b/u.test(normalized)) return "ask_source";
  if (/\b(history|historical|previous(?:ly)?|in the past|track record|how often|before this)\b/u.test(normalized)) return "ask_history";
  if (/\b(bill|legislation|act)\b.{0,60}\b(impact|change|do|mean|affect|stage|status)\b/u.test(normalized) ||
      /\b(impact|change|mean|affect)\b.{0,60}\b(bill|legislation)\b/u.test(normalized)) return "ask_bill_impact";
  if (/\b(party|manifesto|policy)\b.{0,80}\b(position|promise|support|oppose|say|plan|stance)\b/u.test(normalized) ||
      /\b(position|promise|stance)\b.{0,80}\b(party|manifesto|policy)\b/u.test(normalized)) return "ask_party_position";
  if (/\b(vote|voted|division|breakdown|how many|for or against)\b/u.test(normalized)) return "ask_vote_breakdown";
  if (/\b(explain(?:ed)?|simpl(?:er|ify)|what does|what happened|why (?:does|is|did)|what (?:is|was)|mean|impact)\b/u.test(normalized)) return "explain_event";
  return "unknown";
}

async function markProviderEventProcessed(database: TransactionDatabase, provider: string, providerEventId: string) {
  await database`
    UPDATE provider_webhook_events SET status = 'processed', processed_at = now()
    WHERE provider = ${provider} AND provider_event_id = ${providerEventId}
  `;
}

function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
