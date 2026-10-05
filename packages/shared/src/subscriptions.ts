import { z } from "zod";
import { alertLevelSchema, eventTypeSchema, topicTagSchema } from "./taxonomy";

const emailSchema = z
  .string()
  .trim()
  .min(3)
  .max(320)
  .email()
  .transform((value) => value.toLowerCase());

const representativeKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "Invalid representative key");

const acquisitionTokenSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_.-]*$/, "Invalid acquisition token");

/**
 * First-touch attribution captured in the browser. Coarse and non-personal by
 * design: campaign tokens, an entry path and a referrer host, never full URLs.
 */
export const acquisitionSchema = z.object({
  ref: acquisitionTokenSchema.optional(),
  source: acquisitionTokenSchema.optional(),
  campaign: acquisitionTokenSchema.optional(),
  entry: z.string().trim().max(120).regex(/^\/[A-Za-z0-9/_-]*$/).optional(),
  referrer: z.string().trim().toLowerCase().max(100).regex(/^[a-z0-9.-]+$/).optional(),
});

export const subscriptionRequestSchema = z.object({
  email: emailSchema,
  locale: z.enum(["en", "ga"]).default("en"),
  representativeIds: z.array(representativeKeySchema).min(1).max(20),
  eventTypes: z.array(eventTypeSchema).min(1).max(4).default(["vote", "debate", "pq", "news"]),
  topicTags: z.array(topicTagSchema).max(12).default([]),
  alertLevel: alertLevelSchema.default("important_only"),
  acquisition: acquisitionSchema.optional(),
});

export const subscriptionConfirmationSchema = z.object({
  token: z.string().trim().min(32).max(256),
});

export const manageTokenSchema = z.string().trim().min(32).max(256);

export const manageSubscriptionUpdateSchema = z.object({
  representativeIds: z.array(representativeKeySchema).min(1).max(20),
  eventTypes: z.array(eventTypeSchema).min(1).max(4),
  topicTags: z.array(topicTagSchema).max(12),
  alertLevel: alertLevelSchema,
});

export const publicRepresentativeSchema = z.object({
  id: representativeKeySchema,
  name: z.string().min(1).max(200),
  area: z.string().min(1).max(200),
  party: z.string().min(1).max(200),
  role: z.enum(["TD", "Senator"]),
  chamber: z.enum(["Dáil", "Seanad"]),
});

export const managedSubscriptionSchema = z.object({
  emailMasked: z.string(),
  representativeIds: z.array(representativeKeySchema),
  eventTypes: z.array(eventTypeSchema),
  topicTags: z.array(topicTagSchema),
  alertLevel: alertLevelSchema,
  status: z.enum(["pending", "active", "unsubscribed", "suppressed"]),
});

export type Acquisition = z.infer<typeof acquisitionSchema>;
export type SubscriptionRequest = z.infer<typeof subscriptionRequestSchema>;
export type ManageSubscriptionUpdate = z.infer<typeof manageSubscriptionUpdateSchema>;
export type PublicRepresentative = z.infer<typeof publicRepresentativeSchema>;
export type ManagedSubscription = z.infer<typeof managedSubscriptionSchema>;
