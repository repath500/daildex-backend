import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { autoPublishAlerts } from "@daildex/core/review";
import { isRuntimeControlEnabled } from "@daildex/core/operations";
import { closeDatabase } from "@daildex/db";
import { autoPublishEnabled } from "./alert-worker";

type PublishWorkerDependencies = {
  isEnabled?: typeof isRuntimeControlEnabled;
  autoPublish?: typeof autoPublishAlerts;
  close?: typeof closeDatabase;
};

export type PublishWorkerResult =
  | { skipped: "paused" | "disabled" }
  | Awaited<ReturnType<typeof autoPublishAlerts>>;

/**
 * Publishes waiting alert drafts on its own schedule, so a drafting outage
 * (Hermes down, rate limited, misconfigured) never strands drafts that are ready.
 */
export async function runPublishWorker(
  dependencies: PublishWorkerDependencies = {},
): Promise<PublishWorkerResult> {
  const enabled = dependencies.isEnabled ?? isRuntimeControlEnabled;
  const autoPublish = dependencies.autoPublish ?? autoPublishAlerts;
  const close = dependencies.close ?? closeDatabase;
  try {
    if (!autoPublishEnabled()) {
      console.log(JSON.stringify({ event: "worker.disabled", worker: "publish", env: "ALERT_AUTO_PUBLISH" }));
      return { skipped: "disabled" };
    }
    if (!await enabled("alert_generation")) {
      console.log(JSON.stringify({ event: "worker.paused", worker: "publish", control: "alert_generation" }));
      return { skipped: "paused" };
    }
    const result = await autoPublish();
    console.log(JSON.stringify({ event: "alert.publish.completed", ...result }));
    return result;
  } finally {
    await close();
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return Boolean(entry && import.meta.url === pathToFileURL(resolve(entry)).href);
}

if (isMainModule()) {
  try {
    await runPublishWorker();
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : "Unknown publish error";
    console.error(JSON.stringify({ event: "alert.publish.failed", error: message }));
    process.exitCode = 1;
  }
}
