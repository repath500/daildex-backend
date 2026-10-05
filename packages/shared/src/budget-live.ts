import { createHash } from "node:crypto";
import { z } from "zod";
import { excerptAppearsInPage, normalizeEditorialUrl } from "./editorial-national";
import { isAllowedEditorialUrl } from "./editorial";

export const BUDGET_LIVE_SLUG = "budget-2027";

export const budgetLiveKinds = ["update", "measure", "reaction", "explainer", "correction"] as const;
export type BudgetLiveKind = (typeof budgetLiveKinds)[number];

export type BudgetLiveSource = { url: string; title: string; publisher: string };
export type BudgetLiveEvidence = { url: string; quote: string };

/** What the page shows for one published update. */
export type BudgetLiveUpdate = {
  id: string;
  kind: BudgetLiveKind;
  headline: string;
  body: string;
  sources: BudgetLiveSource[];
  pinned: boolean;
  origin: "worker" | "editor";
  publishedAt: string;
};

/** One update drafted by the model. Every figure must be backed by an exact quote. */
export const budgetLiveDraftSchema = z.object({
  kind: z.enum(budgetLiveKinds),
  headline: z.string().min(8).max(180),
  body: z.string().min(20).max(1200),
  sources: z.array(z.object({ url: z.string(), title: z.string().max(240), publisher: z.string().max(120) })).min(1).max(4),
  evidence: z.array(z.object({ url: z.string(), quote: z.string().min(20).max(600) })).min(1).max(6),
});
export type BudgetLiveDraft = z.infer<typeof budgetLiveDraftSchema>;

export const budgetLiveBatchSchema = z.object({
  updates: z.array(budgetLiveDraftSchema).max(4),
});

const STOP_WORDS = new Set(["the", "a", "an", "of", "to", "in", "on", "for", "and", "is", "be", "by", "will", "with", "at", "as", "from", "budget", "2027"]);

function headlineWords(text: string): Set<string> {
  return new Set(
    text
      .toLocaleLowerCase("en-IE")
      .normalize("NFKD")
      .replace(/[^\p{L}\p{N}€.\s]/gu, " ")
      .split(/\s+/)
      .filter((word) => word.length > 1 && !STOP_WORDS.has(word)),
  );
}

/** Stable key so the same update is never stored twice. */
export function budgetLiveFingerprint(headline: string): string {
  return createHash("sha256").update([...headlineWords(headline)].sort().join(" "), "utf8").digest("hex");
}

/** Word overlap between two headlines, from 0 to 1. */
export function headlineSimilarity(left: string, right: string): number {
  const a = headlineWords(left);
  const b = headlineWords(right);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/** Figures in a piece of text, normalised so "€1,000" and "1000" match. Bare years are ignored. */
export function figuresIn(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/(€\s?)?(\d[\d,]*(?:\.\d+)?)/g)) {
    const value = match[2].replace(/,/g, "").replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
    const isYear = !match[1] && /^20\d\d$/.test(value);
    if (!isYear) found.add(value);
  }
  return [...found];
}

export type BudgetLiveValidation = { valid: true } | { valid: false; issues: string[] };

/**
 * A draft can be stored only if each source and quote comes from a page that was
 * actually read, every quote appears word for word on that page, and every
 * figure in the headline and body appears in one of the quotes.
 */
export function validateBudgetLiveDraft(
  draft: BudgetLiveDraft,
  pages: ReadonlyMap<string, string>,
  allowedDomains: readonly string[],
  recentHeadlines: readonly string[] = [],
): BudgetLiveValidation {
  const issues: string[] = [];
  const key = (url: string) => {
    try {
      return normalizeEditorialUrl(url);
    } catch {
      return url;
    }
  };
  const read = new Map([...pages].map(([url, text]) => [key(url), text]));

  for (const source of draft.sources) {
    if (!isAllowedEditorialUrl(source.url, allowedDomains)) issues.push(`Source is not on an approved domain: ${source.url}`);
    else if (!read.has(key(source.url))) issues.push(`Source was not read: ${source.url}`);
  }

  const sourceKeys = new Set(draft.sources.map((source) => key(source.url)));
  for (const item of draft.evidence) {
    const page = read.get(key(item.url));
    if (!page) issues.push(`Evidence page was not read: ${item.url}`);
    else if (!excerptAppearsInPage(item.quote, page)) issues.push(`Quote is not on the page: "${item.quote.slice(0, 80)}"`);
    if (!sourceKeys.has(key(item.url))) issues.push(`Evidence is not from a listed source: ${item.url}`);
  }

  const quoted = figuresIn(draft.evidence.map((item) => item.quote).join(" "));
  for (const figure of figuresIn(`${draft.headline} ${draft.body}`)) {
    if (!quoted.includes(figure)) issues.push(`Figure ${figure} is not in any quote`);
  }

  if (recentHeadlines.some((headline) => headlineSimilarity(headline, draft.headline) >= 0.6)) {
    issues.push("Repeats an existing update");
  }

  return issues.length ? { valid: false, issues } : { valid: true };
}
