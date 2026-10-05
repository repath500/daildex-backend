import { describe, expect, it } from "vitest";
import { migrations } from "./migrations";

describe("database migrations", () => {
  it("have stable unique identifiers", () => {
    expect(new Set(migrations.map((migration) => migration.id)).size).toBe(migrations.length);
    expect(migrations.map((migration) => migration.id)).toEqual([...migrations.map((migration) => migration.id)].sort());
  });

  it("establish the durable queue and subscription invariants", () => {
    const sql = migrations.map((migration) => migration.sql).join("\n");
    expect(sql).toContain("token_hash TEXT NOT NULL UNIQUE");
    expect(sql).toContain("UNIQUE (raw_event_id, representative_id)");
    expect(sql).toContain("idempotency_key TEXT NOT NULL UNIQUE");
    expect(sql).toContain("status TEXT NOT NULL DEFAULT 'needs_review'");
    expect(sql).toContain("raw_event_targets_processing_lease_idx");
    expect(sql).toContain("error_class TEXT");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS editorial_posts");
    expect(sql).toContain("('editorial_generation', true");
    expect(sql).toContain("editorial_runs_story_period_uidx");
    expect(sql).toContain("editorial_posts_subject_published_idx");
    expect(sql).toContain("normalized_subject TEXT");
  });
});
