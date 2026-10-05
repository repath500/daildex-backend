export type OutboxEmail = {
  id: string;
  recipient: string;
  subject: string;
  text: string;
  html: string;
  replyTo?: string;
  cc?: string[];
  unsubscribeApiUrl?: string;
  rfcMessageId?: string;
  inReplyTo?: string;
  references?: string;
};

export type EmailSendResult = { providerMessageId: string };

export interface EmailProvider {
  send(email: OutboxEmail): Promise<EmailSendResult>;
}

const RESEND_SEND_URL = "https://api.resend.com/emails";

export class ResendEmailProvider implements EmailProvider {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async send(email: OutboxEmail): Promise<EmailSendResult> {
    const headers: Record<string, string> = {
      "X-DailDex-Delivery-ID": email.id,
    };
    if (email.rfcMessageId) headers["Message-ID"] = email.rfcMessageId;
    if (email.inReplyTo) headers["In-Reply-To"] = email.inReplyTo;
    if (email.references) headers["References"] = email.references;
    if (email.unsubscribeApiUrl) {
      headers["List-Unsubscribe"] = `<${email.unsubscribeApiUrl}>`;
      headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
    }

    const response = await fetch(RESEND_SEND_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": email.id,
      },
      body: JSON.stringify({
        from: this.from,
        to: [email.recipient],
        subject: email.subject,
        text: email.text,
        html: email.html,
        ...(email.replyTo ? { reply_to: email.replyTo } : {}),
        ...(email.cc?.length ? { cc: email.cc } : {}),
        headers,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      const detail = await readErrorDetail(response);
      throw new Error(`Resend rejected the send (HTTP ${response.status})${detail ? `: ${detail}` : ""}`);
    }

    const result = (await response.json()) as { id?: unknown };
    if (typeof result.id !== "string" || result.id.length === 0) {
      throw new Error("Resend accepted the send without returning an id.");
    }
    return { providerMessageId: result.id };
  }
}

export function getEmailProvider(fromOverride?: string): EmailProvider {
  const apiKey = process.env.RESEND_API_KEY;
  const from = fromOverride ?? process.env.RESEND_FROM_EMAIL;
  if (!apiKey || !from) {
    throw new Error("RESEND_API_KEY and RESEND_FROM_EMAIL are required");
  }
  return new ResendEmailProvider(apiKey, from);
}

async function readErrorDetail(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 300);
  } catch {
    return "";
  }
}
