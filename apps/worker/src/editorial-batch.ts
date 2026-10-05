import { EditorialDiscoveryError } from "@daildex/core/editorial/parliamentary";
import {
  applyEvidencePolicies,
  editorialNewsSlug,
  mergeEditorialStoryCandidates,
  parliamentaryDiscoveryWindow,
  rankEditorialStories,
  storyInvolvesNames,
  validateEditorialFinal,
  evaluateEditorialQuality,
  normalizeEditorialDate,
  type EditorialFinal,
  type EditorialStoryCandidate,
} from "@daildex/shared";

export type EditorialBatchMetrics = {
  discoveredParliamentary: number;
  discoveredMedia: number;
  clusters: number;
  eligible: number;
  selected: number;
  processed: number;
  leaseSkipped: number;
  published: number;
  suppressed: number;
  failed: number;
  deferred: number;
  durationMs: number;
  dryRun: number;
};

export type EditorialBatchDependencies = {
  period: { start: string; end: string };
  maxStories: number;
  timeoutMs: number;
  dryRun: boolean;
  now?: () => number;
  log?: (event: Record<string, unknown>) => void;
  discoverParliamentary: (window: { start: string; end: string }) => Promise<EditorialStoryCandidate[]>;
  discoverNational: (period: { start: string; end: string }) => Promise<{ candidates: EditorialStoryCandidate[]; clusters: number }>;
  publishedStoryKeys: () => Promise<ReadonlySet<string>>;
  reconsiderPublished?: (stories: readonly EditorialStoryCandidate[]) => Promise<void>;
  /** Stories the validator rejected recently. Skipped so they do not take every daily slot. */
  recentlySuppressedStoryKeys?: () => Promise<ReadonlySet<string>>;
  repeatedSubjects: (subjects: readonly string[]) => Promise<ReadonlySet<string>>;
  constituencyNames: () => Promise<readonly string[] | null>;
  existingSlugs: () => Promise<ReadonlySet<string>>;
  acquire: (story: EditorialStoryCandidate) => Promise<{ id: string; acquired: boolean }>;
  generate: (story: EditorialStoryCandidate) => Promise<{
    output: unknown;
    observedUrls: ReadonlySet<string>;
    model?: string;
    promptVersion?: string;
    passes?: Array<{ name: string; steps: number; inputTokens: number | null; outputTokens: number | null }>;
    fetchedPages?: ReadonlyMap<string, string>;
    researchBrief?: unknown;
    evidenceFingerprint?: string;
    sourceFingerprints?: Record<string, string>;
  }>;
  publish: (
    runId: string,
    story: EditorialStoryCandidate,
    output: EditorialFinal,
    slug: string,
    generation: Record<string, unknown>,
  ) => Promise<void>;
  finish: (runId: string, status: "suppressed" | "failed", error: string | null, payload: Record<string, unknown>) => Promise<void>;
};

function emptyMetrics(started: number, now: number): EditorialBatchMetrics {
  return {
    discoveredParliamentary: 0,
    discoveredMedia: 0,
    clusters: 0,
    eligible: 0,
    selected: 0,
    processed: 0,
    leaseSkipped: 0,
    published: 0,
    suppressed: 0,
    failed: 0,
    deferred: 0,
    durationMs: now - started,
    dryRun: 0,
  };
}

export async function runEditorialBatch(dependencies: EditorialBatchDependencies): Promise<EditorialBatchMetrics> {
  const started = (dependencies.now ?? Date.now)();
  const log = dependencies.log ?? ((event) => console.log(JSON.stringify(event)));
  const clock = dependencies.now ?? Date.now;
  try {
    const window = parliamentaryDiscoveryWindow(dependencies.period);
    const parliamentary = await dependencies.discoverParliamentary(window);
    // National news is a second lane. If its search or classifier fails, still
    // publish from the Oireachtas record rather than abandoning the run.
    let media: { candidates: EditorialStoryCandidate[]; clusters: number } = { candidates: [], clusters: 0 };
    try {
      media = await dependencies.discoverNational(dependencies.period);
    } catch (error) {
      log({
        event: "editorial.discovery_failed",
        category: "national",
        continuing: true,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
      });
    }
    const merged = mergeEditorialStoryCandidates(parliamentary, media.candidates);
    const current = merged.filter((story) => {
      const date = normalizeEditorialDate(story.occurredOn);
      const inPeriod = date && date >= dependencies.period.start && date <= dependencies.period.end;
      if (!inPeriod) log({ event: "editorial.skipped", storyKey: story.storyKey, subject: story.subject, reason: "outside_period" });
      return inPeriod;
    });
    const { eligible, deferred } = applyEvidencePolicies(current);
    const publishedKeys = await dependencies.publishedStoryKeys();
    if (!dependencies.dryRun) await dependencies.reconsiderPublished?.(eligible.filter((story) => publishedKeys.has(story.storyKey)));
    const suppressedKeys = (await dependencies.recentlySuppressedStoryKeys?.()) ?? new Set<string>();
    const fresh = eligible.filter((story) => !publishedKeys.has(story.storyKey) && !suppressedKeys.has(story.storyKey));
    const names = await dependencies.constituencyNames();
    const filtered = names ? fresh.filter((story) => storyInvolvesNames(story, names)) : fresh;
    const repeated = await dependencies.repeatedSubjects(filtered.map((story) => story.normalizedSubject));
    const ranked = rankEditorialStories(filtered, repeated, dependencies.period.end);
    for (const story of deferred) {
      log({
        event: "editorial.deferred",
        storyKey: story.storyKey,
        subject: story.subject,
        reason: "insufficient_evidence",
        officialSources: story.primaryUrls.filter((source) => source.kind === "official").length,
        reportingSources: story.reportingUrls.filter((source) => source.kind === "reporting").length,
      });
    }
    for (const story of eligible) {
      if (publishedKeys.has(story.storyKey)) {
        log({ event: "editorial.skipped", storyKey: story.storyKey, subject: story.subject, reason: "already_published" });
      } else if (suppressedKeys.has(story.storyKey)) {
        log({ event: "editorial.skipped", storyKey: story.storyKey, subject: story.subject, reason: "recently_suppressed" });
      } else if (names && !storyInvolvesNames(story, names)) {
        log({ event: "editorial.skipped", storyKey: story.storyKey, subject: story.subject, reason: "constituency_filter" });
      }
    }
    for (const story of ranked) {
      log({
        event: "editorial.score",
        subject: story.subject,
        score: story.score,
        components: story.scoreComponents ?? {},
        tier: story.publicationTier ?? null,
      });
    }
    const slugs = new Set(await dependencies.existingSlugs());
    const coveredEvents = new Set<string>();
    const metrics: EditorialBatchMetrics = {
      ...emptyMetrics(started, clock()),
      discoveredParliamentary: parliamentary.length,
      discoveredMedia: media.candidates.length,
      clusters: media.clusters,
      eligible: filtered.length,
      deferred: deferred.length,
    };

    for (const story of ranked) {
      const eventIdentity = `${story.normalizedSubject}|${story.occurredOn}`;
      if (coveredEvents.has(eventIdentity)) {
        log({ event: "editorial.skipped", storyKey: story.storyKey, subject: story.subject, reason: "event_already_covered" });
        continue;
      }
      if (metrics.selected >= dependencies.maxStories) break;
      if (clock() - started > dependencies.timeoutMs) {
        log({ event: "editorial.batch.timeout", selectedRemaining: true });
        break;
      }
      const lease = await dependencies.acquire(story);
      if (!lease.acquired) {
        metrics.leaseSkipped += 1;
        log({ event: "editorial.skipped", storyKey: story.storyKey, subject: story.subject, reason: "active_lease" });
        continue;
      }
      metrics.selected += 1;
      try {
        const generated = await dependencies.generate(story);
        const generation = {
          model: generated.model ?? null,
          promptVersion: generated.promptVersion ?? null,
          passes: generated.passes ?? [],
          researchBrief: generated.researchBrief ?? null,
          evidenceFingerprint: generated.evidenceFingerprint ?? null,
          sourceFingerprints: generated.sourceFingerprints ?? {},
          readSources: generated.fetchedPages?.size ?? 0,
          candidate: { ...story, passages: undefined },
        };
        const checked = validateEditorialFinal({
          story,
          output: generated.output,
          observedUrls: generated.observedUrls,
          periodStart: dependencies.period.start,
          periodEnd: dependencies.period.end,
          fetchedPages: generated.fetchedPages,
        });
        if (!checked.valid) {
          metrics.suppressed += 1;
          log({ event: "editorial.suppressed", storyKey: story.storyKey, subject: story.subject, issues: checked.issues });
          await dependencies.finish(lease.id, "suppressed", checked.issues.join("; "), { article: generated.output, issues: checked.issues, generation });
          continue;
        }
        Object.assign(generation, { quality: evaluateEditorialQuality(checked.post) });
        if (dependencies.dryRun) {
          metrics.dryRun += 1;
          log({ event: "editorial.dry_run", storyKey: story.storyKey, subject: story.subject, title: checked.post.title });
          await dependencies.finish(lease.id, "suppressed", "dry_run", { article: checked.post, generation });
          coveredEvents.add(eventIdentity);
          continue;
        }
        const slug = editorialNewsSlug(story.subject, story.occurredOn, story.storyKey, slugs);
        slugs.add(slug);
        await dependencies.publish(lease.id, story, checked.post, slug, generation);
        coveredEvents.add(eventIdentity);
        metrics.published += 1;
        log({ event: "editorial.published", storyKey: story.storyKey, subject: story.subject, slug });
      } catch (error) {
        metrics.failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        log({ event: "editorial.story_failed", storyKey: story.storyKey, subject: story.subject, error: message.slice(0, 300) });
        await dependencies.finish(lease.id, "failed", message.slice(0, 500), { message });
      } finally {
        metrics.processed += 1;
      }
    }

    metrics.durationMs = clock() - started;
    log({ event: "editorial.batch.complete", ...metrics });
    return metrics;
  } catch (error) {
    if (error instanceof EditorialDiscoveryError) {
      log({
        event: "editorial.discovery_failed",
        category: error.category,
        error: error.message.slice(0, 500),
      });
      const metrics = emptyMetrics(started, clock());
      log({ event: "editorial.batch.complete", outcome: "discovery_failed", ...metrics });
      throw error;
    }
    throw error;
  }
}
