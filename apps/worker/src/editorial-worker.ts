import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import {
  finishEditorialRun,
  listConstituencyTdNames,
  listEditorialSlugs,
  listPublishedEditorialStoryKeys,
  listRecentEditorialSubjects,
  listRecentlySuppressedEditorialStoryKeys,
  publishEditorialPost,
  startEditorialRun,
  claimEditorialRevision,
  saveEditorialRevisionDraft,
  failEditorialRevision,
  reconsiderPublishedEditorialStories,
  resolveEditorialParticipants,
  listEditorialRefreshCandidates,
} from "@daildex/core/editorial";
import { discoverParliamentaryStories } from "@daildex/core/editorial/parliamentary";
import { isRuntimeControlEnabled } from "@daildex/core/operations";
import { closeDatabase, getDatabase } from "@daildex/db";
import {
  resolveEditorialCadence,
  resolveEditorialModelId,
  resolveEditorialPeriod,
  resolveEditorialVerifyModelId,
  normalizeEditorialUrl,
  editorialResearchDomains,
  type EditorialFinal,
} from "@daildex/shared";
import { runEditorialBatch } from "./editorial-batch";
import { EDITORIAL_PROMPT_VERSION, runEditorialStory } from "./editorial-generate";
import { addOfficialPassages, fetchEvidencePages, fingerprintEvidencePages } from "./editorial-evidence";
import { discoverNationalPoliticalStories } from "./editorial-media";
import { indexNowSiteUrl, submitIndexNow } from "./indexnow";

export async function runEditorialWorker(): Promise<{ published: number; skipped: boolean }> {
  const startedAt = Date.now();
  const database = getDatabase();
  try {
    if (!await isRuntimeControlEnabled("editorial_generation", database)) {
      console.log(JSON.stringify({ event: "worker.paused", worker: "editorial", control: "editorial_generation" }));
      return { published: 0, skipped: true };
    }

    const cadence = resolveEditorialCadence(process.env.EDITORIAL_CADENCE);
    const period = resolveEditorialPeriod(new Date(), {
      start: process.env.EDITORIAL_PERIOD_START,
      end: process.env.EDITORIAL_PERIOD_END,
    }, cadence);
    const model = resolveEditorialModelId();
    const verifyModel = resolveEditorialVerifyModelId();
    const maxStories = boundedCount(process.env.EDITORIAL_MAX_STORIES, cadence === "daily" ? 4 : 8);
    const timeoutMs = boundedTimeout(process.env.EDITORIAL_RUN_TIMEOUT_MS, 30 * 60 * 1000);
    const dryRun = process.env.EDITORIAL_DRY_RUN === "true" || process.env.EDITORIAL_DRY_RUN === "1";
    const constituency = process.env.EDITORIAL_CONSTITUENCY?.trim() || null;
    const metadata = {
      provider: "openrouter",
      model,
      verifyModel,
      cadence,
      promptVersion: EDITORIAL_PROMPT_VERSION,
    };
    let sourceChecks = 0;
    const recheck = async (story: Parameters<typeof runEditorialStory>[0], urls: readonly string[]) => {
      if (sourceChecks >= 2 || Date.now() - startedAt >= timeoutMs) return null;
      sourceChecks += 1;
      let passages = story.passages;
      if (story.origin === "parliamentary" && !passages?.length) {
        const records = await discoverParliamentaryStories(story.occurredOn, story.occurredOn);
        const recovered = records.find((record) => record.storyKey === story.storyKey);
        if (!recovered) return {};
        passages = recovered.passages;
      }
      const domains = editorialResearchDomains();
      const pages = await fetchEvidencePages(urls, domains, { limit: 12 });
      addOfficialPassages(pages, passages, domains, story.subject);
      return fingerprintEvidencePages(pages);
    };

    if (!dryRun) {
      for (let count = 0; count < 2; count += 1) {
        if (Date.now() - startedAt >= timeoutMs) break;
        const request = await claimEditorialRevision(database);
        if (!request) break;
        try {
          let candidate = request.candidate;
          // Legacy parliamentary posts need the official outcome again, never inferred from prose.
          if (!candidate || candidate.origin === "parliamentary") {
            const start = new Date(`${request.periodStart}T00:00:00Z`);
            start.setUTCDate(start.getUTCDate() - 7);
            const records = await discoverParliamentaryStories(start.toISOString().slice(0, 10), request.periodEnd);
            const recovered = records.find((story) => story.storyKey === request.storyKey);
            if (recovered) {
              const combine = (left: typeof recovered.primaryUrls, right: typeof recovered.primaryUrls) =>
                [...new Map([...left, ...right].map((source) => [normalizeEditorialUrl(source.url), source])).values()];
              candidate = { ...recovered, primaryUrls: combine(recovered.primaryUrls, candidate?.primaryUrls ?? []),
                reportingUrls: combine(recovered.reportingUrls, candidate?.reportingUrls ?? []),
                participants: [...recovered.participants, ...(candidate?.participants.filter((person) => person.participation === "reported") ?? [])] };
            } else throw new Error("The original parliamentary event could not be recovered from the official API.");
          }
          if (!candidate) throw new Error("The original event could not be recovered. Review its official record before requesting a revision.");
          candidate = { ...candidate, participants: await resolveEditorialParticipants(candidate.participants, database) };
          const generated = await runEditorialStory(candidate, { start: request.periodStart, end: request.periodEnd },
            { revisionReason: request.reason, previousArticle: request.content });
          const valid = await saveEditorialRevisionDraft(request, candidate, generated, database);
          console.log(JSON.stringify({ event: "editorial.revision", requestId: request.id, outcome: valid ? "needs_review" : "failed" }));
        } catch (error) {
          await failEditorialRevision(request, error instanceof Error ? error.message : "Revision generation failed", database);
        }
      }
      await reconsiderPublishedEditorialStories(await listEditorialRefreshCandidates(database), database, recheck);
    }

    const metrics = await runEditorialBatch({
      period,
      maxStories,
      timeoutMs: Math.max(1, timeoutMs - (Date.now() - startedAt)),
      dryRun,
      discoverParliamentary: (window) => discoverParliamentaryStories(window.start, window.end),
      discoverNational: (edition) => discoverNationalPoliticalStories(edition),
      publishedStoryKeys: async () => new Set(await listPublishedEditorialStoryKeys(database)),
      reconsiderPublished: (stories) => reconsiderPublishedEditorialStories(stories, database, recheck),
      recentlySuppressedStoryKeys: async () => new Set(await listRecentlySuppressedEditorialStoryKeys(3, database)),
      repeatedSubjects: async (subjects) => new Set(await listRecentEditorialSubjects(subjects, database)),
      constituencyNames: async () => constituency ? listConstituencyTdNames(constituency, database) : null,
      existingSlugs: async () => new Set(await listEditorialSlugs(database)),
      acquire: async (story) => startEditorialRun(story, period.start, period.end, metadata, database),
      generate: async (story) => runEditorialStory({ ...story, participants: await resolveEditorialParticipants(story.participants, database) }, period),
      publish: async (runId, story, output, slug, generation) => {
        await publishEditorialPost(
          runId,
          output as EditorialFinal,
          slug,
          { ...metadata, ...generation },
          story,
          database,
        );
        // Tell Bing/IndexNow engines immediately; failure never blocks publishing.
        const siteUrl = indexNowSiteUrl();
        const indexed = await submitIndexNow([`${siteUrl}/news/${slug}`, `${siteUrl}/news`, `${siteUrl}/news-sitemap.xml`]);
        console.log(JSON.stringify({ event: "editorial.indexnow", slug, ...indexed }));
      },
      finish: async (runId, status, error, payload) => {
        await finishEditorialRun(runId, status, payload, error, database);
      },
    });
    return { published: metrics.published, skipped: metrics.published === 0 && metrics.selected === 0 };
  } finally {
    await closeDatabase();
  }
}

function boundedCount(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(Math.floor(parsed), 30));
}

function boundedTimeout(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(30_000, Math.min(parsed, 2 * 60 * 60 * 1000)) : fallback;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runEditorialWorker().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
