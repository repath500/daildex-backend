import { OPENROUTER_REFERER } from "@daildex/shared/openrouter";

/** Second reader for alert drafts that already pass the deterministic checks. */
export const AI_REVIEW_MODEL = "meta/muse-spark-1.3";

export type AiReviewInput = {
  eventType: string;
  representativeName: string;
  participation: string | null;
  /** Party and constituency from DáilDex's member records. */
  memberDetails?: string;
  headline: string;
  summary: string;
  explanation: string;
  /** The official record the draft was written from. */
  recordText: string;
};

export type AiReviewResult = { verdict: "approve" | "hold"; reasons: string[] };

const SYSTEM = `You are the final standards check for DáilDex, an independent Irish civic service that emails people short alerts about what their TD did in the Oireachtas. A draft alert was written by a model from an official record. Decide whether it is safe to send with no human reading it.

Approve unless you find a real problem. Hold only for one of these:
1. A fabricated or wrong material fact: a name, number, date, vote result or event that is not in the official record, or that contradicts it.
2. The wrong participation: the alert says the TD voted the opposite way to the record (Tá is for, Níl is against, Staon is an abstention), or presents a question they asked as a position they hold.
3. Loaded or partisan wording: praise, blame, predictions, motives, or taking a side on the issue or a party.
4. It is about someone other than the named TD.
5. Misattribution: it credits a statement, decision or action to the wrong person (for example the Taoiseach when the record shows the TD, or the reverse).
6. An unsupported claim of absence, such as "the record shows no vote", "no debate" or "no response", when the record does not establish that.
7. A routine procedural step presented as a personal stance. A one-line answer such as "Not opposed." at First Stage, or "Question put... Carried", is a standard step in the process. The alert may say what was said and at which stage, but must not headline it as the TD's or Minister's personal view of the issue.

Do not hold for anything else. In particular these are fine:
- Reasonable summarising or paraphrase of what the record says.
- A fact the record supports indirectly. For example, if the TD thanks the Minister for a commitment, then the Minister giving that commitment is supported, even if the Minister's own words are not in the excerpt (the excerpt may be cut short).
- Ordinary descriptive wording that adds no new fact, such as "weekly" for an Order of Business, or naming a party or constituency from the member details.
- Plain background that is common knowledge about how the Dáil works.

Hold when a material fact is clearly wrong or invented, not merely because you cannot find it word for word. If the record is truncated and the claim is plausible and consistent with it, approve.

Reply with one JSON object only: {"verdict":"approve"|"hold","reasons":["short reason", ...]}. Give reasons only when holding.`;

function extractVerdict(text: string): AiReviewResult {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("AI review returned no JSON");
  const parsed = JSON.parse(match[0]) as { verdict?: unknown; reasons?: unknown };
  if (parsed.verdict !== "approve" && parsed.verdict !== "hold") throw new Error("AI review returned an unknown verdict");
  const reasons = Array.isArray(parsed.reasons)
    ? parsed.reasons.filter((item): item is string => typeof item === "string").map((item) => item.slice(0, 300)).slice(0, 5)
    : [];
  return { verdict: parsed.verdict, reasons: parsed.verdict === "hold" && !reasons.length ? ["reviewer held without a reason"] : reasons };
}

export function aiReviewEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ALERT_AI_REVIEW?.trim().toLowerCase() !== "false" && Boolean(env.OPENROUTER_API_KEY?.trim());
}

/** Throws on transport or format errors; the caller leaves the draft for the next run. */
export async function reviewAlertWithModel(
  input: AiReviewInput,
  options: { fetch?: typeof fetch; apiKey?: string } = {},
): Promise<AiReviewResult> {
  const apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is required for alert AI review");
  const response = await (options.fetch ?? fetch)("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": OPENROUTER_REFERER,
      "X-Title": "DailDex Alert Review",
    },
    body: JSON.stringify({
      model: AI_REVIEW_MODEL,
      temperature: 0,
      // Muse always reasons; reasoning tokens count toward the cap, so leave room for the answer.
      max_tokens: 4000,
      reasoning: { effort: "low" },
      messages: [
        { role: "system", content: SYSTEM },
        {
          role: "user",
          content: `Event type: ${input.eventType}
TD: ${input.representativeName}${input.memberDetails ? ` (${input.memberDetails}; these member details are verified and may be used)` : ""}
Recorded participation: ${input.participation ?? "none"}

Draft alert
Headline: ${input.headline}
Summary: ${input.summary}
Explanation: ${input.explanation}

Official record:
${input.recordText.slice(0, 6000)}`,
        },
      ],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`AI review returned HTTP ${response.status}`);
  const payload = await response.json() as { choices?: Array<{ message?: { content?: string | null } }> };
  return extractVerdict(payload.choices?.[0]?.message?.content ?? "");
}
