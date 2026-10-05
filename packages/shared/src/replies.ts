import { z } from "zod";

export const supportedReplyTypeSchema = z.enum(["explain_event", "ask_vote_breakdown", "ask_source", "ask_history", "ask_bill_impact", "ask_party_position"]);

export const replyAnswerSchema = z.string().trim().min(1).max(1800).superRefine((value, context) => {
  const lower = value.toLocaleLowerCase("en-IE");
  for (const phrase of ["corrupt", "liar", "lied", "dishonest", "traitor"]) {
    if (lower.includes(phrase)) context.addIssue({ code: "custom", message: `Characterizing phrase is not allowed: ${phrase}` });
  }
});

export const aiReplyDraftSchema = z.object({
  questionType: supportedReplyTypeSchema,
  answer: replyAnswerSchema,
  citations: z.array(z.string().regex(/^(official_event|(?:fact|bill|policy):[0-9a-f-]{36})$/i)).min(1).max(5),
  confidence: z.number().min(0).max(1),
  uncertainty: z.string().trim().max(300).optional(),
}).superRefine((value, context) => {
  if (value.confidence < 0.7 && !value.uncertainty) {
    context.addIssue({ code: "custom", message: "Low-confidence answers require an uncertainty statement" });
  }
});

export type AiReplyDraft = z.infer<typeof aiReplyDraftSchema>;
