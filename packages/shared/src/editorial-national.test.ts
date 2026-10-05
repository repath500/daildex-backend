import { describe, expect, it } from "vitest";
import {
  applyEvidencePolicies,
  EDITORIAL_STORY_KINDS,
  clusterClassifiedNews,
  editorialNewsSlug,
  editorialStoryKey,
  editorialSubjectAppearsInArticle,
  evaluateEditorialLease,
  excerptAppearsInPage,
  voteTotalsNotInRecord,
  isRejectedEditorialTitle,
  mergeEditorialStoryCandidates,
  newsClustersToStories,
  normalizeEditorialSubject,
  normalizeEditorialUrl,
  rankEditorialStories,
  resolveEditorialPeriod,
  scoreEditorialStory,
  validateEditorialFinal,
  type ClassifiedNewsItem,
  type EditorialStoryCandidate,
} from "./editorial-national";

const official = "https://www.oireachtas.ie/en/debates/vote/dail/33/2026-09-16/1";
const rte = "https://www.rte.ie/news/politics/2026/0916/housing-bill/";
const times = "https://www.irishtimes.com/politics/2026/09/16/housing-bill/";

function story(overrides: Partial<EditorialStoryCandidate> = {}): EditorialStoryCandidate {
  return {
    storyKey: "abc123",
    origin: "parliamentary",
    kind: "vote",
    subject: "Residential Tenancies Bill 2026",
    normalizedSubject: "residential tenancies bill 2026",
    occurredOn: "2026-09-16",
    sourceKey: "vote-1",
    outcome: "Carried",
    primaryUrls: [{ url: official, publisher: "Houses of the Oireachtas", kind: "official" }],
    reportingUrls: [],
    participants: [
      { name: "Mary Murphy", party: "Example", participation: "Tá" },
      { name: "John Smith", party: "Example", participation: "Níl" },
    ],
    discoveredFrom: [{ type: "oireachtas", publisher: "Houses of the Oireachtas", url: official }],
    score: 0,
    publicationTier: 2,
    ...overrides,
  };
}

function article(overrides: Record<string, unknown> = {}) {
  return {
    title: "Residential Tenancies Bill passes Dáil vote",
    description: "The Residential Tenancies Bill was carried in the Dáil on 16 September 2026.",
    period: { start: "2026-09-14", end: "2026-09-20" },
    sections: [{
      heading: "What happened",
      paragraphs: ["The Dáil carried the Residential Tenancies Bill."],
      sourceUrls: [official],
    }],
    sources: [{
      url: official,
      title: "Division",
      publisher: "Houses of the Oireachtas",
      kind: "official",
    }],
    disclosure: "DáilDex summarises official records and linked reporting.",
    verification: {
      passed: true,
      issues: [],
      checkedAt: "2026-09-22T08:00:00.000Z",
      checks: ["records"],
    },
    ...overrides,
  };
}

function classified(overrides: Partial<ClassifiedNewsItem>): ClassifiedNewsItem {
  return {
    url: rte,
    publisher: "RTÉ",
    publishedAt: "2026-09-16",
    title: "Cabinet announces €800m housing package",
    snippet: null,
    relevant: true,
    eventLabel: "Cabinet approves €800m housing package",
    eventDate: "2026-09-16",
    category: "government_announcement",
    actors: [],
    ...overrides,
  };
}

describe("editorial identity", () => {
  it("models diplomatic, defence and state events as first-class news", () => {
    expect(EDITORIAL_STORY_KINDS).toEqual(expect.arrayContaining([
      "diplomatic_meeting",
      "defence_security",
      "state_visit",
      "international_affairs",
    ]));
  });

  it("gives the same story key to the same subject and date", () => {
    const left = editorialStoryKey("vote", normalizeEditorialSubject("Residential Tenancies Bill 2026"), "2026-09-16");
    const right = editorialStoryKey("vote", normalizeEditorialSubject("  RESIDENTIAL  TENANCIES BILL 2026 "), "2026-09-16");
    expect(left).toBe(right);
    expect(left).toHaveLength(16);
  });

  it("changes the story key when the date changes", () => {
    const subject = normalizeEditorialSubject("Residential Tenancies Bill 2026");
    expect(editorialStoryKey("vote", subject, "2026-09-16")).not.toBe(editorialStoryKey("vote", subject, "2026-09-17"));
  });

  it("normalises whitespace and capitalisation without stemming", () => {
    expect(normalizeEditorialSubject("  Residential  Tenancies Bill 2026 ")).toBe("residential tenancies bill 2026");
    expect(normalizeEditorialSubject("RESIDENTIAL TENANCIES BILL 2026")).toBe("residential tenancies bill 2026");
  });
});

describe("editorial ranking", () => {
  it("scores a carried vote from its base and a capped unique participant bonus", () => {
    const scored = scoreEditorialStory(story({
      participants: Array.from({ length: 12 }, (_, index) => ({
        name: index < 3 ? "Mary Murphy" : `TD ${index}`,
        party: null,
        participation: "Tá",
      })),
    }), new Set());
    expect(scored.components.baseVote).toBe(20);
    expect(scored.components.participantBonus).toBe(0);
    expect(scored.score).toBe(20);
  });

  it("applies a 30-day repetition penalty without treating it as identity", () => {
    const scored = scoreEditorialStory(story(), new Set(["residential tenancies bill 2026"]));
    expect(scored.components.repeatPenalty).toBe(-40);
    expect(scored.score).toBe(20 - 40);
  });

  it("sorts equal scores by date and then story key", () => {
    const ranked = rankEditorialStories([
      story({ storyKey: "b", occurredOn: "2026-09-16", outcome: null, kind: "vote" }),
      story({ storyKey: "a", occurredOn: "2026-09-16", outcome: null, kind: "vote" }),
      story({ storyKey: "c", occurredOn: "2026-09-17", outcome: null, kind: "vote" }),
    ]);
    expect(ranked.map((item) => item.storyKey)).toEqual(["c", "a", "b"]);
  });
});

describe("national evidence and clustering", () => {
  it("clusters three publishers covering one housing package", () => {
    const clusters = clusterClassifiedNews([
      classified({}),
      classified({
        url: times,
        publisher: "The Irish Times",
        title: "Government agrees €800m housing measures",
        eventLabel: "Cabinet approves €800m housing package",
      }),
      classified({
        url: "https://www.independent.ie/irish-news/housing-package-2026",
        publisher: "Irish Independent",
        title: "New housing package agreed following Cabinet meeting",
        eventLabel: "Cabinet approves €800m housing package",
      }),
    ]);
    expect(clusters).toHaveLength(1);
  });

  it("keeps unrelated political events apart", () => {
    const clusters = clusterClassifiedNews([
      classified({ title: "Dáil passes criminal justice bill", eventLabel: "Criminal justice bill", url: rte }),
      classified({
        title: "Minister for Health announces hospital investment",
        eventLabel: "Hospital investment",
        url: times,
        publisher: "The Irish Times",
      }),
    ]);
    expect(clusters).toHaveLength(2);
  });

  it("does not join different announcements just because their amount and year match", () => {
    const clusters = clusterClassifiedNews([
      classified({ title: "Cabinet approves €800m housing package in 2026", eventLabel: "Housing investment", url: rte }),
      classified({ title: "Cabinet approves €800m health package in 2026", eventLabel: "Health investment", url: times }),
    ]);
    expect(clusters).toHaveLength(2);
  });

  it("discards a clearly non-political candidate", () => {
    const clusters = clusterClassifiedNews([
      classified({ title: "Premier League title race reaches Dublin", eventLabel: "Premier League", relevant: true }),
      classified({ title: "Celebrity wedding exclusive", relevant: false, eventLabel: null }),
    ]);
    expect(clusters).toHaveLength(0);
  });

  it("applies publication tiers", () => {
    const officialStory = newsClustersToStories([[
      classified({ url: "https://www.gov.ie/en/press-release/housing-package/", publisher: "Government of Ireland", title: "Government announces housing package" }),
      classified({}),
    ]])[0];
    expect(officialStory).toBeDefined();
    const policies = applyEvidencePolicies([
      officialStory!,
      story(),
      story({
        origin: "reported",
        kind: "investigation",
        primaryUrls: [],
        publicationTier: null,
        reportingUrls: [
          { url: rte, publisher: "RTÉ", kind: "reporting" },
          { url: times, publisher: "The Irish Times", kind: "reporting" },
        ],
      }),
      story({
        origin: "reported",
        kind: "political_development",
        primaryUrls: [],
        reportingUrls: [{ url: rte, publisher: "RTÉ", kind: "reporting" }],
      }),
      story({
        origin: "party",
        kind: "party_development",
        primaryUrls: [],
        reportingUrls: [],
        participants: [],
      }),
    ]);
    expect(policies.eligible.map((item) => item.publicationTier)).toEqual([1, 2, 3]);
    expect(policies.deferred).toHaveLength(2);
  });

  it("merges a media report into the parliamentary event", () => {
    const media = newsClustersToStories([[
      classified({
        title: "Residential Tenancies Bill passes Dáil vote",
        eventLabel: "Residential Tenancies Bill passes",
        category: "vote",
      }),
    ]])[0];
    expect(media).toBeDefined();
    const merged = mergeEditorialStoryCandidates([story()], [media!]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.origin).toBe("parliamentary");
    expect(merged[0]?.reportingUrls.map((item) => item.publisher)).toContain("RTÉ");
    expect(merged[0]?.primaryUrls[0]?.url).toBe(official);
  });

  it("does not merge unrelated bills merely because they share the word bill", () => {
    const media = newsClustersToStories([[
      classified({
        title: "Health Bill passes Dáil vote",
        eventLabel: "Health Bill passes",
        category: "vote",
      }),
    ]])[0];
    expect(media).toBeDefined();
    const merged = mergeEditorialStoryCandidates([story()], [media!]);
    expect(merged).toHaveLength(2);
  });

  it("keeps reporting separate when two official divisions are equally plausible matches", () => {
    const media = story({ origin: "reported", primaryUrls: [], reportingUrls: [{ url: rte, publisher: "RTÉ", kind: "reporting" }] });
    const merged = mergeEditorialStoryCandidates([story({ storyKey: "first-division" }), story({ storyKey: "second-division" })], [media]);
    expect(merged).toHaveLength(3);
    expect(merged.slice(0, 2).every((candidate) => !candidate.reportingUrls.length)).toBe(true);
  });
});

describe("editorial validation", () => {
  const observed = new Set([official, rte, "https://reddit.com/r/ireland/post"]);

  it("accepts a parliamentary article that does not name every voting TD", () => {
    const result = validateEditorialFinal({
      story: story(),
      output: article({ sources: [{url: official, title: "Record", publisher: "Houses of the Oireachtas", kind: "official", excerpt: "The Residential Tenancies Bill was carried in the Dáil."}] }),
      fetchedPages: new Map([[normalizeEditorialUrl(official), "The Residential Tenancies Bill was carried in the Dáil."]]),
      observedUrls: observed,
      periodStart: "2026-09-14",
      periodEnd: "2026-09-20",
    });
    expect(result.valid).toBe(true);
  });

  it("rejects an article that talks about its own evidence bundle", () => {
    const result = validateEditorialFinal({
      story: story(),
      output: article({
        sections: [{
          heading: "What happened",
          paragraphs: ["The Dáil carried the Residential Tenancies Bill. No news reporting was supplied in the evidence bundle."],
          sourceUrls: [official],
        }],
      }),
      observedUrls: observed,
      periodStart: "2026-09-14",
      periodEnd: "2026-09-20",
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.issues).toContain("The article describes the drafting process instead of the story.");
  });

  it("rejects a parliamentary article without its exact official URL", () => {
    const result = validateEditorialFinal({
      story: story(),
      output: article({
        sources: [{ url: "https://www.oireachtas.ie/en/debates/", title: "Debates", publisher: "Houses of the Oireachtas", kind: "official" }],
        sections: [{ heading: "What happened", paragraphs: ["The Residential Tenancies Bill was carried."], sourceUrls: ["https://www.oireachtas.ie/en/debates/"] }],
      }),
      observedUrls: new Set(["https://www.oireachtas.ie/en/debates/"]),
      periodStart: "2026-09-14",
      periodEnd: "2026-09-20",
    });
    expect(result.valid).toBe(false);
  });

  it("rejects news-only sources for a parliamentary story", () => {
    const result = validateEditorialFinal({
      story: story(),
      output: article({
        sources: [{ url: rte, title: "RTÉ", publisher: "RTÉ", kind: "reporting" }],
        sections: [{ heading: "What happened", paragraphs: ["The Residential Tenancies Bill was carried."], sourceUrls: [rte] }],
      }),
      observedUrls: observed,
      periodStart: "2026-09-14",
      periodEnd: "2026-09-20",
    });
    expect(result.valid).toBe(false);
  });

  it("rejects generic and person-only titles", () => {
    expect(isRejectedEditorialTitle("Weekly Brief", [])).toBe(true);
    expect(isRejectedEditorialTitle("Micheál Martin", [{ name: "Micheál Martin" }])).toBe(true);
    expect(editorialSubjectAppearsInArticle("Residential Tenancies Bill 2026", "Weekly Brief", "A big week in Irish politics")).toBe(false);
  });

  it("rejects invented, unapproved, uncited, and unobserved URLs", () => {
    const invented = validateEditorialFinal({
      story: story(),
      output: article({
        sources: [
          { url: official, title: "Division", publisher: "Houses of the Oireachtas", kind: "official" },
          { url: "https://www.rte.ie/news/politics/fake-url", title: "RTÉ", publisher: "RTÉ", kind: "reporting" },
        ],
      }),
      observedUrls: new Set([official]),
      periodStart: "2026-09-14",
      periodEnd: "2026-09-20",
    });
    const reddit = validateEditorialFinal({
      story: story(),
      output: article({
        sources: [
          { url: official, title: "Division", publisher: "Houses of the Oireachtas", kind: "official" },
          { url: "https://reddit.com/r/ireland/post", title: "Reddit", publisher: "Reddit", kind: "reporting" },
        ],
      }),
      observedUrls: observed,
      periodStart: "2026-09-14",
      periodEnd: "2026-09-20",
    });
    const missingCitation = validateEditorialFinal({
      story: story(),
      output: article({
        sections: [{ heading: "What happened", paragraphs: ["The Residential Tenancies Bill was carried."], sourceUrls: [rte] }],
      }),
      observedUrls: observed,
      periodStart: "2026-09-14",
      periodEnd: "2026-09-20",
    });
    expect(invented.valid).toBe(false);
    expect(reddit.valid).toBe(false);
    expect(missingCitation.valid).toBe(false);
  });

  it("treats tracking parameters and trailing slashes as the same URL", () => {
    expect(normalizeEditorialUrl("https://www.RTE.ie/news/politics/story/?utm_source=x"))
      .toBe(normalizeEditorialUrl("https://rte.ie/news/politics/story"));
  });
});

describe("editorial leases and slugs", () => {
  const hour = 60 * 60 * 1000;

  it("skips a published story and a fresh running lease", () => {
    expect(evaluateEditorialLease({ status: "published", startedAt: 0 }, hour)).toBe("skip");
    expect(evaluateEditorialLease({ status: "running", startedAt: 0 }, 20 * 60 * 1000)).toBe("skip");
  });

  it("reacquires a lease that has been running for three hours", () => {
    expect(evaluateEditorialLease({ status: "running", startedAt: 0 }, 3 * hour)).toBe("acquire");
  });

  it("lets only the first of two workers acquire", () => {
    let state: { status: "running"; startedAt: number } | null = null;
    const now = 1_000;
    const first = evaluateEditorialLease(state, now);
    if (first === "acquire") state = { status: "running", startedAt: now };
    const second = evaluateEditorialLease(state, now + 60_000);
    expect(first).toBe("acquire");
    expect(second).toBe("skip");
  });

  it("adds the story key when a slug collides", () => {
    const slug = editorialNewsSlug("Residential Tenancies Bill", "2026-09-16", "abcdef123456", new Set(["residential-tenancies-bill-2026-09-16"]));
    expect(slug).toContain("abcdef");
    expect(slug.length).toBeLessThanOrEqual(80);
  });
});

describe("daily editorial period", () => {
  it("covers today and the two previous days", () => {
    expect(resolveEditorialPeriod(new Date("2026-09-26T07:05:00Z"), undefined, "daily")).toEqual({
      start: "2026-09-24",
      end: "2026-09-26",
    });
  });

  it("keeps the weekly default and explicit overrides", () => {
    expect(resolveEditorialPeriod(new Date("2026-09-23T06:00:00Z"))).toEqual({ start: "2026-09-14", end: "2026-09-20" });
    expect(resolveEditorialPeriod(new Date(), { start: "2026-01-01", end: "2026-01-02" }, "daily")).toEqual({
      start: "2026-01-01",
      end: "2026-01-02",
    });
  });
});

describe("source excerpt grounding", () => {
  const page = "The Dáil voted on Wednesday. The Residential Tenancies Bill was carried by 81 votes to 64 after a two-hour debate.";

  it("fails closed when every source read fails", () => {
    const result = validateEditorialFinal({ story: story(), output: article(), observedUrls: new Set([official]),
      periodStart: "2026-09-14", periodEnd: "2026-09-20", fetchedPages: new Map() });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.issues.some((issue) => issue.includes("No source page"))).toBe(true);
  });

  it("matches quotes despite curly quotes, case and spacing", () => {
    expect(excerptAppearsInPage("the residential tenancies bill was  carried by 81 votes to 64", page)).toBe(true);
    expect(excerptAppearsInPage("The Dáil voted on Wednesday… carried by 81 votes to 64 after a two-hour debate", page)).toBe(true);
  });

  it("rejects altered or too-short quotes", () => {
    expect(excerptAppearsInPage("The Residential Tenancies Bill was carried by 90 votes to 64", page)).toBe(false);
    expect(excerptAppearsInPage("Bill was carried", page)).toBe(false);
  });

  it("suppresses an article whose quote is not on the page it read", () => {
    const base = article();
    const input = {
      story: story(),
      observedUrls: new Set([official, rte]),
      periodStart: "2026-09-14",
      periodEnd: "2026-09-20",
      fetchedPages: new Map([[normalizeEditorialUrl(official), page]]),
    };
    const quoted = (excerpt: string) => ({
      ...base,
      sources: base.sources.map((source: { url: string }) =>
        source.url === official ? { ...source, excerpt } : source),
    });
    expect(validateEditorialFinal({ ...input, output: quoted("The Residential Tenancies Bill was carried by 81 votes to 64") }).valid).toBe(true);
    expect(validateEditorialFinal({ ...input, output: quoted("The Residential Tenancies Bill was defeated by 81 votes to 64") }).valid).toBe(false);
    expect(validateEditorialFinal({ ...input, output: base }).valid).toBe(false);
  });
});

describe("event identity safeguards", () => {
  it("keeps different decisions by the same minister on the same broad topic separate", () => {
    expect(clusterClassifiedNews([
      classified({ title: "Minister announces housing rent rules", eventLabel: "Rent rules", actors: ["Example Minister"] }),
      classified({ url: times, title: "Minister announces housing construction grants", eventLabel: "Construction grants", actors: ["Example Minister"] }),
    ])).toHaveLength(2);
  });
  it("keeps incompatible event categories separate", () => {
    expect(clusterClassifiedNews([classified({}), classified({ url: times, category: "court_decision" })])).toHaveLength(2);
  });
  it("ranks a substantive policy decision above a voting roll with no reporting", () => {
    const vote = story({ participants: Array.from({ length: 140 }, (_, i) => ({ name: `Voter ${i}`, party: null, participation: "Tá" })) });
    const policy = story({ kind: "government_announcement", origin: "government", participants: [], reportingUrls: [{ url: rte, publisher: "RTÉ", kind: "reporting" }] });
    expect(scoreEditorialStory(policy, new Set()).score).toBeGreaterThan(scoreEditorialStory(vote, new Set()).score);
  });
});

describe("vote totals", () => {
  const outcome = "Amendment put: Carried (Tá 81, Níl 73); Question put: \"That the motion, as amended, be agreed to\": Carried (Tá 80, Níl 74)";
  const post = (paragraph: string) => ({ ...article(), sections: [{ heading: "Vote", paragraphs: [paragraph], sourceUrls: [official] }] }) as never;

  it("accepts totals that match the record, in digits or words", () => {
    expect(voteTotalsNotInRecord(post("The amendment was carried by 81 votes to 73. On the final question, 80 voted Tá and Níl: 74."), outcome)).toEqual([]);
    expect(voteTotalsNotInRecord(post("Eighty-one deputies voted Tá."), outcome)).toEqual([]);
  });

  it("flags invented or merged totals", () => {
    expect(voteTotalsNotInRecord(post("Ninety-three deputies voted Tá and 67 voted Níl."), outcome).sort()).toEqual(["67", "93"]);
  });

  it("ignores words that are not numbers", () => {
    expect(voteTotalsNotInRecord(post("Those who voted Tá included the Minister."), outcome)).toEqual([]);
  });
});
