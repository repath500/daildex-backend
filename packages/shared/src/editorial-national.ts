import { createHash } from "node:crypto";
import { evaluateEditorialQuality } from "./editorial-quality";
import {
  EDITORIAL_NATIONAL_DOMAINS,
  EDITORIAL_OFFICIAL_DOMAINS,
  EDITORIAL_ORIGINATOR_DOMAINS,
  editorialFinalSchema,
  isAllowedEditorialHost,
  isAllowedEditorialUrl,
  type EditorialFinal,
} from "./editorial";

export type EditorialStoryOrigin =
  | "parliamentary"
  | "government"
  | "public_body"
  | "party"
  | "judicial"
  | "eu"
  | "reported";

export const EDITORIAL_STORY_KINDS = [
  "vote",
  "question",
  "debate",
  "legislation",
  "committee",
  "government_announcement",
  "policy_announcement",
  "appointment",
  "resignation",
  "party_development",
  "court_decision",
  "eu_development",
  "diplomatic_meeting",
  "defence_security",
  "state_visit",
  "international_affairs",
  "poll",
  "investigation",
  "political_development",
] as const;

export type EditorialStoryKind = (typeof EDITORIAL_STORY_KINDS)[number];

export type EditorialEvidenceKind = "official" | "reporting" | "originator";

export interface EditorialEvidenceUrl {
  url: string;
  publisher: string;
  kind: EditorialEvidenceKind;
}

export interface EditorialStoryCandidate {
  storyKey: string;
  origin: EditorialStoryOrigin;
  kind: EditorialStoryKind;
  subject: string;
  normalizedSubject: string;
  occurredOn: string;
  sourceKey: string | null;
  outcome: string | null;
  primaryUrls: EditorialEvidenceUrl[];
  reportingUrls: EditorialEvidenceUrl[];
  participants: {
    name: string;
    memberCode?: string;
    party: string | null;
    participation: string;
  }[];
  discoveredFrom: {
    type: "oireachtas" | "news" | "official";
    publisher: string;
    url: string;
  }[];
  score: number;
  publicationTier?: 1 | 2 | 3 | null;
  scoreComponents?: Record<string, number>;
  passages?: Array<{ url: string; text: string; speaker?: string; role: "question" | "answer" | "speech" }>;
}

export const EDITORIAL_IGNORED_SUBJECTS = new Set([
  "order of business",
  "questions",
  "commencement matters",
  "vote",
]);

const STOPWORDS = new Set([
  "the", "a", "an", "of", "and", "or", "to", "for", "in", "on", "at", "by", "with",
  "from", "after", "as", "is", "are", "was", "were", "be", "that", "this", "it",
  "its", "new", "says", "said", "over", "into", "following", "will", "has", "have",
  "had", "ireland", "irish", "their", "than", "then", "also", "not", "but",
]);

const TRACKING_PARAMS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id",
  "fbclid", "gclid", "mc_cid", "mc_eid",
]);

const GENERIC_TITLE = /weekly|roundup|your tds|what is a td/i;
const UNSAFE_MARKUP = /<(?:script|iframe|style)\b/i;
// Newsroom plumbing that leaked into reader-facing prose.
const PROCESS_LANGUAGE = /\b(evidence bundle|supplied evidence|source pages|search results|this draft)\b/i;
const CHARACTER_JUDGEMENT = /\b(betrayed|lied|liar|hypocrite|corrupt|exposed|caught out)\b/i;
const SUBJECT_PREFIX = /^(?:question\s+no\.?\s*\d+\s*[-—:]\s*|motion\s+re:\s*|statements\s+on:\s*)/i;
const NON_POLITICAL = /\b(premier league|all-ireland final|box office|celebrity wedding|transfer window|recipe)\b/i;
const POLITICAL = /\b(dáil|dail|seanad|government|minister|oireachtas|cabinet|bill|election|tánaiste|tanaiste|taoiseach|court|resign|fine gael|fianna|sinn féin|sinn fein|eu|tds?|defen[cs]e|military|security|diplomatic|presidency|state visit|foreign affairs|united nations|peacekeeping)\b/i;
const CROSS_LANE_GENERIC_TOKENS = new Set([
  "bill", "motion", "vote", "dail", "dáil", "seanad", "oireachtas", "government", "minister", "committee",
]);

const CONSTITUENCY_TITLES = new Set([
  "carlow-kilkenny", "cavan-monaghan", "clare", "cork east", "cork north-central",
  "cork north-west", "cork south-central", "cork south-west", "donegal",
  "dublin bay north", "dublin bay south", "dublin central", "dublin fingal",
  "dublin mid-west", "dublin north-west", "dublin rathdown", "dublin south-central",
  "dublin south-west", "dublin west", "dun laoghaire", "galway east", "galway west",
  "kerry", "kildare north", "kildare south", "laois", "limerick city", "limerick county",
  "longford-westmeath", "louth", "mayo", "meath east", "meath west", "offaly",
  "roscommon-galway", "sligo-leitrim", "tipperary", "waterford", "wexford", "wicklow",
]);

export function editorialApprovedDomains(): string[] {
  return [
    ...EDITORIAL_OFFICIAL_DOMAINS,
    ...EDITORIAL_NATIONAL_DOMAINS,
    ...EDITORIAL_ORIGINATOR_DOMAINS,
  ];
}

export function editorialResearchDomains(): string[] {
  return [...EDITORIAL_OFFICIAL_DOMAINS, ...EDITORIAL_NATIONAL_DOMAINS];
}

export function normalizeEditorialSubject(input: string): string {
  return input
    .normalize("NFKC")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2013\u2014\u2212]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[\s!"#$%&'()*+,./:;<=>?@[\\\]^_`{|}~]+|[\s!"#$%&'()*+,./:;<=>?@[\\\]^_`{|}~]+$/g, "")
    .toLocaleLowerCase("en-IE");
}

export function normalizeEditorialDate(input: string | null | undefined): string | null {
  if (!input) return null;
  const match = input.match(/\d{4}-\d{2}-\d{2}/);
  const date = match?.[0];
  if (!date) return null;
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : null;
}

export function canonicalDisplaySubject(labels: readonly string[]): string {
  const cleaned = labels.map((label) => label.trim()).filter(Boolean);
  if (!cleaned.length) return "";
  const counts = new Map<string, number>();
  for (const label of cleaned) counts.set(label, (counts.get(label) ?? 0) + 1);
  const ranked = [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], "en-IE"));
  return ranked[0]?.[0] ?? "";
}

export function editorialStoryKey(kind: string, normalizedSubject: string, occurredOn: string): string {
  return createHash("sha256").update([kind, normalizedSubject, occurredOn].join("|")).digest("hex").slice(0, 16);
}

export function normalizeEditorialUrl(input: string): string {
  const url = new URL(input);
  url.hostname = url.hostname.toLocaleLowerCase("en-IE").replace(/^www\./, "");
  url.hash = "";
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  const kept = [...url.searchParams.entries()]
    .filter(([key]) => !TRACKING_PARAMS.has(key.toLocaleLowerCase("en-IE")))
    .sort((left, right) => left[0].localeCompare(right[0]) || left[1].localeCompare(right[1]));
  url.search = "";
  for (const [key, value] of kept) url.searchParams.append(key, value);
  return url.toString();
}

export function editorialEvidenceKindForHost(hostname: string): EditorialEvidenceKind | null {
  if (isAllowedEditorialHost(hostname, EDITORIAL_OFFICIAL_DOMAINS)) return "official";
  if (isAllowedEditorialHost(hostname, EDITORIAL_NATIONAL_DOMAINS)) return "reporting";
  if (isAllowedEditorialHost(hostname, EDITORIAL_ORIGINATOR_DOMAINS)) return "originator";
  return null;
}

export function significantTokens(input: string): string[] {
  return normalizeEditorialSubject(input)
    .split(/[^a-z0-9áéíóúäëïöü]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4 && !STOPWORDS.has(token));
}

export function isObviouslyNonPolitical(title: string, snippet?: string | null): boolean {
  const text = `${title} ${snippet ?? ""}`;
  if (POLITICAL.test(text)) return false;
  return NON_POLITICAL.test(text);
}

export type ClassifiedNewsItem = {
  url: string;
  publisher: string;
  publishedAt: string | null;
  title: string;
  snippet: string | null;
  relevant: boolean;
  eventLabel: string | null;
  eventDate: string | null;
  category: EditorialStoryKind | null;
  actors: string[];
};

function itemDate(item: ClassifiedNewsItem): string | null {
  return normalizeEditorialDate(item.eventDate) ?? normalizeEditorialDate(item.publishedAt);
}

function daysApart(left: string | null, right: string | null): number | null {
  if (!left || !right) return null;
  const a = Date.parse(`${left}T00:00:00Z`);
  const b = Date.parse(`${right}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.abs(a - b) / 86_400_000;
}

function shouldCluster(left: ClassifiedNewsItem, right: ClassifiedNewsItem): boolean {
  const gap = daysApart(itemDate(left), itemDate(right));
  if (gap !== null && gap > 1) return false;
  if (left.category && right.category && left.category !== right.category) return false;
  const leftTokens = new Set(significantTokens(`${left.eventLabel ?? ""} ${left.title}`));
  const rightTokens = significantTokens(`${right.eventLabel ?? ""} ${right.title}`);
  const shared = rightTokens.filter((token) => leftTokens.has(token));
  const leftNumbers = new Set(`${left.title} ${left.eventLabel ?? ""}`.match(/\d+/g) ?? []);
  const rightNumbers = `${right.title} ${right.eventLabel ?? ""}`.match(/\d+/g) ?? [];
  const sharedNumber = rightNumbers.some((value) => leftNumbers.has(value));
  const uniqueShared = new Set(shared);
  const generic = new Set([...CROSS_LANE_GENERIC_TOKENS, "announces", "announced", "agrees", "agreed", "approves", "approved", "housing", "health", "policy", "cabinet", "grants", "funding", "package", "investment", "measures", "scheme", "plan", "decision", "announcement"]);
  const distinctive = [...uniqueShared].filter((token) => !generic.has(token) && !/^\d+[a-z]*$/i.test(token));
  const labelTokens = significantTokens(left.eventLabel ?? "");
  const specificLabel = labelTokens.length >= 2 && (labelTokens.some((token) => !generic.has(token)) || /\d/.test(left.eventLabel ?? ""));
  const sameLabel = Boolean(specificLabel && left.eventLabel && right.eventLabel && normalizeEditorialSubject(left.eventLabel) === normalizeEditorialSubject(right.eventLabel));
  const sameActor = left.actors.some((actor) => right.actors.some((other) => normalizeEditorialSubject(actor) === normalizeEditorialSubject(other)));
  return sameLabel || (uniqueShared.size >= 2 && distinctive.length >= 2 && (sameActor || uniqueShared.size >= 3)) || (distinctive.length >= 1 && sharedNumber);
}

export function clusterClassifiedNews(items: readonly ClassifiedNewsItem[]): ClassifiedNewsItem[][] {
  const relevant = items.filter((item) => item.relevant && !isObviouslyNonPolitical(item.title, item.snippet))
    .sort((left, right) => left.url.localeCompare(right.url));
  const groups: ClassifiedNewsItem[][] = [];
  for (const item of relevant) {
    // Complete-link matching prevents a bridging headline from joining distinct events.
    const group = groups.find((cluster) => cluster.every((other) => shouldCluster(item, other)));
    if (group) group.push(item);
    else groups.push([item]);
  }
  return groups;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function dedupeParticipants(participants: EditorialStoryCandidate["participants"]): EditorialStoryCandidate["participants"] {
  const seen = new Set<string>();
  const unique: EditorialStoryCandidate["participants"] = [];
  for (const participant of participants) {
    const name = participant.name.trim();
    if (!name) continue;
    const identity = [
      normalizeEditorialSubject(name),
      normalizeEditorialSubject(participant.party ?? ""),
      normalizeEditorialSubject(participant.participation),
    ].join("|");
    if (seen.has(identity)) continue;
    seen.add(identity);
    unique.push({ name, party: participant.party, participation: participant.participation, ...(participant.memberCode ? { memberCode: participant.memberCode } : {}) });
  }
  return unique.sort((left, right) =>
    left.name.localeCompare(right.name, "en-IE")
    || (left.party ?? "").localeCompare(right.party ?? "", "en-IE")
    || left.participation.localeCompare(right.participation, "en-IE"));
}

function dedupeEvidence(urls: EditorialEvidenceUrl[]): EditorialEvidenceUrl[] {
  const seen = new Set<string>();
  const unique: EditorialEvidenceUrl[] = [];
  for (const item of urls) {
    let key = item.url;
    try {
      key = normalizeEditorialUrl(item.url);
    } catch {
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique;
}

function hostIs(hostname: string, domain: string): boolean {
  return isAllowedEditorialHost(hostname, [domain]);
}

function originForEvidence(urls: EditorialEvidenceUrl[], fallback: EditorialStoryOrigin): EditorialStoryOrigin {
  const hosts = urls.map((item) => hostOf(item.url)).filter((host): host is string => Boolean(host));
  if (hosts.some((host) => hostIs(host, "oireachtas.ie"))) return "parliamentary";
  if (hosts.some((host) => hostIs(host, "gov.ie"))) return "government";
  if (hosts.some((host) => hostIs(host, "courts.ie"))) return "judicial";
  if (hosts.some((host) => hostIs(host, "europa.eu"))) return "eu";
  if (hosts.some((host) => hostIs(host, "electoralcommission.ie") || hostIs(host, "cso.ie"))) return "public_body";
  if (urls.some((item) => item.kind === "originator") && !urls.some((item) => item.kind === "official")) return "party";
  return fallback;
}

export function newsClustersToStories(
  clusters: ClassifiedNewsItem[][],
  primaryByCluster: EditorialEvidenceUrl[][] = [],
): EditorialStoryCandidate[] {
  return clusters.flatMap((cluster, index) => {
    const labels = cluster.map((item) => item.eventLabel?.trim() || item.title.trim()).filter(Boolean);
    const subject = canonicalDisplaySubject(labels);
    const normalizedSubject = normalizeEditorialSubject(subject);
    const dates = cluster.map(itemDate).filter((date): date is string => Boolean(date));
    const occurredOn = canonicalDisplaySubject(dates);
    if (!subject || !normalizedSubject || !occurredOn) return [];
    const evidence = cluster.flatMap((item): EditorialEvidenceUrl[] => {
      const kind = editorialEvidenceKindForHost(hostOf(item.url) ?? "") ?? "reporting";
      return [{ url: item.url, publisher: item.publisher, kind }];
    });
    const primary = dedupeEvidence([
      ...(primaryByCluster[index] ?? []),
      ...evidence.filter((item) => item.kind === "official"),
    ]);
    const reporting = dedupeEvidence(evidence.filter((item) => item.kind === "reporting"));
    const categories = cluster.map((item) => item.category).filter((kind): kind is EditorialStoryKind => Boolean(kind));
    const kind = (canonicalDisplaySubject(categories) || "political_development") as EditorialStoryKind;
    const actors = [...new Set(cluster.flatMap((item) => item.actors.map((actor) => actor.trim()).filter(Boolean)))];
    return [{
      storyKey: editorialStoryKey(kind, normalizedSubject, occurredOn),
      origin: originForEvidence(primary, "reported"),
      kind: EDITORIAL_STORY_KINDS.includes(kind) ? kind : "political_development",
      subject,
      normalizedSubject,
      occurredOn,
      sourceKey: null,
      outcome: null,
      primaryUrls: primary,
      reportingUrls: reporting,
      participants: dedupeParticipants(actors.map((name) => ({ name, party: null, participation: "reported" }))),
      discoveredFrom: cluster.map((item) => ({
        type: (editorialEvidenceKindForHost(hostOf(item.url) ?? "") === "official" ? "official" : "news") as "official" | "news",
        publisher: item.publisher,
        url: item.url,
      })),
      score: 0,
    }];
  });
}

function tokenOverlap(left: string, right: string): { shared: number; ratio: number; tokens: string[] } {
  const leftTokens = new Set(significantTokens(left));
  const rightTokens = [...new Set(significantTokens(right))];
  const shared = rightTokens.filter((token) => leftTokens.has(token));
  const denominator = Math.min(leftTokens.size, rightTokens.length) || 1;
  return { shared: shared.length, ratio: shared.length / denominator, tokens: shared };
}

export function mergeEditorialStoryCandidates(
  parliamentary: readonly EditorialStoryCandidate[],
  external: readonly EditorialStoryCandidate[],
): EditorialStoryCandidate[] {
  const merged = parliamentary.map((story) => ({
    ...story,
    primaryUrls: [...story.primaryUrls],
    reportingUrls: [...story.reportingUrls],
    participants: [...story.participants],
    discoveredFrom: [...story.discoveredFrom],
  }));
  const unmatched: EditorialStoryCandidate[] = [];
  for (const story of external) {
    let bestIndex = -1;
    let bestShared = 0;
    let ambiguous = false;
    merged.forEach((candidate, index) => {
      const gap = daysApart(candidate.occurredOn, story.occurredOn);
      if (gap !== null && gap > 3) return;
      const overlap = tokenOverlap(candidate.normalizedSubject, story.normalizedSubject);
      const distinctive = overlap.tokens.filter((token) => !CROSS_LANE_GENERIC_TOKENS.has(token) && !/^\d+[a-z]*$/i.test(token));
      if (story.kind === "vote" && candidate.kind !== "vote") return;
      if (candidate.kind === "vote" && story.kind !== "vote" && !/\b(pass(?:es|ed)?|carried|defeated|division|vote)\b/i.test(story.subject)) return;
      const sufficientlySimilar = overlap.shared >= 2 && overlap.ratio >= 0.75 && distinctive.length >= 2;
      if (sufficientlySimilar && overlap.shared > bestShared) {
        bestShared = overlap.shared;
        bestIndex = index;
        ambiguous = false;
      } else if (sufficientlySimilar && overlap.shared === bestShared) ambiguous = true;
    });
    const target = !ambiguous && bestIndex >= 0 ? merged[bestIndex] : null;
    if (!target) {
      unmatched.push(story);
      continue;
    }
    target.reportingUrls = dedupeEvidence([...target.reportingUrls, ...story.reportingUrls, ...story.primaryUrls.filter((item) => item.kind === "reporting")]);
    target.primaryUrls = dedupeEvidence([...target.primaryUrls, ...story.primaryUrls.filter((item) => item.kind === "official")]);
    target.participants = dedupeParticipants([...target.participants, ...story.participants]);
    target.discoveredFrom = [...target.discoveredFrom, ...story.discoveredFrom];
  }
  return [...merged, ...unmatched];
}

function reportingPublishers(story: EditorialStoryCandidate): string[] {
  const hosts = new Set<string>();
  for (const item of story.reportingUrls) {
    if (item.kind !== "reporting") continue;
    const host = hostOf(item.url);
    if (host) hosts.add(host.replace(/^www\./, ""));
  }
  return [...hosts].sort();
}

export function applyEvidencePolicies(candidates: readonly EditorialStoryCandidate[]): {
  eligible: EditorialStoryCandidate[];
  deferred: EditorialStoryCandidate[];
} {
  const eligible: EditorialStoryCandidate[] = [];
  const deferred: EditorialStoryCandidate[] = [];
  for (const story of candidates) {
    const official = story.primaryUrls.some((item) => item.kind === "official");
    const publishers = reportingPublishers(story);
    let tier: 1 | 2 | 3 | null = null;
    if (story.origin === "parliamentary" && official) tier = publishers.length ? 1 : 2;
    else if (official && publishers.length >= 1) tier = 1;
    else if (!official && publishers.length >= 2) tier = 3;
    const next = { ...story, publicationTier: tier };
    if (tier) eligible.push(next);
    else deferred.push(next);
  }
  return { eligible, deferred };
}

export function scoreEditorialStory(
  story: EditorialStoryCandidate,
  repeatedSubjects: ReadonlySet<string>,
  referenceDate?: string,
): { score: number; components: Record<string, number> } {
  const components: Record<string, number> = {};
  if (story.kind === "vote") components.baseVote = story.outcome ? 20 : 10;
  else if (story.kind === "question") components.baseQuestion = 15;
  else if (story.kind === "debate") components.baseDebate = 10;
  const uniqueNames = new Set(story.participants.filter((participant) => !/^(?:tá|níl|staon)(?:\s|$)/iu.test(participant.participation))
    .map((participant) => normalizeEditorialSubject(participant.name)).filter(Boolean));
  components.participantBonus = Math.min(6, uniqueNames.size * 2);
  if (["legislation", "government_announcement", "policy_announcement", "court_decision", "eu_development", "investigation"].includes(story.kind)) components.publicDecision = 20;
  if (story.passages?.length) components.substantiveRecord = Math.min(10, story.passages.length * 2);
  if (referenceDate) components.freshness = Math.max(0, 12 - (daysApart(story.occurredOn, referenceDate) ?? 12) * 3);
  if (story.origin !== "parliamentary" && story.primaryUrls.some((item) => item.kind === "official")) {
    components.officialSource = 25;
  }
  const publishers = reportingPublishers(story);
  const rest = publishers.filter((host) => host !== "rte.ie");
  if (publishers.includes("rte.ie")) components.rte = 15;
  if (rest[0]) components.secondPublisher = 10;
  if (rest[1]) components.thirdPublisher = 5;
  const extra = Math.max(0, rest.length - 2);
  if (extra) components.additionalPublisher = Math.min(6, extra * 2);
  if (repeatedSubjects.has(story.normalizedSubject)) components.repeatPenalty = -40;
  const score = Object.values(components).reduce((sum, value) => sum + value, 0);
  return { score, components };
}

export function rankEditorialStories(
  candidates: readonly EditorialStoryCandidate[],
  repeatedSubjects: ReadonlySet<string> = new Set(),
  referenceDate?: string,
): EditorialStoryCandidate[] {
  return candidates
    .map((story) => {
      const scored = scoreEditorialStory(story, repeatedSubjects, referenceDate);
      return { ...story, score: scored.score, scoreComponents: scored.components };
    })
    .sort((left, right) => right.score - left.score || right.occurredOn.localeCompare(left.occurredOn) || left.storyKey.localeCompare(right.storyKey));
}

export function editorialSubjectAppearsInArticle(subject: string, title: string, description: string): boolean {
  const cleaned = subject.replace(SUBJECT_PREFIX, "");
  const tokens = significantTokens(cleaned).filter((token) => token.length >= 5);
  const haystack = normalizeEditorialSubject(`${title} ${description}`);
  if (!tokens.length) return haystack.includes(normalizeEditorialSubject(cleaned));
  const needed = Math.min(2, tokens.length);
  const hits = tokens.filter((token) => haystack.includes(token)).length;
  return hits >= needed;
}

export function isRejectedEditorialTitle(title: string, participants: readonly { name: string }[]): boolean {
  if (GENERIC_TITLE.test(title)) return true;
  const normalized = normalizeEditorialSubject(title).replace(/[–—]/g, "-");
  if (CONSTITUENCY_TITLES.has(normalized)) return true;
  return participants.some((participant) => normalizeEditorialSubject(participant.name) === normalized);
}

export function editorialNewsSlug(subject: string, occurredOn: string, storyKey: string, existing: ReadonlySet<string> = new Set()): string {
  const stem = subject
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-IE")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const dated = `${stem}-${occurredOn}`.replace(/-+/g, "-").replace(/^-|-$/g, "");
  const slug = dated.slice(0, 80).replace(/-$/g, "");
  if (!existing.has(slug)) return slug;
  const suffix = `-${storyKey.slice(0, 6)}`;
  return `${dated.slice(0, Math.max(1, 80 - suffix.length)).replace(/-$/g, "")}${suffix}`;
}

export type EditorialCadence = "daily" | "weekly";

export function resolveEditorialCadence(value?: string | null): EditorialCadence {
  return value?.trim().toLowerCase() === "weekly" ? "weekly" : "daily";
}

/** Days covered by one daily run: today plus the two previous UTC days. */
export const EDITORIAL_DAILY_WINDOW_DAYS = 3;

export function resolveEditorialPeriod(
  now = new Date(),
  override?: { start?: string | null; end?: string | null },
  cadence: EditorialCadence = "weekly",
): { start: string; end: string } {
  const start = override?.start?.trim();
  const end = override?.end?.trim();
  if (start || end) {
    if (!start || !end || !/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
      throw new Error("EDITORIAL_PERIOD_START and EDITORIAL_PERIOD_END must both be YYYY-MM-DD");
    }
    return { start, end };
  }
  if (cadence === "daily") {
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const first = new Date(today);
    first.setUTCDate(first.getUTCDate() - (EDITORIAL_DAILY_WINDOW_DAYS - 1));
    return { start: first.toISOString().slice(0, 10), end: today.toISOString().slice(0, 10) };
  }
  const day = now.getUTCDay();
  const daysSinceMonday = (day + 6) % 7;
  const thisMonday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysSinceMonday));
  const previousMonday = new Date(thisMonday);
  previousMonday.setUTCDate(previousMonday.getUTCDate() - 7);
  const previousSunday = new Date(thisMonday);
  previousSunday.setUTCDate(previousSunday.getUTCDate() - 1);
  return { start: previousMonday.toISOString().slice(0, 10), end: previousSunday.toISOString().slice(0, 10) };
}

export function parliamentaryDiscoveryWindow(
  period: { start: string; end: string },
  backfillDays = 7,
): { start: string; end: string } {
  const start = new Date(`${period.start}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - backfillDays);
  return { start: start.toISOString().slice(0, 10), end: period.end };
}

export type EditorialLeaseState = { status: "running" | "published" | "suppressed" | "failed"; startedAt: number } | null;

/** Mirrors the atomic editorial_runs upsert. Two hours is the live lease. */
export function evaluateEditorialLease(existing: EditorialLeaseState, now: number): "acquire" | "skip" {
  if (!existing) return "acquire";
  if (existing.status === "published") return "skip";
  if (existing.status === "running" && now - existing.startedAt < 2 * 60 * 60 * 1000) return "skip";
  return "acquire";
}

export function storyInvolvesNames(story: EditorialStoryCandidate, names: readonly string[]): boolean {
  const wanted = new Set(names.map((name) => normalizeEditorialSubject(name)));
  return story.participants.some((participant) => wanted.has(normalizeEditorialSubject(participant.name)));
}

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90,
};

function numberFrom(token: string): number | null {
  if (/^\d+$/.test(token)) return Number(token);
  const parts = token.toLowerCase().split(/[-\s]+/);
  if (parts.some((part) => !(part in NUMBER_WORDS))) return null;
  return parts.reduce((sum, part) => sum + NUMBER_WORDS[part], 0);
}

/**
 * Vote totals the article states (for example "81 voted Tá" or "Níl: 73")
 * that do not appear among the official totals supplied with the story.
 */
export function voteTotalsNotInRecord(post: EditorialFinal, outcome: string | null): string[] {
  const official = new Set((outcome ?? "").match(/\d+/g)?.map(Number) ?? []);
  const text = [post.title, post.description, ...post.sections.flatMap((section) => [...section.paragraphs, ...(section.bullets ?? [])])].join(" ");
  // Unicode-aware boundaries: \b does not treat "á" or "í" as word characters.
  const num = String.raw`(\d+|(?:\p{L}+-)?\p{L}+)`;
  const vote = String.raw`(?:tá|níl|staon|in favour|against)(?!\p{L})`;
  const patterns = [
    new RegExp(String.raw`(?<!\p{L})${num}\s+(?:deputies\s+|tds\s+|members\s+)?(?:voted\s+|votes?\s+)?${vote}`, "giu"),
    new RegExp(String.raw`(?<!\p{L})(?:tá|níl|staon)\s*[:(,]?\s*${num}`, "giu"),
    new RegExp(String.raw`(?<!\p{L})by\s+${num}\s+(?:votes\s+)?to\s+${num}`, "giu"),
  ];
  const wrong = new Set<string>();
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      for (const token of match.slice(1)) {
        if (!token) continue;
        const value = numberFrom(token);
        if (value !== null && value > 0 && !official.has(value)) wrong.add(String(value));
      }
    }
  }
  return [...wrong];
}

type ValidationInput = {
  story: EditorialStoryCandidate;
  output: unknown;
  observedUrls: ReadonlySet<string>;
  periodStart: string;
  periodEnd: string;
  /**
   * Plain text of source pages the worker actually fetched, keyed by
   * normalized URL. When present, quoted excerpts are checked against it.
   */
  fetchedPages?: ReadonlyMap<string, string>;
};

/** Loose text form for quote matching: case, quotes, dashes and spacing do not matter. */
export function normalizeEvidenceText(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-IE")
    .replace(/[\u2018\u2019\u201a\u201b\u2032]/g, "'")
    .replace(/[\u201c\u201d\u201e\u2033]/g, "\"")
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[^a-z0-9'"%€£$.,-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * True when every substantive fragment of the excerpt (split on ellipses)
 * appears verbatim in the page text. Fragments under 20 characters are
 * ignored, but at least one fragment must be long enough to check.
 */
export function excerptAppearsInPage(excerpt: string, pageText: string): boolean {
  const haystack = normalizeEvidenceText(pageText);
  const fragments = excerpt
    .split(/\u2026|\.{3}|\[\s*\.\.\.\s*\]/)
    .map((fragment) => normalizeEvidenceText(fragment).replace(/^[.,\s]+|[.,\s]+$/g, ""))
    .filter((fragment) => fragment.length >= 20);
  if (!fragments.length) return false;
  return fragments.every((fragment) => haystack.includes(fragment));
}

export function validateEditorialFinal(
  input: ValidationInput,
): { valid: true; post: EditorialFinal; issues: [] } | { valid: false; issues: string[] } {
  const parsed = editorialFinalSchema.safeParse(input.output);
  if (!parsed.success) return { valid: false, issues: ["The final output did not match the editorial schema."] };
  const post = parsed.data;
  const issues: string[] = [];
  if (post.period.start !== input.periodStart || post.period.end !== input.periodEnd) {
    issues.push("The final article period does not match the requested editorial period.");
  }
  if (!editorialSubjectAppearsInArticle(input.story.subject, post.title, post.description)) {
    issues.push("The title and description do not represent the candidate subject.");
  }
  if (isRejectedEditorialTitle(post.title, input.story.participants)) {
    issues.push("The title is a generic roundup, a person name, or a constituency name.");
  }
  if (!post.verification.passed) issues.push("Independent verification did not pass.");
  if (input.story.kind === "vote") {
    const wrong = voteTotalsNotInRecord(post, input.story.outcome);
    if (wrong.length) issues.push(`Vote totals not in the official record: ${wrong.join(", ")}`);
  }
  if (UNSAFE_MARKUP.test(JSON.stringify(post))) issues.push("Unsafe HTML was present in the article output.");
  if (CHARACTER_JUDGEMENT.test(JSON.stringify(post))) issues.push("The article contains a character judgement.");
  const readerText = [post.title, post.description, ...post.sections.flatMap((section) => [section.heading, ...section.paragraphs, ...(section.bullets ?? [])])].join(" ");
  if (PROCESS_LANGUAGE.test(readerText)) issues.push("The article describes the drafting process instead of the story.");

  const observed = new Set<string>();
  for (const url of input.observedUrls) {
    try {
      observed.add(normalizeEditorialUrl(url));
    } catch {
      observed.add(url);
    }
  }
  const sourceKeys = new Set<string>();
  let groundedSources = 0;
  const approved = editorialApprovedDomains();
  for (const source of post.sources) {
    let normalized = source.url;
    try {
      normalized = normalizeEditorialUrl(source.url);
    } catch {
      issues.push(`Source URL is not valid: ${source.url}`);
      continue;
    }
    sourceKeys.add(normalized);
    if (!observed.has(normalized)) issues.push(`Source was not observed in research: ${source.url}`);
    if (!isAllowedEditorialUrl(source.url, approved)) issues.push(`Source is outside the editorial allow-list: ${source.url}`);
    const expected = editorialEvidenceKindForHost(new URL(source.url).hostname);
    if (expected && source.kind !== expected) issues.push(`Source kind does not match its host: ${source.url}`);
    const page = input.fetchedPages?.get(normalized);
    if (page !== undefined && source.excerpt) {
      if (excerptAppearsInPage(source.excerpt, page)) groundedSources += 1;
      else issues.push(`Quoted evidence does not appear on the source page: ${source.url}`);
    }
  }
  if (!input.fetchedPages?.size) issues.push("No source page was successfully read. Defer publication until evidence can be read.");
  if (groundedSources === 0) {
    issues.push("No source excerpt could be matched against a page the worker read.");
  }
  for (const source of post.sources) {
    const page = input.fetchedPages?.get(normalizeEditorialUrl(source.url));
    if (!page || !source.excerpt) issues.push(`Source must have readable, quoted evidence: ${source.url}`);
  }
  issues.push(...evaluateEditorialQuality(post).issues);
  for (const section of post.sections) {
    for (const url of section.sourceUrls) {
      let normalized = url;
      try {
        normalized = normalizeEditorialUrl(url);
      } catch {
        issues.push(`Section "${section.heading}" cites an invalid URL.`);
        continue;
      }
      if (!sourceKeys.has(normalized)) issues.push(`Section "${section.heading}" cites a URL missing from sources.`);
    }
  }

  const officialSources = post.sources.filter((source) => source.kind === "official");
  const reportingHosts = new Set(
    post.sources.filter((source) => source.kind === "reporting").map((source) => {
      try {
        return new URL(source.url).hostname.replace(/^www\./, "");
      } catch {
        return "";
      }
    }).filter(Boolean),
  );
  if (input.story.origin === "parliamentary") {
    const primary = new Set(input.story.primaryUrls.map((item) => {
      try {
        return normalizeEditorialUrl(item.url);
      } catch {
        return item.url;
      }
    }));
    if (!officialSources.some((source) => {
      try {
        return primary.has(normalizeEditorialUrl(source.url));
      } catch {
        return false;
      }
    })) {
      issues.push("A parliamentary story must keep one of its exact Oireachtas record URLs.");
    }
  } else if (input.story.publicationTier === 3) {
    if (reportingHosts.size < 2) issues.push("A reporting-only story needs two independent publishers.");
  } else if (!officialSources.length || reportingHosts.size < 1) {
    issues.push("This story needs a primary official source and independent reporting.");
  }

  if (issues.length) return { valid: false, issues: [...new Set(issues)] };
  return { valid: true, issues: [], post };
}

export function parseStoredEditorialContent(value: unknown): EditorialFinal | null {
  const parsed = editorialFinalSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const legacy = value as {
    title?: string;
    description?: string;
    period?: { start?: string; end?: string };
    sections?: EditorialFinal["sections"];
    sources?: Array<{ url: string; title: string; publisher: string; kind: string; publishedAt?: string; excerpt?: string }>;
    disclosure?: string;
    verification?: EditorialFinal["verification"];
  };
  if (!legacy?.title || !legacy.description || !legacy.period?.start || !legacy.sections || !legacy.sources || !legacy.disclosure || !legacy.verification) {
    return null;
  }
  const mapped = editorialFinalSchema.safeParse({
    title: legacy.title,
    description: legacy.description,
    period: legacy.period,
    sections: legacy.sections,
    disclosure: legacy.disclosure,
    verification: legacy.verification,
    sources: legacy.sources.map((source) => ({
      ...source,
      kind: source.kind === "official" ? "official" : source.kind === "originator" ? "originator" : "reporting",
    })),
  });
  return mapped.success ? mapped.data : null;
}
