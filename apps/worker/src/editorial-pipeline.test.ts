import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeEditorialUrl, type EditorialStoryCandidate } from "@daildex/shared";
const state = vi.hoisted(() => ({ outputs: [] as unknown[], prompts: [] as string[] }));
vi.mock("./editorial-openrouter", () => ({ createEditorialModel: () => ({ modelId: "openai/gpt-6-luna", model: {} }), searchEditorialWeb: vi.fn() }));
vi.mock("ai", async (importOriginal) => ({ ...await importOriginal<typeof import("ai")>(), ToolLoopAgent: class {
  async generate({ prompt }: { prompt: string }) {
    state.prompts.push(prompt);
    return { output: state.outputs.shift(), steps: [{}], usage: { inputTokens: 10, outputTokens: 20 } };
  }
} }));
import { groundResearchBrief, runEditorialStory } from "./editorial-generate";

const official = "https://oireachtas.ie/record";
const quote = "The harbour transport proposal was agreed after the minister explained its funding and implementation timetable.";
const story: EditorialStoryCandidate = { storyKey: "fixture", origin: "parliamentary", kind: "debate", subject: "Harbour transport proposal",
  normalizedSubject: "harbour transport proposal", occurredOn: "2026-09-30", sourceKey: "fixture", outcome: null,
  primaryUrls: [{ url: official, publisher: "Oireachtas", kind: "official" }],
  reportingUrls: ["https://rte.ie/record", "https://irishtimes.com/record"].map((url) => ({ url, publisher: "Reporter", kind: "reporting" })),
  participants: [], discoveredFrom: [], score: 0 };
const brief = { facts: [{ facet: "event" as const, text: "The proposal was agreed.", sourceUrl: official, excerpt: quote }], missingFacets: [], followUpQueries: ["Find the confirmed harbour timetable"] };
const article = { title: "Harbour transport proposal agreed", description: "The proposal was agreed.", period: { start: "2026-09-28", end: "2026-09-30" },
  sections: [{ heading: "The decision", paragraphs: ["The proposal was agreed."], sourceUrls: [official] }],
  sources: [{ url: official, title: "Record", publisher: "Oireachtas", kind: "official", excerpt: quote }],
  disclosure: "Based on the official record.", verification: { passed: true, issues: [], checkedAt: "2026-09-30T18:00:00Z", checks: [] } };

describe("research-to-article workflow", () => {
  beforeEach(() => { state.outputs.length = 0; state.prompts.length = 0; });
  it("keeps an official quotation attached to its speaker in every model pass", async () => {
    state.outputs.push({ ...brief, followUpQueries: [] }, article, article);
    const fetchImpl: typeof fetch = async () => new Response(quote.repeat(5), { headers: { "content-type": "text/plain" } });
    await runEditorialStory({ ...story, passages: [{ url: official, text: quote, speaker: "Example Minister", role: "speech" }] }, article.period,
      { fetch: fetchImpl, search: async () => [] });
    expect(state.prompts).toHaveLength(3);
    expect(state.prompts.every((prompt) => prompt.includes('"speaker":"Example Minister"') && prompt.includes(quote))).toBe(true);
  });
  it("researches gaps despite existing source counts and supplies fresh evidence to the checker", async () => {
    const extra = "The harbour transport implementation timetable begins in January after funding approval.";
    state.outputs.push(brief, { ...brief, facts: [...brief.facts, { facet: "next_step", text: "Implementation begins in January.", sourceUrl: "https://gov.ie/timetable", excerpt: extra }], followUpQueries: [] }, article, article);
    const search = vi.fn(async () => [{ url: "https://gov.ie/timetable", title: "Timetable" }]);
    const fetchImpl: typeof fetch = async (input) => new Response((String(input).includes("timetable") ? extra : quote).repeat(5), { headers: { "content-type": "text/plain" } });
    const result = await runEditorialStory(story, article.period, { fetch: fetchImpl, search });
    expect(search).toHaveBeenCalledTimes(1);
    expect(result.passes.map((pass) => pass.name)).toEqual(["research_brief", "research_expanded", "write", "verify"]);
    expect(state.prompts.at(-1)).toContain(extra);
    expect(result.output.format).toBe("brief");
    expect(result.researchBrief.facts).toHaveLength(2);
  });
  it("does not call the writer when no evidence can be read", async () => {
    const search = vi.fn(async () => []);
    await expect(runEditorialStory(story, article.period, { fetch: async () => new Response("Subscribe", { headers: { "content-type": "text/plain" } }), search })).rejects.toThrow("No source pages");
    expect(state.prompts).toHaveLength(0);
  });
  it("removes invented brief excerpts before choosing article depth", () => {
    const grounded = groundResearchBrief({ ...brief, facts: [...brief.facts, { ...brief.facts[0], facet: "impact", text: "Invented benefit", excerpt: "A benefit that is absent from the actual official record." }] }, new Map([[normalizeEditorialUrl(official), quote]]));
    expect(grounded.facts).toHaveLength(1);
    expect(grounded.missingFacets).toContain("impact");
  });
});
