import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { isLoopFinished, Output, ToolLoopAgent } from "ai";
import { createBudgetUpdate, getBudgetLiveMemory } from "@daildex/core/budget";
import { isRuntimeControlEnabled } from "@daildex/core/operations";
import { closeDatabase, getDatabase } from "@daildex/db";
import {
  EDITORIAL_NATIONAL_DOMAINS,
  EDITORIAL_OFFICIAL_DOMAINS,
  isAllowedEditorialUrl,
  normalizeEditorialUrl,
  resolveEditorialModelId,
} from "@daildex/shared";
import {
  BUDGET_LIVE_SLUG,
  budgetLiveBatchSchema,
  validateBudgetLiveDraft,
} from "@daildex/shared/budget-live";
import { evidencePagesForPrompt, fetchEvidencePages } from "./editorial-evidence";
import { createEditorialModel, editorialModelError, searchEditorialWeb } from "./editorial-openrouter";
import { indexNowSiteUrl, submitIndexNow } from "./indexnow";

/**
 * Budget live worker. Each run searches approved Irish sources for new Budget
 * developments, reads the pages, drafts short updates and stores only drafts
 * whose quotes appear on the pages read and whose figures are all quoted.
 * Drafts wait for review in /admin unless BUDGET_LIVE_AUTOPUBLISH=true.
 */

export const BUDGET_LIVE_DOMAINS = [...EDITORIAL_OFFICIAL_DOMAINS, "revenue.ie", ...EDITORIAL_NATIONAL_DOMAINS];

const QUERIES = [
  "Budget 2027 Ireland measures announced today by Minister Simon Harris",
  "Budget 2027 Ireland spending announced by Minister Jack Chambers",
  "Budget 2027 social welfare State pension and payments changes",
  "Budget 2027 income tax USC tax credits changes",
  "Budget 2027 housing renters first-time buyers measures",
  "Budget 2027 energy fuel allowance carbon tax excise",
  "Budget 2027 reaction opposition parties Dáil",
  "Budget 2027 childcare child benefit students measures",
];

/** Two queries per run, rotating so that every topic is covered over an hour of runs. */
export function budgetLiveQueries(now: Date, perRun = 2): string[] {
  const slot = Math.floor(now.getTime() / (10 * 60 * 1000));
  return Array.from({ length: perRun }, (_, index) => QUERIES[(slot * perRun + index) % QUERIES.length]);
}

function collectUrls(value: unknown, into: Set<string>) {
  if (typeof value === "string") {
    for (const match of value.match(/https?:\/\/[^\s"'<>)\\]+/g) ?? []) {
      const cleaned = match.replace(/[.,]+$/, "");
      if (!isAllowedEditorialUrl(cleaned, BUDGET_LIVE_DOMAINS)) continue;
      try {
        into.add(normalizeEditorialUrl(cleaned));
      } catch {
        // Ignore malformed tool text.
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectUrls(item, into);
    return;
  }
  if (value && typeof value === "object") for (const item of Object.values(value)) collectUrls(item, into);
}

const INSTRUCTIONS = `You write short live updates for DáilDex's Budget 2027 page, a neutral, independent Irish civic site.
Rules:
- Use only the source pages supplied. Never use outside knowledge for facts or figures.
- Write only about Budget 2027 developments that are not already covered by the existing headlines.
- Say clearly whether a measure was announced by the Government, is in the official Budget documents, or is only reported or expected. Attribute reports and reactions by name ("RTÉ reports", "Sinn Féin's finance spokesperson said").
- Neutral wording. No "winners and losers", no adjectives that judge the Budget, no predictions.
- Headline: at most 110 characters, plain statement of the fact. Body: at most 90 words, plain English, saying who it affects and when it starts if the source says so.
- Every figure in the headline and body must appear word for word in an evidence quote. Quotes must be copied exactly from the page text, at least 20 characters, and from a listed source.
- Prefer gov.ie, Revenue, Citizens Information and the Oireachtas over press reports when they cover the same fact.
- kind: "measure" for a confirmed Budget measure, "reaction" for responses, "explainer" for context, "update" for anything else.
- Return at most 3 updates. If nothing new and well sourced is on the pages, return {"updates": []}.
Return JSON only.`;

export async function runBudgetLiveWorker(options: { now?: Date; fetch?: typeof fetch } = {}) {
  const database = getDatabase();
  const now = options.now ?? new Date();
  try {
    if (!await isRuntimeControlEnabled("budget_live", database)) {
      console.log(JSON.stringify({ event: "worker.paused", worker: "budget-live", control: "budget_live" }));
      return { stored: 0, published: 0, skipped: true };
    }
    const autopublish = process.env.BUDGET_LIVE_AUTOPUBLISH === "true";
    const memory = await getBudgetLiveMemory(BUDGET_LIVE_SLUG, database);
    const used = new Set(memory.sourceUrls.map((url) => {
      try {
        return normalizeEditorialUrl(url);
      } catch {
        return url;
      }
    }));

    const queries = budgetLiveQueries(now);
    const settled = await Promise.allSettled(queries.map((query) => searchEditorialWeb(query, BUDGET_LIVE_DOMAINS, 8)));
    const found = new Set<string>();
    for (const result of settled) {
      if (result.status === "fulfilled") collectUrls(result.value, found);
      else console.error(JSON.stringify({ event: "budget_live.search_failed", error: editorialModelError(result.reason).slice(0, 300) }));
    }
    const fresh = [...found].filter((url) => !used.has(url));
    if (!fresh.length) {
      console.log(JSON.stringify({ event: "budget_live.nothing_new", queries, found: found.size }));
      return { stored: 0, published: 0, skipped: false };
    }

    const pages = await fetchEvidencePages(fresh, BUDGET_LIVE_DOMAINS, { limit: 6, fetch: options.fetch });
    if (!pages.size) {
      console.log(JSON.stringify({ event: "budget_live.unreadable", candidates: fresh.length }));
      return { stored: 0, published: 0, skipped: false };
    }

    const { model, modelId } = createEditorialModel(BUDGET_LIVE_DOMAINS, options.fetch);
    const agent = new ToolLoopAgent({
      model,
      instructions: INSTRUCTIONS,
      output: Output.object({ schema: budgetLiveBatchSchema }),
      maxOutputTokens: 3000,
      stopWhen: isLoopFinished(),
    });
    const recent = memory.headlines.slice(0, 40);
    const prompt = [
      `Today is ${now.toISOString().slice(0, 10)}. Budget 2027 is presented to the Dáil on 6 October 2026.`,
      `Existing headlines (do not repeat):\n${recent.length ? recent.map((headline) => `- ${headline}`).join("\n") : "- none yet"}`,
      `Source pages:\n${evidencePagesForPrompt(pages, 6_000, "Budget 2027")}`,
    ].join("\n\n");
    const result = await agent.generate({ prompt, abortSignal: AbortSignal.timeout(4 * 60 * 1000) });
    const drafts = budgetLiveBatchSchema.parse(result.output).updates;

    let stored = 0;
    let published = 0;
    const headlines = [...recent];
    for (const draft of drafts) {
      const validation = validateBudgetLiveDraft(draft, pages, BUDGET_LIVE_DOMAINS, headlines);
      if (!validation.valid) {
        console.log(JSON.stringify({ event: "budget_live.rejected", headline: draft.headline.slice(0, 120), issues: validation.issues.slice(0, 6) }));
        continue;
      }
      const id = await createBudgetUpdate({
        budget: BUDGET_LIVE_SLUG,
        kind: draft.kind,
        headline: draft.headline,
        body: draft.body,
        sources: draft.sources,
        evidence: draft.evidence,
        origin: "worker",
        publish: autopublish,
        model: modelId ?? resolveEditorialModelId(),
      }, database);
      if (!id) continue;
      headlines.push(draft.headline);
      stored += 1;
      if (autopublish) published += 1;
      console.log(JSON.stringify({ event: "budget_live.stored", id, status: autopublish ? "published" : "pending" }));
    }

    if (published) {
      const indexed = await submitIndexNow([`${indexNowSiteUrl()}/budget-2027`]);
      console.log(JSON.stringify({ event: "budget_live.indexnow", ...indexed }));
    }
    console.log(JSON.stringify({ event: "budget_live.finished", queries, read: pages.size, drafted: drafts.length, stored, published }));
    return { stored, published, skipped: false };
  } finally {
    await closeDatabase();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runBudgetLiveWorker().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
