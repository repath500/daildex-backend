import { EditorialDiscoveryError } from "@daildex/core/editorial/parliamentary";
import {
  EDITORIAL_NATIONAL_DOMAINS,
  EDITORIAL_OFFICIAL_DOMAINS,
  EDITORIAL_STORY_KINDS,
  clusterClassifiedNews,
  editorialEvidenceKindForHost,
  editorialResearchDomains,
  isAllowedEditorialUrl,
  isObviouslyNonPolitical,
  newsClustersToStories,
  normalizeEditorialUrl,
  normalizeEditorialDate,
  type ClassifiedNewsItem,
  type EditorialEvidenceUrl,
  type EditorialStoryCandidate,
  type EditorialStoryKind,
} from "@daildex/shared";
import { isLoopFinished, Output, ToolLoopAgent } from "ai";
import { z } from "zod";
import { createEditorialModel, DISCOVERY_SEARCH_RESULTS, editorialModelError, searchEditorialWeb } from "./editorial-openrouter";

const PUBLISHERS: Record<string, string> = {
  "rte.ie": "RTÉ",
  "irishtimes.com": "The Irish Times",
  "independent.ie": "Irish Independent",
  "thejournal.ie": "The Journal",
  "irishexaminer.com": "Irish Examiner",
  "gov.ie": "Government of Ireland",
  "oireachtas.ie": "Houses of the Oireachtas",
  "electoralcommission.ie": "Electoral Commission",
  "president.ie": "President of Ireland",
  "courts.ie": "Courts Service",
  "cso.ie": "Central Statistics Office",
  "military.ie": "Defence Forces Ireland",
  "europa.eu": "European Union",
};

const classificationSchema = z.object({
  items: z.array(z.object({
    url: z.string(),
    relevant: z.boolean(),
    eventLabel: z.string().nullable(),
    eventDate: z.string().nullable(),
    category: z.enum(EDITORIAL_STORY_KINDS).nullable(),
    actors: z.array(z.string()).max(8),
  })).max(40),
});

const PRIMARY_LOOKUP_CONCURRENCY = 4;
/** Each primary-record lookup is a paid web search, so only the best-covered events get one. */
const MAX_CLUSTERS_PER_RUN = 8;
const PRIMARY_LOOKUP_RESULTS = 3;

/** The classifier sometimes returns the category ("policy_announcement") as the label; fall back to the headline. */
export function usableEventLabel(label: string | null | undefined): string | null {
  const trimmed = label?.trim();
  if (!trimmed) return null;
  if ((EDITORIAL_STORY_KINDS as readonly string[]).includes(trimmed.toLowerCase())) return null;
  if (/^[a-z0-9]+(?:_[a-z0-9]+)+$/i.test(trimmed)) return null;
  return trimmed;
}

export function shortlistNationalClusters(items: ClassifiedNewsItem[], period: { start: string; end: string }, limit = MAX_CLUSTERS_PER_RUN) {
  const fresh = items.filter((item) => {
    const date = normalizeEditorialDate(item.eventDate) ?? normalizeEditorialDate(item.publishedAt);
    return date && date >= period.start && date <= period.end;
  });
  const rank = (cluster: ClassifiedNewsItem[]) => {
    const publishers = new Set(cluster.filter((item) => editorialEvidenceKindForHost(new URL(item.url).hostname) === "reporting")
      .map((item) => new URL(item.url).hostname.replace(/^www\./, "")));
    const official = cluster.some((item) => editorialEvidenceKindForHost(new URL(item.url).hostname) === "official");
    return publishers.size * 10 + (official ? 15 : 0);
  };
  return clusterClassifiedNews(fresh).sort((a, b) => rank(b) - rank(a) || (b[0]?.eventDate ?? "").localeCompare(a[0]?.eventDate ?? ""))
    .slice(0, limit);
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length) },
    async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        const item = items[index];
        if (item !== undefined) results[index] = await mapper(item, index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function publisherFor(url: string, fallback: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return PUBLISHERS[host] ?? fallback;
  } catch {
    return fallback;
  }
}

function modelFor(domains: readonly string[]) {
  try {
    return createEditorialModel(domains);
  } catch (error) {
    throw new EditorialDiscoveryError("national", editorialModelError(error));
  }
}

function candidatesFromSearchPayload(value: unknown, allowed: readonly string[]) {
  const found: Array<{ url: string; publisher: string; publishedAt: string | null; title: string; snippet: string | null }> = [];
  const seen = new Set<string>();
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const record = node as Record<string, unknown>;
    const url = typeof record.url === "string" ? record.url : typeof record.link === "string" ? record.link : null;
    const title = typeof record.title === "string" ? record.title : typeof record.name === "string" ? record.name : null;
    if (url && title && isAllowedEditorialUrl(url, allowed)) {
      try {
        const key = normalizeEditorialUrl(url);
        if (!seen.has(key)) {
          seen.add(key);
          const snippet = typeof record.snippet === "string"
            ? record.snippet
            : typeof record.content === "string"
              ? record.content.slice(0, 400)
              : typeof record.description === "string"
                ? record.description
                : null;
          const publishedAt = typeof record.publishedDate === "string"
            ? record.publishedDate
            : typeof record.published_at === "string"
              ? record.published_at
              : typeof record.date === "string"
                ? record.date
                : null;
          found.push({
            url,
            title,
            publisher: publisherFor(url, typeof record.publisher === "string" ? record.publisher : title),
            publishedAt,
            snippet,
          });
        }
      } catch {
        // Skip malformed result URLs.
      }
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(value);
  return found;
}

async function searchCandidates(period: { start: string; end: string }, domains: readonly string[]) {
  const discoveryQueries = [
    `Search for important Irish Government, Cabinet, public-body, court, election, policy and national political events from ${period.start} through ${period.end}.`,
    `Search for important Ireland-related EU, diplomatic, state visit, international affairs and United Nations events from ${period.start} through ${period.end}. Include meetings hosted by Ireland and decisions that materially affect Ireland.`,
    `Search for important Irish defence, Defence Forces, national security, peacekeeping, cyber security, maritime security and civilian crisis-management events from ${period.start} through ${period.end}.`,
  ];
  // One slow or failed search should not discard the other lanes.
  const settled = await Promise.allSettled(
    discoveryQueries.map((query) => searchEditorialWeb(query, domains, DISCOVERY_SEARCH_RESULTS)),
  );
  const payloads = settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
  if (!payloads.length) {
    const reason = settled.find((result) => result.status === "rejected")?.reason;
    throw reason instanceof Error ? reason : new Error("Every national search failed.");
  }
  for (const result of settled) {
    if (result.status === "rejected") {
      console.error(JSON.stringify({ event: "editorial.search_failed", error: editorialModelError(result.reason).slice(0, 300) }));
    }
  }
  const items = candidatesFromSearchPayload(payloads, domains);
  if (!items.length) throw new EditorialDiscoveryError("national", "National search returned no readable results.");
  return items.slice(0, 40);
}

async function classifyCandidates(items: Array<{ url: string; title: string; snippet: string | null; publisher: string; publishedAt: string | null }>) {
  if (!items.length) return [];
  const { model } = modelFor(editorialResearchDomains());
  const agent = new ToolLoopAgent({
    model,
    instructions: "Classify headlines. Do not decide whether an event is true. Return JSON only.",
    output: Output.object({ schema: classificationSchema }),
    stopWhen: isLoopFinished(),
  });
  const result = await agent.generate({
    prompt: `Classify these candidate headlines.
Include Irish national politics, government, legislation, public policy, major party developments, elections and electoral administration, political institutions, and major public decisions. Also include state and diplomatic meetings, state visits, defence and security, Defence Forces and peacekeeping activity, Ireland-related EU decisions and meetings, foreign affairs, courts, regulators, and major international events where Ireland or the Irish Government has a material role.
Exclude sports, celebrity, local crime unless it is directly part of a national political or public-policy event, lifestyle, entertainment, and unrelated business.
Categories: ${EDITORIAL_STORY_KINDS.join(", ")}.
Use a specific eventLabel that identifies the action and its bill, place, named institution or amount. Two different announcements by the same minister are different events. A broad topic such as "Housing package" is insufficient. Preserve the actual event date; publication dates alone do not establish a new event.
Headlines: ${JSON.stringify(items.map((item) => ({ url: item.url, title: item.title, snippet: item.snippet, publishedAt: item.publishedAt })))}`,
    // Classifying ~40 headlines regularly takes over two minutes on OpenRouter.
    abortSignal: AbortSignal.timeout(300_000),
  });
  const classified = classificationSchema.parse(result.output).items;
  const byUrl = new Map(classified.map((item) => [item.url, item]));
  return items.map((item): ClassifiedNewsItem => {
    const match = byUrl.get(item.url);
    return {
      ...item,
      relevant: match?.relevant ?? false,
      eventLabel: usableEventLabel(match?.eventLabel),
      eventDate: match?.eventDate ?? null,
      category: (match?.category ?? null) as EditorialStoryKind | null,
      actors: match?.actors ?? [],
    };
  }).filter((item) => item.relevant && !isObviouslyNonPolitical(item.title, item.snippet));
}

async function attachPrimary(cluster: ClassifiedNewsItem[]): Promise<EditorialEvidenceUrl[]> {
  const existing = cluster.flatMap((item) => {
    const kind = editorialEvidenceKindForHost(new URL(item.url).hostname);
    return kind === "official" ? [{ url: item.url, publisher: item.publisher, kind }] : [];
  });
  if (existing.length) return existing;
  const label = cluster[0]?.eventLabel || cluster[0]?.title || "";
  const domains = [...EDITORIAL_OFFICIAL_DOMAINS];
  const annotations = await searchEditorialWeb(
    `Find the primary official record for this Ireland-related political or government event: ${label}. Prefer gov.ie, the Oireachtas, the Electoral Commission, courts, CSO, President.ie, Defence Forces Ireland, the Irish EU Presidency, the Council of the EU, or another relevant EU or UN institution.`,
    domains,
    PRIMARY_LOOKUP_RESULTS,
  );
  return candidatesFromSearchPayload(annotations, domains).flatMap((item) => {
    const kind = editorialEvidenceKindForHost(new URL(item.url).hostname);
    if (kind !== "official") return [];
    return [{ url: item.url, publisher: item.publisher, kind }];
  });
}

export async function discoverNationalPoliticalStories(period: { start: string; end: string }): Promise<{
  candidates: EditorialStoryCandidate[];
  clusters: number;
}> {
  try {
    const raw = await searchCandidates(period, [...new Set([...EDITORIAL_OFFICIAL_DOMAINS, ...EDITORIAL_NATIONAL_DOMAINS])]);
    const classified = await classifyCandidates(raw.filter((item) => !isObviouslyNonPolitical(item.title, item.snippet)));
    // Events covered by the most outlets are the likeliest to be real news; look up records for those only.
    const clusters = shortlistNationalClusters(classified, period);
    const primary = await mapWithConcurrency(clusters, PRIMARY_LOOKUP_CONCURRENCY, async (cluster) => {
      try {
        return await attachPrimary(cluster);
      } catch (error) {
        console.error(JSON.stringify({
          event: "editorial.primary_lookup_failed",
          subject: cluster[0]?.eventLabel || cluster[0]?.title || "",
          error: editorialModelError(error).slice(0, 300),
        }));
        return [];
      }
    });
    return {
      candidates: newsClustersToStories(clusters, primary),
      clusters: clusters.length,
    };
  } catch (error) {
    if (error instanceof EditorialDiscoveryError) throw error;
    throw new EditorialDiscoveryError("national", editorialModelError(error));
  }
}
