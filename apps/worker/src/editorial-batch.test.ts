import { describe, expect, it } from "vitest";
import { EditorialDiscoveryError } from "@daildex/core/editorial/parliamentary";
import { normalizeEditorialUrl, type EditorialStoryCandidate } from "@daildex/shared";
import { runEditorialBatch, type EditorialBatchDependencies } from "./editorial-batch";

const quote = "The official parliamentary record establishes the event and its result.";
const official = "https://www.oireachtas.ie/en/debates/vote/dail/33/2026-09-16/1";
const pages = new Map([[normalizeEditorialUrl(official), quote]]);

function story(subject: string, storyKey: string): EditorialStoryCandidate {
  return {
    storyKey,
    origin: "parliamentary",
    kind: "vote",
    subject,
    normalizedSubject: subject.toLocaleLowerCase("en-IE"),
    occurredOn: "2026-09-16",
    sourceKey: storyKey,
    outcome: "Carried",
    primaryUrls: [{ url: official, publisher: "Houses of the Oireachtas", kind: "official" }],
    reportingUrls: [],
    participants: [{ name: "Mary Murphy", party: null, participation: "Tá" }],
    discoveredFrom: [{ type: "oireachtas", publisher: "Houses of the Oireachtas", url: official }],
    score: 0,
    publicationTier: 2,
  };
}

function article(subject: string) {
  return {
    title: `${subject} passes Dáil vote`,
    description: `The ${subject} was carried in a Dáil division.`,
    period: { start: "2026-09-14", end: "2026-09-20" },
    sections: [{
      heading: "What happened",
      paragraphs: [`Deputies carried the ${subject}.`],
      sourceUrls: [official],
    }],
    sources: [{ url: official, title: "Division", publisher: "Houses of the Oireachtas", kind: "official", excerpt: quote }],
    disclosure: "DáilDex summarises the official record.",
    verification: { passed: true, issues: [], checkedAt: "2026-09-22T08:00:00.000Z", checks: ["record"] },
  };
}

function dependencies(overrides: Partial<EditorialBatchDependencies> = {}): EditorialBatchDependencies {
  return {
    period: { start: "2026-09-14", end: "2026-09-20" },
    maxStories: 8,
    timeoutMs: 30 * 60 * 1000,
    dryRun: false,
    now: () => 0,
    log: () => undefined,
    discoverParliamentary: async () => [story("Residential Tenancies Bill", "aaaa"), story("Health Bill", "bbbb")],
    discoverNational: async () => ({ candidates: [], clusters: 0 }),
    publishedStoryKeys: async () => new Set(),
    repeatedSubjects: async () => new Set(),
    constituencyNames: async () => null,
    existingSlugs: async () => new Set(),
    acquire: async () => ({ id: "run", acquired: true }),
    generate: async (candidate) => ({ output: article(candidate.subject), observedUrls: new Set([official]), fetchedPages: pages }),
    publish: async () => undefined,
    finish: async () => undefined,
    ...overrides,
  };
}

describe("editorial batch", () => {
  it("does not use two publication slots for a debate and vote on the same subject and day", async () => {
    const generated: string[] = [];
    const metrics = await runEditorialBatch(dependencies({
      discoverParliamentary: async () => [story("Transport Bill", "vote"), { ...story("Transport Bill", "debate"), kind: "debate" }],
      generate: async (candidate) => { generated.push(candidate.storyKey); return { output: article(candidate.subject), observedUrls: new Set([official]), fetchedPages: pages }; },
    }));
    expect(generated).toEqual(["vote"]);
    expect(metrics.published).toBe(1);
  });
  it("uses backfill for matching without publishing old or future events as fresh news", async () => {
    let generated = 0;
    const metrics = await runEditorialBatch(dependencies({
      discoverParliamentary: async () => [{ ...story("Old motion", "old"), occurredOn: "2026-09-13" },
        { ...story("Future motion", "future"), occurredOn: "2026-09-21" }],
      generate: async (candidate) => { generated += 1; return { output: article(candidate.subject), observedUrls: new Set([official]), fetchedPages: pages }; },
    }));
    expect(metrics.selected).toBe(0);
    expect(generated).toBe(0);
  });
  it("still runs the second story when the first is suppressed", async () => {
    const generated: string[] = [];
    const metrics = await runEditorialBatch(dependencies({
      generate: async (candidate) => {
        generated.push(candidate.storyKey);
        if (candidate.storyKey === "aaaa") {
          return { output: { title: "Weekly Brief" }, observedUrls: new Set([official]), fetchedPages: pages };
        }
        return { output: article(candidate.subject), observedUrls: new Set([official]), fetchedPages: pages };
      },
    }));
    expect(generated).toEqual(["aaaa", "bbbb"]);
    expect(metrics.suppressed).toBe(1);
    expect(metrics.published).toBe(1);
  });

  it("still runs the second story when the first provider call throws", async () => {
    const generated: string[] = [];
    const metrics = await runEditorialBatch(dependencies({
      generate: async (candidate) => {
        generated.push(candidate.storyKey);
        if (candidate.storyKey === "aaaa") throw new Error("provider timeout");
        return { output: article(candidate.subject), observedUrls: new Set([official]), fetchedPages: pages };
      },
    }));
    expect(generated).toEqual(["aaaa", "bbbb"]);
    expect(metrics.failed).toBe(1);
    expect(metrics.published).toBe(1);
  });

  it("does not start another story after the batch timeout", async () => {
    let now = 0;
    const generated: string[] = [];
    await runEditorialBatch(dependencies({
      timeoutMs: 1_000,
      now: () => now,
      generate: async (candidate) => {
        generated.push(candidate.storyKey);
        now = 2_000;
        return { output: article(candidate.subject), observedUrls: new Set([official]), fetchedPages: pages };
      },
    }));
    expect(generated).toEqual(["aaaa"]);
  });

  it("does not call the model again for a story that is already leased", async () => {
    let calls = 0;
    await runEditorialBatch(dependencies({
      discoverParliamentary: async () => [story("Residential Tenancies Bill", "aaaa")],
      acquire: async () => ({ id: "run", acquired: false }),
      generate: async (candidate) => {
        calls += 1;
        return { output: article(candidate.subject), observedUrls: new Set([official]), fetchedPages: pages };
      },
    }));
    expect(calls).toBe(0);
  });

  it("fills the generation limit with lower-ranked stories when an earlier lease is unavailable", async () => {
    const generated: string[] = [];
    const metrics = await runEditorialBatch(dependencies({
      maxStories: 2,
      discoverParliamentary: async () => [
        story("Residential Tenancies Bill", "aaaa"),
        story("Health Bill", "bbbb"),
        story("Finance Bill", "cccc"),
      ],
      acquire: async (candidate) => ({ id: candidate.storyKey, acquired: candidate.storyKey !== "aaaa" }),
      generate: async (candidate) => {
        generated.push(candidate.storyKey);
        return { output: article(candidate.subject), observedUrls: new Set([official]), fetchedPages: pages };
      },
    }));
    expect(generated).toEqual(["bbbb", "cccc"]);
    expect(metrics.selected).toBe(2);
    expect(metrics.processed).toBe(2);
    expect(metrics.leaseSkipped).toBe(1);
  });

  it("forwards per-pass generation telemetry to publication", async () => {
    let publishedGeneration: Record<string, unknown> | null = null;
    await runEditorialBatch(dependencies({
      discoverParliamentary: async () => [story("Residential Tenancies Bill", "aaaa")],
      generate: async (candidate) => ({
        output: article(candidate.subject),
        observedUrls: new Set([official]),
        fetchedPages: pages,
        model: "editorial-model",
        promptVersion: "research+verify",
        passes: [{ name: "research", steps: 2, inputTokens: 100, outputTokens: 50 }],
      }),
      publish: async (_runId, _story, _output, _slug, generation) => {
        publishedGeneration = generation;
      },
    }));
    expect(publishedGeneration).toMatchObject({
      model: "editorial-model",
      promptVersion: "research+verify",
      passes: [{ name: "research", steps: 2, inputTokens: 100, outputTokens: 50 }],
    });
  });

  it("makes no model calls when parliamentary discovery fails", async () => {
    let calls = 0;
    const batch = runEditorialBatch(dependencies({
      discoverParliamentary: async () => {
        throw new EditorialDiscoveryError("votes", "Oireachtas /votes returned HTTP 500");
      },
      generate: async (candidate) => {
        calls += 1;
        return { output: article(candidate.subject), observedUrls: new Set() };
      },
    }));
    await expect(batch).rejects.toBeInstanceOf(EditorialDiscoveryError);
    expect(calls).toBe(0);
  });

  it("skips stories the validator suppressed recently", async () => {
    const generated: string[] = [];
    const metrics = await runEditorialBatch(dependencies({
      recentlySuppressedStoryKeys: async () => new Set(["aaaa"]),
      generate: async (candidate) => {
        generated.push(candidate.storyKey);
        return { output: article(candidate.subject), observedUrls: new Set([official]), fetchedPages: pages };
      },
    }));
    expect(generated).toEqual(["bbbb"]);
    expect(metrics.published).toBe(1);
  });

  it("checks quotes against the pages the generator read", async () => {
    const metrics = await runEditorialBatch(dependencies({
      discoverParliamentary: async () => [story("Residential Tenancies Bill", "aaaa")],
      generate: async (candidate) => ({
        output: article(candidate.subject),
        observedUrls: new Set([official]),
        fetchedPages: new Map([[official, "A page that the article never quotes from, long enough to count as read."]]),
      }),
    }));
    expect(metrics.suppressed).toBe(1);
    expect(metrics.published).toBe(0);
  });

  it("publishes parliamentary stories when national discovery fails", async () => {
    const events: Array<Record<string, unknown>> = [];
    const metrics = await runEditorialBatch(dependencies({
      log: (event) => events.push(event),
      discoverNational: async () => {
        throw new EditorialDiscoveryError("national", "The operation was aborted due to timeout");
      },
    }));
    expect(metrics.published).toBe(2);
    expect(events).toContainEqual(expect.objectContaining({ event: "editorial.discovery_failed", category: "national", continuing: true }));
  });
});
