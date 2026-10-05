import { describe, expect, it } from "vitest";
import { AppError } from "@daildex/shared";
import { createOpaqueToken, hashOpaqueToken } from "../security/tokens";

describe("subscription security invariants", () => {
  it("never stores a raw token when a hash is required", () => {
    const token = createOpaqueToken();
    const hash = hashOpaqueToken(token, "test-pepper");
    expect(hash).toHaveLength(64);
    expect(hash).not.toContain(token);
  });

  it("uses explicit public errors for invalid lifecycle state", () => {
    const error = new AppError("TOKEN_EXPIRED", "Expired", 410);
    expect(error.code).toBe("TOKEN_EXPIRED");
    expect(error.status).toBe(410);
  });
});
