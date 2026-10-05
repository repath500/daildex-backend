import type { EditorialFinal } from "./editorial";
import { validateEditorialFinal, normalizeEditorialUrl, type EditorialStoryCandidate } from "./editorial-national";
import { evaluateEditorialQuality } from "./editorial-quality";

// Synthetic civic records for deterministic regression evaluation, never publication.
const url = "https://oireachtas.ie/audit/harbour-transport";
const paragraphs = [
  "The Dáil agreed a motion on the Harbour transport route on Wednesday. The motion calls for the Minister for Transport to publish a timetable for restoring the service and to report on the funding needed. Agreement to the motion does not itself provide that funding or set a date for buses to return.",
  "The proposal concerns the service connecting Harbour with the regional hospital. Deputies discussed the difficulties faced by passengers who use the route for appointments and work. The minister said that the department would examine the proposal with the transport authority before deciding how it could be delivered. Those remarks describe a planned examination, rather than a confirmed service change.",
  "The official record distinguishes the motion from an amendment considered earlier in the sitting. Each question had its own division. Readers should therefore refer to the result for the final motion when assessing whether the Dáil agreed to the request. The amendment result describes a separate decision on the wording placed before members.",
  "The next step identified in the debate is the department's examination of the route. The record gives no commencement date for a restored service. Passengers can follow the department's response to establish whether funding and an implementation timetable are subsequently confirmed. Any later decision will need to be checked against the published record and linked to this initial request.",
];
const post: EditorialFinal = { title: "Dáil agrees Harbour transport motion", format: "brief", description: "The Dáil agreed a motion asking the transport department to examine the Harbour route.",
  period: { start: "2026-09-28", end: "2026-09-30" }, sections: [{ heading: "The Harbour decision", purpose: "event", paragraphs, sourceUrls: [url] }],
  sources: [{ url, title: "Harbour transport debate", publisher: "Houses of the Oireachtas", kind: "official", excerpt: paragraphs[0] }],
  disclosure: "Based on the official parliamentary record.", verification: { passed: true, issues: [], checkedAt: "2026-09-30T18:00:00Z", checks: ["record"] } };
const story: EditorialStoryCandidate = { storyKey: "benchmark", origin: "parliamentary", kind: "debate", subject: "Harbour transport", normalizedSubject: "harbour transport",
  occurredOn: "2026-09-30", sourceKey: "benchmark", outcome: null, primaryUrls: [{ url, publisher: "Houses of the Oireachtas", kind: "official" }], reportingUrls: [],
  participants: [], discoveredFrom: [], score: 0, publicationTier: 2 };
type Case = { id: string; expectedValid: boolean; post: EditorialFinal; pages?: Map<string, string>; observed?: Set<string> };
const clone = () => structuredClone(post);
const change = (id: string, mutate: (article: EditorialFinal) => void): Case => { const article = clone(); mutate(article); return { id, expectedValid: false, post: article }; };
export const editorialBenchmarkCases: Case[] = [
  { id: "supported-civic-brief", expectedValid: true, post },
  change("one-sentence-summary", (p) => { p.sections[0].paragraphs = ["The Harbour transport motion was agreed."]; }),
  change("repeated-paragraph-padding", (p) => { p.sections[0].paragraphs = [paragraphs[0], paragraphs[0], paragraphs[0]]; }),
  change("thin-standard-article", (p) => { p.format = "article"; }),
  change("thin-explainer", (p) => { p.format = "explainer"; }),
  { id: "all-page-reads-failed", expectedValid: false, post: clone(), pages: new Map() },
  change("missing-source-excerpt", (p) => { delete p.sources[0].excerpt; }),
  change("invented-source-excerpt", (p) => { p.sources[0].excerpt = "The Minister confirmed that the Harbour service will restart tomorrow."; }),
  change("checker-failed", (p) => { p.verification.passed = false; }),
  change("wrong-period", (p) => { p.period.end = "2026-10-01"; }),
  change("wrong-event", (p) => { p.title = "Hospital investment announced"; p.description = "New hospital funding announced."; }),
  change("process-language-leak", (p) => { p.sections[0].paragraphs[0] += " The supplied evidence bundle records this decision."; }),
  change("generic-roundup", (p) => { p.title = "Weekly Harbour transport roundup"; }),
  change("missing-section-source", (p) => { p.sections[0].sourceUrls = ["https://rte.ie/other"]; }),
  change("source-kind-mismatch", (p) => { p.sources[0].kind = "reporting"; }),
  { id: "unobserved-official-url", expectedValid: false, post: clone(), observed: new Set() },
  change("unread-extra-source", (p) => { p.sources.push({ url: "https://rte.ie/other", title: "Other", publisher: "RTÉ", kind: "reporting", excerpt: paragraphs[0] }); }),
  change("wrong-quote-number", (p) => { p.sources[0].excerpt = "The motion calls for funding of €900 million that was approved yesterday."; }),
  change("unsafe-markup", (p) => { p.sections[0].paragraphs[0] += " <script>tracking</script>"; }),
  change("loaded-character-judgement", (p) => { p.sections[0].paragraphs[0] += " The minister betrayed passengers."; }),
];

export function runEditorialBenchmark() {
  return editorialBenchmarkCases.map((test) => {
    const result = validateEditorialFinal({ story, output: test.post, periodStart: post.period.start, periodEnd: post.period.end,
      observedUrls: test.observed ?? new Set([url, "https://rte.ie/other"]),
      fetchedPages: test.pages ?? new Map([[normalizeEditorialUrl(url), paragraphs.join("\n")]]) });
    return { id: test.id, passed: result.valid === test.expectedValid, expectedValid: test.expectedValid, actualValid: result.valid,
      quality: evaluateEditorialQuality(test.post), issues: result.issues };
  });
}
