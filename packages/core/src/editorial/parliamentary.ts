import {
  fetchOireachtasDebates,
  fetchOireachtasQuestions,
  fetchOireachtasVotes,
  type NormalizedParliamentaryRecord,
} from "../oireachtas/index";
import {
  EDITORIAL_IGNORED_SUBJECTS,
  canonicalDisplaySubject,
  editorialStoryKey,
  normalizeEditorialDate,
  normalizeEditorialSubject,
  normalizeEditorialUrl,
  type EditorialStoryCandidate,
  type EditorialStoryKind,
} from "@daildex/shared";

export class EditorialDiscoveryError extends Error {
  readonly category: string;

  constructor(category: string, message: string) {
    super(message);
    this.name = "EditorialDiscoveryError";
    this.category = category;
  }
}

function dedupeParticipants(records: NormalizedParliamentaryRecord[]): EditorialStoryCandidate["participants"] {
  const seen = new Set<string>();
  const participants: EditorialStoryCandidate["participants"] = [];
  for (const record of records) {
    for (const participant of record.participants) {
      const name = participant.name.trim();
      if (!name) continue;
      const identity = [
        normalizeEditorialSubject(name),
        normalizeEditorialSubject(participant.party ?? ""),
        normalizeEditorialSubject(participant.participation),
      ].join("|");
      if (seen.has(identity)) continue;
      seen.add(identity);
      participants.push({ name, party: participant.party, participation: participant.participation, ...(participant.memberCode ? { memberCode: participant.memberCode } : {}) });
    }
  }
  return participants.sort((left, right) =>
    left.name.localeCompare(right.name, "en-IE")
    || (left.party ?? "").localeCompare(right.party ?? "", "en-IE")
    || left.participation.localeCompare(right.participation, "en-IE"));
}

export function groupParliamentaryRecords(records: readonly NormalizedParliamentaryRecord[]): EditorialStoryCandidate[] {
  const buckets = new Map<string, NormalizedParliamentaryRecord[]>();
  for (const record of records) {
    const normalizedSubject = normalizeEditorialSubject(record.subject);
    const occurredOn = normalizeEditorialDate(record.date);
    if (!normalizedSubject || !occurredOn) continue;
    if (EDITORIAL_IGNORED_SUBJECTS.has(normalizedSubject)) continue;
    // "An tOrd Gnó - Order of Business" and similar bilingual procedural items.
    if (/\border of business\b/.test(normalizedSubject)) continue;
    const key = `${record.kind}\u0000${normalizedSubject}\u0000${occurredOn}`;
    const list = buckets.get(key) ?? [];
    list.push(record);
    buckets.set(key, list);
  }

  const stories: EditorialStoryCandidate[] = [];
  for (const [key, group] of buckets) {
    const [kind, normalizedSubject, occurredOn] = key.split("\u0000") as [EditorialStoryKind, string, string];
    const subject = canonicalDisplaySubject(group.map((record) => record.subject));
    const urls: string[] = [];
    const seenUrls = new Set<string>();
    for (const record of group) {
      let normalized = record.url;
      try {
        normalized = normalizeEditorialUrl(record.url);
      } catch {
        continue;
      }
      if (seenUrls.has(normalized)) continue;
      seenUrls.add(normalized);
      urls.push(record.url);
    }
    if (!urls.length) continue;
    stories.push({
      storyKey: editorialStoryKey(kind, normalizedSubject, occurredOn ?? ""),
      origin: "parliamentary",
      kind,
      subject,
      normalizedSubject,
      occurredOn: occurredOn ?? "",
      sourceKey: group.find((record) => record.sourceKey)?.sourceKey ?? null,
      // Every division in the debate, each with its own official totals.
      outcome: [...new Set(group.map((record) => record.outcome).filter((value): value is string => Boolean(value)))].join("; ") || null,
      primaryUrls: urls.map((url) => ({
        url,
        publisher: "Houses of the Oireachtas",
        kind: "official" as const,
      })),
      reportingUrls: [],
      participants: dedupeParticipants(group),
      passages: group.flatMap((record) => record.passages ?? []).slice(0, 80),
      discoveredFrom: urls.map((url) => ({
        type: "oireachtas" as const,
        publisher: "Houses of the Oireachtas",
        url,
      })),
      score: 0,
      publicationTier: 2,
    });
  }
  return stories.sort((left, right) => left.storyKey.localeCompare(right.storyKey));
}

export async function discoverParliamentaryStories(
  periodStart: string,
  periodEnd: string,
  fetchImpl?: typeof fetch,
): Promise<EditorialStoryCandidate[]> {
  const [votes, questions, debates] = await Promise.all([
    fetchOireachtasVotes(periodStart, periodEnd, fetchImpl),
    fetchOireachtasQuestions(periodStart, periodEnd, fetchImpl),
    fetchOireachtasDebates(periodStart, periodEnd, fetchImpl),
  ]);
  const failed = [
    ["votes", votes],
    ["questions", questions],
    ["debates", debates],
  ].find((entry) => entry[1] && typeof entry[1] === "object" && "ok" in entry[1] && entry[1].ok === false);
  if (failed) {
    const category = String(failed[0]);
    const result = failed[1] as { error?: string };
    throw new EditorialDiscoveryError(category, result.error ?? `${category} discovery failed`);
  }
  if (!votes.ok || !questions.ok || !debates.ok) {
    throw new EditorialDiscoveryError("parliamentary", "Parliamentary discovery failed");
  }
  const debatesBySection = new Map(debates.items.filter((record) => record.sectionKey).map((record) => [`${record.date}|${record.sectionKey}`, record]));
  const contextualVotes = votes.items.map((vote) => {
    const debate = vote.sectionKey ? debatesBySection.get(`${vote.date}|${vote.sectionKey}`) : null;
    // Use the API-supplied readable document and speeches for this exact division's section.
    return debate ? { ...vote, url: debate.url, passages: debate.passages } : vote;
  });
  return groupParliamentaryRecords([...contextualVotes, ...questions.items, ...debates.items]);
}
