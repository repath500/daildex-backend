import { z } from "zod";

export const topicTags = [
  "housing",
  "health",
  "economy",
  "justice",
  "education",
  "environment",
  "agriculture",
  "foreign_affairs",
  "immigration",
  "infrastructure",
  "social_welfare",
  "procedural",
] as const;

export const eventTypes = ["vote", "debate", "pq", "news"] as const;
export const alertLevels = ["all", "important_only"] as const;

export const topicTagSchema = z.enum(topicTags);
export const eventTypeSchema = z.enum(eventTypes);
export const alertLevelSchema = z.enum(alertLevels);

export type TopicTag = z.infer<typeof topicTagSchema>;
export type EventType = z.infer<typeof eventTypeSchema>;
export type AlertLevel = z.infer<typeof alertLevelSchema>;
