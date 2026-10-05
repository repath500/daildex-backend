import { describe, expect, it } from "vitest";
import { manageSubscriptionUpdateSchema, subscriptionRequestSchema } from "./subscriptions";

describe("subscriptionRequestSchema", () => {
  it("normalizes an email and deduplicates later at the service boundary", () => {
    const value = subscriptionRequestSchema.parse({
      email: " Person@Example.IE ",
      representativeIds: ["ivana-bacik"],
    });

    expect(value.email).toBe("person@example.ie");
    expect(value.topicTags).toEqual([]);
    expect(value.alertLevel).toBe("important_only");
  });

  it("accepts onboarding briefing preferences", () => {
    expect(subscriptionRequestSchema.parse({
      email: "person@example.ie",
      representativeIds: ["ivana-bacik"],
      topicTags: ["housing", "health", "education"],
      eventTypes: ["vote", "debate", "pq", "news"],
      alertLevel: "important_only",
    })).toMatchObject({ topicTags: ["housing", "health", "education"] });
  });

  it("rejects empty and oversized selections", () => {
    expect(() =>
      subscriptionRequestSchema.parse({ email: "person@example.ie", representativeIds: [] }),
    ).toThrow();
    expect(() =>
      subscriptionRequestSchema.parse({
        email: "person@example.ie",
        representativeIds: Array.from({ length: 21 }, (_, index) => `member-${index}`),
      }),
    ).toThrow();
  });
});

describe("manageSubscriptionUpdateSchema", () => {
  it("accepts a complete preference update", () => {
    expect(
      manageSubscriptionUpdateSchema.parse({
        representativeIds: ["ivana-bacik"],
        eventTypes: ["vote", "debate"],
        topicTags: ["housing"],
        alertLevel: "important_only",
      }),
    ).toMatchObject({ alertLevel: "important_only" });
  });
});
