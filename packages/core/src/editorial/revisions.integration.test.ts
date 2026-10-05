import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { migrate, type Database, type JsonValue } from "@daildex/db";
import { normalizeEditorialUrl, type EditorialStoryCandidate } from "@daildex/shared";
import { editorialBenchmarkCases } from "@daildex/shared/editorial-benchmark";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getPublishedEditorialPost, publishEditorialPost, startEditorialRun } from "./service";
import { claimEditorialRevision, failEditorialRevision, reconsiderPublishedEditorialStories,
  listEditorialRefreshCandidates, requestEditorialRevision, reviewEditorialRevision, saveEditorialRevisionDraft, type ClaimedEditorialRevision } from "./revisions";

// An explicit disposable database is required; never migrate a production DATABASE_URL.
const url = process.env.EDITORIAL_TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run("editorial revisions on PostgreSQL", () => {
  let database: Database;
  let postId: string;
  let runId: string;
  let slug: string;
  let story: EditorialStoryCandidate;
  const original = editorialBenchmarkCases[0].post;
  const pages = new Map([[normalizeEditorialUrl(original.sources[0].url), original.sections.flatMap((section) => section.paragraphs).join("\n")]]);
  const generated = () => ({ output: structuredClone(original), observedUrls: new Set(pages.keys()), fetchedPages: pages,
    model: "test", promptVersion: "test", researchBrief: {}, evidenceFingerprint: "fixture" });

  beforeAll(async () => {
    await migrate(url!);
    database = postgres(url!, { max: 4, prepare: false, transform: { undefined: null } });
  }, 30_000);
  beforeEach(async () => {
    const key = randomUUID();
    slug = `revision-test-${key}`;
    story = { storyKey: key, origin: "parliamentary", kind: "debate", subject: "Harbour transport", normalizedSubject: "harbour transport",
      occurredOn: "2026-09-30", sourceKey: key, outcome: null, primaryUrls: [{ url: original.sources[0].url, publisher: "Houses of the Oireachtas", kind: "official" }],
      reportingUrls: [], participants: [], discoveredFrom: [], score: 0, publicationTier: 2 };
    runId = (await startEditorialRun(story, original.period.start, original.period.end, {}, database)).id;
    postId = (await publishEditorialPost(runId, original, slug, { candidate: story }, story, database))!;
    await database`UPDATE editorial_posts SET published_at = now() - interval '2 days', updated_at = now() - interval '2 days',
      source_checked_at = NULL WHERE id = ${postId}`;
  });
  afterEach(async () => {
    await database`DELETE FROM editorial_posts WHERE id = ${postId}`;
    await database`DELETE FROM editorial_runs WHERE id = ${runId}`;
  });
  afterAll(async () => { await database?.end({ timeout: 5 }); });

  async function ready(): Promise<ClaimedEditorialRevision> {
    await requestEditorialRevision(postId, "correction", "Clarify the motion's effect", "test-editor", database);
    const request = await claimEditorialRevision(database);
    expect(request?.postId).toBe(postId);
    expect(await saveEditorialRevisionDraft(request!, story, generated(), database)).toBe(true);
    return request!;
  }

  it("deduplicates requests and grants only one concurrent lease", async () => {
    const ids = await Promise.all([requestEditorialRevision(postId, "update", "Fresh response", "one", database),
      requestEditorialRevision(postId, "update", "Fresh response", "two", database)]);
    expect(ids.filter(Boolean)).toHaveLength(1);
    const claims = await Promise.all([claimEditorialRevision(database), claimEditorialRevision(database)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it("publishes a reviewed revision at its stable URL and preserves the first publication time", async () => {
    const before = await getPublishedEditorialPost(slug, database);
    const request = await ready();
    await reviewEditorialRevision(request.id, "approved", "Clarified that the motion requests an examination of the route.", "reviewer", database);
    const after = await getPublishedEditorialPost(slug, database);
    expect(after?.slug).toBe(slug);
    expect(after?.publishedAt).toBe(before?.publishedAt);
    expect(Date.parse(after!.modifiedAt)).toBeGreaterThan(Date.parse(before!.modifiedAt));
    expect(after?.revisions).toMatchObject([{ kind: "correction", note: "Clarified that the motion requests an examination of the route." }]);
    const versions = await database<{ previous_content: JsonValue }[]>`SELECT previous_content FROM editorial_post_revisions WHERE post_id = ${postId}`;
    expect(versions[0].previous_content).toEqual(original);
    await expect(reviewEditorialRevision(request.id, "approved", "Duplicate approval", "reviewer", database)).rejects.toThrow("no longer awaiting review");
  });

  it("rejects a stale revision without overwriting a newer article", async () => {
    const request = await ready();
    await database`UPDATE editorial_posts SET updated_at = now(), title = 'Newer editor change' WHERE id = ${postId}`;
    await expect(reviewEditorialRevision(request.id, "approved", "Approve revision", "reviewer", database)).rejects.toThrow("article changed");
    const rows = await database<{ title: string }[]>`SELECT title FROM editorial_posts WHERE id = ${postId}`;
    expect(rows[0].title).toBe("Newer editor change");
  });

  it("requires a review note and leaves rejected drafts out of public history", async () => {
    const request = await ready();
    await expect(reviewEditorialRevision(request.id, "approved", " ", "reviewer", database)).rejects.toThrow("note is required");
    await reviewEditorialRevision(request.id, "rejected", "No material development", "reviewer", database);
    expect((await getPublishedEditorialPost(slug, database))?.revisions).toEqual([]);
    expect(await requestEditorialRevision(postId, "update", "Try with better coverage", "editor", database)).toBeTruthy();
  });

  it("keeps failed source validation out of the review queue", async () => {
    await requestEditorialRevision(postId, "update", "Check sources", "editor", database);
    const request = await claimEditorialRevision(database);
    expect(await saveEditorialRevisionDraft(request!, story, { ...generated(), fetchedPages: new Map() }, database)).toBe(false);
    const rows = await database<{ status: string; error: string }[]>`SELECT status, error FROM editorial_revision_requests WHERE id = ${request!.id}`;
    expect(rows[0].status).toBe("failed");
    expect(rows[0].error).toContain("No source page");
  });

  it("reclaims expired research and refuses results from an old lease", async () => {
    await requestEditorialRevision(postId, "update", "Check sources", "editor", database);
    const first = (await claimEditorialRevision(database))!;
    await database`UPDATE editorial_revision_requests SET locked_at = now() - interval '31 minutes' WHERE id = ${first.id}`;
    const second = (await claimEditorialRevision(database))!;
    expect(second.id).toBe(first.id);
    expect(second.leaseToken).not.toBe(first.leaseToken);
    await expect(saveEditorialRevisionDraft(first, story, generated(), database)).rejects.toThrow("lost its lease");
    await failEditorialRevision(first, "Old failure", database);
    expect(await saveEditorialRevisionDraft(second, story, generated(), database)).toBe(true);
  });

  it("fails exhausted leases so a fresh request is possible", async () => {
    await requestEditorialRevision(postId, "update", "Check sources", "editor", database);
    const request = (await claimEditorialRevision(database))!;
    await database`UPDATE editorial_revision_requests SET attempts = 3, locked_at = now() - interval '31 minutes' WHERE id = ${request.id}`;
    expect(await claimEditorialRevision(database)).toBeNull();
    expect(await requestEditorialRevision(postId, "update", "Retry with new evidence", "editor", database)).toBeTruthy();
  });

  it("carries new coverage into automatic update research and respects the cooldown", async () => {
    const expanded = { ...story, reportingUrls: [{ url: "https://rte.ie/news/new-response", publisher: "RTÉ", kind: "reporting" as const }] };
    await reconsiderPublishedEditorialStories([expanded], database);
    const request = (await claimEditorialRevision(database))!;
    expect(request.candidate?.reportingUrls).toEqual(expanded.reportingUrls);
    await failEditorialRevision(request, "Fixture ends here", database);
    await reconsiderPublishedEditorialStories([expanded], database);
    expect(await claimEditorialRevision(database)).toBeNull();
  });

  it("queues a source-content change even when its URL stays the same", async () => {
    const source = normalizeEditorialUrl(original.sources[0].url);
    await database`UPDATE editorial_posts SET model_metadata = model_metadata ||
      ${database.json({ sourceFingerprints: { [source]: "old" } })} WHERE id = ${postId}`;
    await reconsiderPublishedEditorialStories([story], database, async (_story, urls) => {
      expect(urls).toEqual([source]);
      return { [source]: "new" };
    });
    expect((await claimEditorialRevision(database))?.reason).toContain("existing source has changed");
  });

  it("does not interpret a failed source recheck as new information", async () => {
    const source = normalizeEditorialUrl(original.sources[0].url);
    await database`UPDATE editorial_posts SET model_metadata = model_metadata ||
      ${database.json({ sourceFingerprints: { [source]: "old" } })} WHERE id = ${postId}`;
    await reconsiderPublishedEditorialStories([story], database, async () => ({}));
    expect(await claimEditorialRevision(database)).toBeNull();
  });

  it("rotates older articles out of maintenance after a successful unchanged-source check", async () => {
    const source = normalizeEditorialUrl(original.sources[0].url);
    await database`UPDATE editorial_posts SET model_metadata = model_metadata ||
      ${database.json({ sourceFingerprints: { [source]: "old" } })} WHERE id = ${postId}`;
    expect((await listEditorialRefreshCandidates(database)).map((candidate) => candidate.storyKey)).toContain(story.storyKey);
    await reconsiderPublishedEditorialStories([story], database, async () => ({ [source]: "old" }));
    expect((await listEditorialRefreshCandidates(database)).map((candidate) => candidate.storyKey)).not.toContain(story.storyKey);
    expect(await claimEditorialRevision(database)).toBeNull();
  });

  it("keeps maintenance pending when the worker has no recheck budget left", async () => {
    const source = normalizeEditorialUrl(original.sources[0].url);
    await database`UPDATE editorial_posts SET model_metadata = model_metadata ||
      ${database.json({ sourceFingerprints: { [source]: "old" } })} WHERE id = ${postId}`;
    await reconsiderPublishedEditorialStories([story], database, async () => null);
    expect((await listEditorialRefreshCandidates(database)).map((candidate) => candidate.storyKey)).toContain(story.storyKey);
    expect(await claimEditorialRevision(database)).toBeNull();
  });
});
