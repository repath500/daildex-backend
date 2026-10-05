import { afterEach, describe, expect, it, vi } from "vitest";
import { runPublishWorker } from "./publish-worker";

const published = { approved: 2, expired: 1, held: 0, deferred: 0, emailsQueued: 3 };

afterEach(() => {
  delete process.env.ALERT_AUTO_PUBLISH;
});

describe("publish worker", () => {
  it("publishes waiting drafts without needing a drafting run", async () => {
    const autoPublish = vi.fn(async () => published);
    const close = vi.fn(async () => undefined);
    await expect(runPublishWorker({ isEnabled: async () => true, autoPublish, close })).resolves.toEqual(published);
    expect(autoPublish).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("stops when alert generation is paused", async () => {
    const autoPublish = vi.fn(async () => published);
    await expect(runPublishWorker({ isEnabled: async () => false, autoPublish, close: async () => undefined }))
      .resolves.toEqual({ skipped: "paused" });
    expect(autoPublish).not.toHaveBeenCalled();
  });

  it("respects ALERT_AUTO_PUBLISH=false", async () => {
    process.env.ALERT_AUTO_PUBLISH = "false";
    const autoPublish = vi.fn(async () => published);
    await expect(runPublishWorker({ isEnabled: async () => true, autoPublish, close: async () => undefined }))
      .resolves.toEqual({ skipped: "disabled" });
    expect(autoPublish).not.toHaveBeenCalled();
  });
});
