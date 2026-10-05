import { describe, expect, it, vi } from "vitest";
import type { ClaimedAlertTarget } from "@daildex/shared";
import { HermesApiError } from "./hermes-client";
import { runAlertWorker } from "./alert-worker";

const target: ClaimedAlertTarget = {
  targetId: "target-1",
  rawEventId: "event-1",
  attemptCount: 1,
  sourceType: "oireachtas_vote",
  sourceUrl: "https://www.oireachtas.ie/example",
  rawText: "Official event text",
  participation: "Tá",
  representative: {
    id: "rep-1",
    name: "Example TD",
    chamber: "Dáil",
    role: "TD",
    area: "Dublin",
    party: "Example Party",
  },
};

const envKeys = [
  "HERMES_API_BASE_URL",
  "HERMES_API_KEY",
  "HERMES_ALERT_MODEL",
  "HERMES_ALERT_PROVIDER",
  "HERMES_ALERT_TIMEOUT_MS",
  "HERMES_DRAFT_MODE",
  "HERMES_USE_RUNS",
  "HERMES_FALLBACK_ENABLED",
  "HERMES_ALLOWED_PROVIDERS",
  "HERMES_ALLOWED_MODELS",
  "HERMES_EXPECTED_TOOL_NAMES",
  "ALERT_WORKER_BATCH_SIZE",
  "DAILDEX_AGENT_TOKEN",
  "ALERT_AUTO_PUBLISH",
];

async function withWorkerEnv(callback: () => Promise<void>) {
  const previous = new Map(envKeys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    HERMES_API_BASE_URL: "http://127.0.0.1:8642",
    HERMES_API_KEY: "test-key",
    HERMES_ALERT_MODEL: "hermes-agent",
    HERMES_ALERT_PROVIDER: "configured",
    HERMES_ALERT_TIMEOUT_MS: "5000",
    HERMES_DRAFT_MODE: "prompt_json",
    HERMES_USE_RUNS: "false",
    HERMES_FALLBACK_ENABLED: "false",
    HERMES_EXPECTED_TOOL_NAMES: "",
    ALERT_WORKER_BATCH_SIZE: "5",
    ALERT_AUTO_PUBLISH: "false",
  });
  try {
    await callback();
  } finally {
    for (const key of envKeys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("alert worker orchestration", () => {
  it("publishes passing drafts at the end of a run without a reviewer", async () => {
    await withWorkerEnv(async () => {
      process.env.ALERT_AUTO_PUBLISH = "true";
      const autoPublish = vi.fn(async () => ({ approved: 2, expired: 1, held: 0, deferred: 0, emailsQueued: 3 }));
      const result = await runAlertWorker({
        hashPrompt: async () => "alert-test",
        verifyCapabilities: async () => ({ features: {}, tools: [] }),
        isEnabled: async () => true,
        claim: async () => null,
        autoPublish,
        close: async () => undefined,
      });
      expect(autoPublish).toHaveBeenCalledOnce();
      expect(result.published).toEqual({ approved: 2, expired: 1, held: 0, deferred: 0, emailsQueued: 3 });
    });
  });

  it("does not publish when alert generation is paused", async () => {
    await withWorkerEnv(async () => {
      process.env.ALERT_AUTO_PUBLISH = "true";
      const autoPublish = vi.fn();
      const result = await runAlertWorker({
        hashPrompt: async () => "alert-test",
        verifyCapabilities: async () => ({ features: {}, tools: [] }),
        isEnabled: async () => false,
        autoPublish,
        close: async () => undefined,
      });
      expect(result.paused).toBe(true);
      expect(autoPublish).not.toHaveBeenCalled();
    });
  });

  it("continues the batch and exits successfully when a single draft is malformed", async () => {
    await withWorkerEnv(async () => {
      let claims = 0;
      const release = vi.fn(async () => ({ released: true, status: "needs_review" }));
      const result = await runAlertWorker({
        hashPrompt: async () => "alert-test",
        verifyCapabilities: async () => ({ features: {}, tools: [] }),
        isEnabled: async () => true,
        claim: async () => claims++ === 0 ? target : null,
        startRun: async () => "run-1",
        request: async () => {
          throw new HermesApiError("bad JSON", "invalid_output");
        },
        release,
        close: async () => undefined,
      });
      expect(result).toEqual({ claimed: 1, processed: 0, failures: 1, paused: false });
      expect(release).toHaveBeenCalledWith(
        expect.stringContaining("alert-"),
        "target-1",
        { message: "bad JSON", classification: "invalid_output" },
        expect.objectContaining({ promptVersion: "alert-test" }),
      );
    });
  });

  it("releases a claimed row without spending a model call when the kill switch changes", async () => {
    await withWorkerEnv(async () => {
      let checks = 0;
      const release = vi.fn(async () => ({ released: true, status: "pending" }));
      const request = vi.fn();
      const result = await runAlertWorker({
        hashPrompt: async () => "alert-test",
        verifyCapabilities: async () => ({ features: {}, tools: [] }),
        isEnabled: async () => checks++ === 0,
        claim: async () => target,
        startRun: async () => "run-1",
        request,
        release,
        close: async () => undefined,
      });
      expect(result).toMatchObject({ claimed: 1, processed: 0, failures: 0, paused: true });
      expect(request).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledWith(
        expect.stringContaining("alert-"),
        "target-1",
        expect.objectContaining({ classification: "paused" }),
        expect.anything(),
      );
    });
  });

  it("finalizes telemetry after an MCP tool submits the draft", async () => {
    await withWorkerEnv(async () => {
      process.env.HERMES_DRAFT_MODE = "mcp_tool";
      process.env.DAILDEX_AGENT_TOKEN = "test-agent-token";
      let claims = 0;
      const getResult = vi.fn(async () => ({
        targetStatus: "processed" as const,
        alertItemId: "alert-1",
        runStatus: "succeeded" as const,
        outcome: null,
      }));
      const finalizeRun = vi.fn(async () => undefined);
      const result = await runAlertWorker({
        hashPrompt: async () => "alert-test",
        verifyCapabilities: async () => ({ features: {}, tools: [] }),
        isEnabled: async () => true,
        claim: async () => claims++ === 0 ? target : null,
        startRun: async () => "run-1",
        request: async (_target, config) => ({
          draft: null,
          responseContent: null,
          metadata: {
            provider: "openrouter",
            model: "hermes-agent",
            promptVersion: config.promptVersion,
            requestId: "response-1",
            providerVerified: true,
          },
        }),
        getResult,
        finalizeRun,
        close: async () => undefined,
      });
      expect(result).toEqual({ claimed: 1, processed: 1, failures: 0, paused: false });
      expect(getResult).toHaveBeenCalledWith("target-1", "run-1");
      expect(finalizeRun).toHaveBeenCalledWith(
        "run-1",
        "target-1",
        expect.objectContaining({ requestId: "response-1", runId: "run-1" }),
      );
    });
  });

  it("shrinks the batch to fit the systemd service budget instead of refusing to run", async () => {
    await withWorkerEnv(async () => {
      process.env.ALERT_WORKER_BATCH_SIZE = "10";
      process.env.HERMES_ALERT_TIMEOUT_MS = "45000";
      const claim = vi.fn(async () => null);
      await expect(runAlertWorker({
        hashPrompt: async () => "alert-test",
        verifyCapabilities: async () => ({ features: {}, tools: [] }),
        isEnabled: async () => true,
        claim,
        autoPublish: async () => ({ approved: 0, expired: 0, held: 0, deferred: 0, emailsQueued: 0 }),
        close: async () => undefined,
      })).resolves.toMatchObject({ claimed: 0, failures: 0 });
      expect(claim).toHaveBeenCalledOnce();
    });
  });
});
