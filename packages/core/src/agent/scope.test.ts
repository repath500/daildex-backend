import { describe, expect, it } from "vitest";
import { createAgentScopeToken, verifyAgentScopeToken } from "./scope";

const claims = {
  targetId: "target-1",
  workerId: "worker-1",
  runId: "run-1",
  provider: "openrouter",
  model: "hermes-agent",
  providerVerified: true,
  promptVersion: "alert-test",
};

describe("agent scope tokens", () => {
  it("round-trips a signed lease scope", () => {
    const token = createAgentScopeToken({ ...claims, issuedAt: 100, expiresAt: 200 }, "scope-secret");
    expect(verifyAgentScopeToken(token, "scope-secret", 150)).toMatchObject(claims);
  });

  it("rejects tampering and expiry", () => {
    const token = createAgentScopeToken({ ...claims, issuedAt: 100, expiresAt: 200 }, "scope-secret");
    expect(() => verifyAgentScopeToken(`${token}x`, "scope-secret", 150)).toThrow("Invalid or expired");
    expect(() => verifyAgentScopeToken(token, "scope-secret", 200)).toThrow("Invalid or expired");
  });
});
