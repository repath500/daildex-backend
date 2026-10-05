import { randomUUID } from "node:crypto";
import { closeDatabase, getDatabase } from "@daildex/db";
import type { EditorialStoryCandidate } from "@daildex/shared";
import { afterAll, describe, expect, it } from "vitest";
import { startEditorialRun } from "./service";

const run = process.env.DATABASE_URL ? describe : describe.skip;

run("editorial run leases", () => {
  const database = process.env.DATABASE_URL ? getDatabase() : null!;
  const storyKey = `lease-${randomUUID()}`;
  const story: Pick<
    EditorialStoryCandidate,
    "storyKey" | "kind" | "origin" | "subject" | "normalizedSubject" | "sourceKey"
  > = {
    storyKey,
    kind: "vote",
    origin: "parliamentary",
    subject: "Integration lease fixture",
    normalizedSubject: "integration lease fixture",
    sourceKey: storyKey,
  };
  const periodStart = "2099-01-05";
  const periodEnd = "2099-01-11";

  afterAll(async () => {
    await database`DELETE FROM editorial_runs WHERE story_key = ${storyKey}`;
    await closeDatabase();
  });

  it("allows exactly one concurrent worker to acquire a fresh story", async () => {
    const attempts = await Promise.all([
      startEditorialRun(story, periodStart, periodEnd, { worker: "first" }, database),
      startEditorialRun(story, periodStart, periodEnd, { worker: "second" }, database),
    ]);

    expect(new Set(attempts.map((attempt) => attempt.id)).size).toBe(1);
    expect(attempts.filter((attempt) => attempt.acquired)).toHaveLength(1);
  });

  it("reacquires an expired lease but never a published run", async () => {
    await database`
      UPDATE editorial_runs
      SET status = 'running', started_at = now() - interval '3 hours'
      WHERE story_key = ${storyKey}
    `;
    const expired = await startEditorialRun(story, periodStart, periodEnd, { worker: "expired" }, database);
    expect(expired.acquired).toBe(true);

    await database`UPDATE editorial_runs SET status = 'published' WHERE story_key = ${storyKey}`;
    const published = await startEditorialRun(story, periodStart, periodEnd, { worker: "published" }, database);
    expect(published.acquired).toBe(false);
  });
});
