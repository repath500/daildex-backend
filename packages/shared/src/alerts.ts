import { z } from "zod";
import { eventTypeSchema, topicTagSchema } from "./taxonomy";

const bannedCharacterizations = [
  "betrayed", "lied", "liar", "hypocrite", "corrupt", "exposed", "caught out",
] as const;

const safeText = (maximum: number) =>
  z.string().trim().min(1).max(maximum).superRefine((value, context) => {
    const lower = value.toLocaleLowerCase("en-IE");
    for (const phrase of bannedCharacterizations) {
      // Match from the start of a word, so "lied" is caught but "replied" and "applied" are not.
      if (new RegExp(`(?<![\\p{L}])${phrase}`, "u").test(lower)) {
        context.addIssue({ code: "custom", message: `Characterizing phrase is not allowed: ${phrase}` });
      }
    }
  });

export const alertDraftSchema = z.strictObject({
  eventType: eventTypeSchema,
  headline: safeText(120).refine((value) => value.split(/\s+/).length <= 12, "Headline exceeds 12 words"),
  summary: safeText(700),
  explanation: safeText(1800),
  topicTags: z.array(topicTagSchema).min(1).max(4),
  sourceLabel: safeText(160),
  importanceScore: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
});

export type AlertDraft = z.infer<typeof alertDraftSchema>;

export const alertFailureClassSchema = z.enum([
  "transient",
  "invalid_output",
  "configuration",
  "policy",
  "lease_lost",
  "paused",
  "unknown",
]);

export type AlertFailureClass = z.infer<typeof alertFailureClassSchema>;

export type AlertTargetFailure = {
  message: string;
  classification: AlertFailureClass;
};

export const alertAgentOutcomeSchema = z.enum([
  "draft",
  "skip",
  "merge",
  "needs_more_context",
]);

export const alertAgentDecisionSchema = z.strictObject({
  outcome: alertAgentOutcomeSchema,
  draft: alertDraftSchema.optional(),
  reason: safeText(500).optional(),
  mergeAlertId: z.string().uuid().optional(),
});

export type AlertAgentOutcome = z.infer<typeof alertAgentOutcomeSchema>;
export type AlertAgentDecision = z.infer<typeof alertAgentDecisionSchema>;

export type AlertRunMetadata = {
  provider: string;
  model: string;
  promptVersion: string;
  runId?: string | null;
  requestId?: string | null;
  hermesRunId?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  latencyMs?: number | null;
  providerVerified?: boolean;
};

export type ClaimedAlertTarget = {
  targetId: string;
  rawEventId: string;
  attemptCount: number;
  sourceType: string;
  sourceUrl: string;
  rawText: string | null;
  participation: string | null;
  representative: {
    id: string;
    name: string;
    chamber: "Dáil" | "Seanad";
    role: "TD" | "Senator";
    area: string;
    party: string;
  };
};
