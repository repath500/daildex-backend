import { describe, expect, it } from "vitest";
import { sanitizeCloudMessages } from "./service";

describe("sanitizeCloudMessages", () => {
  it("keeps text turns and slims tool parts for training storage", () => {
    const sanitized = sanitizeCloudMessages([
      {
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "How does the Dáil work?" }],
      },
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "text", text: "Here is the record." },
          {
            type: "tool-lookupOireachtas",
            toolName: "lookupOireachtas",
            state: "output-available",
            output: { huge: "x".repeat(10_000) },
          },
        ],
      },
    ]);

    expect(sanitized).toEqual([
      {
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "How does the Dáil work?" }],
      },
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "text", text: "Here is the record." },
          {
            type: "tool-lookupOireachtas",
            toolName: "lookupOireachtas",
            state: "output-available",
          },
        ],
      },
    ]);
  });

  it("caps oversized threads instead of rejecting them", () => {
    const messages = Array.from({ length: 450 }, (_, index) => ({
      id: `m${index}`,
      role: index % 2 === 0 ? "user" : "assistant",
      parts: [{ type: "text", text: `turn ${index} ${"word ".repeat(20)}` }],
    }));
    const sanitized = sanitizeCloudMessages(messages);
    expect(Array.isArray(sanitized)).toBe(true);
    expect((sanitized as unknown[]).length).toBeLessThanOrEqual(400);
  });
});
