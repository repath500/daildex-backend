import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import {
  claimAlertTarget,
  finalizeAlertRunMetadata,
  getAlertResultForTarget,
  releaseAlertTarget,
  startAlertRun,
  writeAlertDraft,
} from "@daildex/core/alerts";
import { createAgentScopeToken } from "@daildex/core/agent/scope";
import { autoPublishAlerts } from "@daildex/core/review";
import { isRuntimeControlEnabled } from "@daildex/core/operations";
import { closeDatabase } from "@daildex/db";
import {
  type AlertAgentOutcome,
  type AlertRunMetadata,
  type AlertTargetFailure,
} from "@daildex/shared";
import {
  hashAlertPromptFiles,
  HermesApiError,
  requestHermesDraft,
  validateHermesConfiguration,
  verifyHermesCapabilities,
  type AlertDraftMode,
  type HermesClientConfig,
} from "./hermes-client";

type AlertWorkerDependencies = {
  claim?: typeof claimAlertTarget;
  release?: typeof releaseAlertTarget;
  write?: typeof writeAlertDraft;
  getResult?: typeof getAlertResultForTarget;
  finalizeRun?: typeof finalizeAlertRunMetadata;
  startRun?: typeof startAlertRun;
  isEnabled?: typeof isRuntimeControlEnabled;
  close?: typeof closeDatabase;
  request?: typeof requestHermesDraft;
  verifyCapabilities?: typeof verifyHermesCapabilities;
  hashPrompt?: typeof hashAlertPromptFiles;
  autoPublish?: typeof autoPublishAlerts;
};

export type AlertWorkerResult = {
  claimed: number;
  processed: number;
  failures: number;
  paused: boolean;
  published?: Awaited<ReturnType<typeof autoPublishAlerts>>;
};

/** Drafts go out without a person approving them unless ALERT_AUTO_PUBLISH=false. */
/** Hardcoded so a stray env value cannot swap the drafting model. Hermes itself is pinned by HERMES_MODEL in its profile. */
export const ALERT_MODEL = "inclusionai/ling-3.0-flash-vl";

export function autoPublishEnabled(value = process.env.ALERT_AUTO_PUBLISH): boolean {
  return value?.trim().toLowerCase() !== "false";
}

export async function runAlertWorker(
  dependencies: AlertWorkerDependencies = {},
): Promise<AlertWorkerResult> {
  const workerId = `alert-${process.pid}-${Date.now()}`;
  const close = dependencies.close ?? closeDatabase;
  const enabled = dependencies.isEnabled ?? isRuntimeControlEnabled;
  const claim = dependencies.claim ?? claimAlertTarget;
  const release = dependencies.release ?? releaseAlertTarget;
  const write = dependencies.write ?? writeAlertDraft;
  const getResult = dependencies.getResult ?? getAlertResultForTarget;
  const finalizeRun = dependencies.finalizeRun ?? finalizeAlertRunMetadata;
  const startRun = dependencies.startRun ?? startAlertRun;
  const request = dependencies.request ?? requestHermesDraft;
  const verifyCapabilities = dependencies.verifyCapabilities ?? verifyHermesCapabilities;
  const hashPrompt = dependencies.hashPrompt ?? hashAlertPromptFiles;
  const autoPublish = dependencies.autoPublish ?? autoPublishAlerts;

  try {
    const config = await loadConfig(hashPrompt);
    if (!await enabled("alert_generation")) {
      console.log(JSON.stringify({ event: "worker.paused", worker: "alert", control: "alert_generation" }));
      return { claimed: 0, processed: 0, failures: 0, paused: true };
    }

    await verifyCapabilities(config, {
      expectedToolNames: parseList(process.env.HERMES_EXPECTED_TOOL_NAMES),
    });

    // Shrink the batch to fit the four-minute service budget rather than refusing to run.
    const requestedBatchSize = boundedBatchSize(process.env.ALERT_WORKER_BATCH_SIZE, 5);
    const batchSize = Math.max(1, Math.min(requestedBatchSize, Math.floor(225_000 / config.timeoutMs)));
    if (batchSize < requestedBatchSize) {
      console.log(JSON.stringify({ event: "alert.worker.batch_clamped", requested: requestedBatchSize, batchSize }));
    }
    let claimed = 0;
    let processed = 0;
    let failures = 0;
    let paused = false;

    while (claimed < batchSize) {
      const target = await claim(workerId);
      if (!target) break;
      claimed += 1;

      if (!await enabled("alert_generation")) {
        await releasePaused(release, workerId, target.targetId, config);
        paused = true;
        break;
      }

      let runId: string | undefined;
      try {
        runId = await startRun(workerId, target.targetId, {
          provider: config.provider,
          model: config.model,
          promptVersion: config.promptVersion,
          providerVerified: false,
        });
        const scopeToken = config.mode === "mcp_tool"
          ? createAgentScopeToken({
            targetId: target.targetId,
            workerId,
            runId,
            provider: config.provider,
            model: config.model,
            providerVerified: false,
            promptVersion: config.promptVersion,
          })
          : undefined;
        const result = await request(target, {
          ...config,
          scopeToken,
          idempotencyKey: config.useRuns
            ? `${target.targetId}:${target.attemptCount}:${config.promptVersion}`
            : undefined,
        });
        let alertItemId: string | undefined;
        let outcome: AlertAgentOutcome = "draft";
        const metadata: AlertRunMetadata = { ...result.metadata, runId };
        if (result.draft) {
          const written = await write(workerId, target, result.draft, metadata);
          alertItemId = written.alertItemId;
        } else {
          if (!runId) throw new HermesApiError("Hermes tool run did not have an application run id.", "configuration");
          const submitted = await getResult(target.targetId, runId);
          if (!submitted || submitted.runStatus !== "succeeded" || (!submitted.alertItemId && !submitted.outcome)) {
            throw new HermesApiError("Hermes did not complete a DáilDex alert outcome.", "invalid_output");
          }
          await finalizeRun(runId, target.targetId, metadata);
          alertItemId = submitted.alertItemId ?? undefined;
          outcome = submitted.outcome ?? "draft";
        }
        processed += 1;
        console.log(JSON.stringify({
          event: "alert.completed",
          outcome,
          alertItemId: alertItemId ?? null,
          targetId: target.targetId,
          provider: result.metadata.provider,
          model: result.metadata.model,
          promptVersion: result.metadata.promptVersion,
          requestId: result.metadata.requestId ?? null,
          hermesRunId: result.metadata.hermesRunId ?? null,
          inputTokens: result.metadata.inputTokens ?? null,
          outputTokens: result.metadata.outputTokens ?? null,
          latencyMs: result.metadata.latencyMs ?? null,
          providerVerified: result.metadata.providerVerified ?? false,
          runId,
        }));
      } catch (error) {
        failures += 1;
        const failure = classifyAlertError(error);
        try {
          await release(workerId, target.targetId, failure, metadataForFailure(config, runId));
        } catch (releaseError) {
          console.error(JSON.stringify({
            event: "alert.release.failed",
            targetId: target.targetId,
            error: safeErrorMessage(releaseError),
          }));
        }
        console.error(JSON.stringify({
          event: "alert.draft.failed",
          targetId: target.targetId,
          classification: failure.classification,
          error: failure.message.slice(0, 300),
        }));
      }
    }
    // Publishing also covers drafts from earlier runs and from the MCP tool path.
    // Pausing alert_generation stops it along with drafting.
    let published: AlertWorkerResult["published"];
    if (!paused && autoPublishEnabled()) {
      try {
        published = await autoPublish();
      } catch (error) {
        console.error(JSON.stringify({ event: "alert.auto_publish.failed", error: safeErrorMessage(error) }));
      }
    }
    console.log(JSON.stringify({ event: "alert.worker.completed", claimed, processed, failures, paused, published: published ?? null }));
    return { claimed, processed, failures, paused, published };
  } finally {
    await close();
  }
}

async function loadConfig(hashPrompt: typeof hashAlertPromptFiles): Promise<HermesClientConfig> {
  const baseUrl = process.env.HERMES_API_BASE_URL?.replace(/\/$/, "");
  const apiKey = process.env.HERMES_API_KEY;
  if (!baseUrl || !apiKey) throw new Error("HERMES_API_BASE_URL and HERMES_API_KEY are required");

  const mode = process.env.HERMES_DRAFT_MODE ?? "prompt_json";
  if (mode !== "prompt_json" && mode !== "mcp_tool") throw new Error("HERMES_DRAFT_MODE must be prompt_json or mcp_tool");
  if (mode === "mcp_tool" && !process.env.DAILDEX_AGENT_TOKEN?.trim()) {
    throw new Error("DAILDEX_AGENT_TOKEN is required when HERMES_DRAFT_MODE=mcp_tool");
  }

  const config: HermesClientConfig = {
    baseUrl,
    apiKey,
    model: ALERT_MODEL,
    provider: process.env.HERMES_ALERT_PROVIDER ?? process.env.HERMES_MODEL_PROVIDER ?? "configured",
    promptVersion: await hashPrompt(process.env.DAILDEX_ALERT_PROMPT_ROOT),
    timeoutMs: boundedTimeout(process.env.HERMES_ALERT_TIMEOUT_MS, 45_000),
    mode: mode as AlertDraftMode,
    useRuns: process.env.HERMES_USE_RUNS === "true",
    fallbackEnabled: process.env.HERMES_FALLBACK_ENABLED === "true",
    allowedProviders: parseList(process.env.HERMES_ALLOWED_PROVIDERS),
    allowedModels: parseList(process.env.HERMES_ALLOWED_MODELS),
  };
  validateHermesConfiguration(config);
  return config;
}

function classifyAlertError(error: unknown): AlertTargetFailure {
  if (error instanceof HermesApiError) return { message: error.message, classification: error.classification };
  if (error instanceof Error && error.name === "AppError") {
    const appError = error as Error & { code?: string };
    if (appError.code === "CONFLICT") return { message: error.message, classification: "lease_lost" };
    if (appError.code === "SERVICE_UNAVAILABLE") return { message: error.message, classification: "configuration" };
    if (appError.code === "INVALID_REQUEST") return { message: error.message, classification: "policy" };
  }
  return { message: safeErrorMessage(error), classification: "unknown" };
}

function metadataForFailure(config: HermesClientConfig, runId?: string): AlertRunMetadata {
  return {
    provider: config.provider,
    model: config.model,
    promptVersion: config.promptVersion,
    runId,
    providerVerified: false,
  };
}

async function releasePaused(
  release: typeof releaseAlertTarget,
  workerId: string,
  targetId: string,
  config: HermesClientConfig,
) {
  await release(workerId, targetId, { message: "Alert generation is paused by the runtime control.", classification: "paused" }, {
    provider: config.provider,
    model: config.model,
    promptVersion: config.promptVersion,
    providerVerified: false,
  });
  console.log(JSON.stringify({ event: "alert.worker.paused", targetId }));
}

export function boundedBatchSize(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) throw new Error("ALERT_WORKER_BATCH_SIZE must be from 1 to 100");
  return parsed;
}

function boundedTimeout(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 5_000 || parsed > 120_000) {
    throw new Error("HERMES_ALERT_TIMEOUT_MS must be an integer from 5000 to 120000");
  }
  return parsed;
}

function parseList(value: string | undefined): string[] {
  return (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Unknown alert generation error";
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return Boolean(entry && import.meta.url === pathToFileURL(resolve(entry)).href);
}

if (isMainModule()) {
  try {
    await runAlertWorker();
  } catch (error) {
    console.error(JSON.stringify({ event: "alert.worker.failed", error: safeErrorMessage(error) }));
    process.exitCode = 1;
  }
}
