import { z } from "zod";

/**
 * Source policy for the weekly constituency brief. The list is deliberately
 * a registry, not a per-run quota: Muse decides how much research is needed
 * and the worker only enforces the allowed domain boundary and run deadline.
 */
/** OpenRouter id for GPT 6 Luna. Editorial generation, classification, and verification all use this model. */
export const EDITORIAL_MODEL_ID = "openai/gpt-6-luna";

export function resolveEditorialModelId(value?: string | null): string {
  const raw = value?.trim() || process.env.EDITORIAL_MODEL?.trim() || "";
  if (raw && raw !== EDITORIAL_MODEL_ID) {
    console.error(JSON.stringify({
      event: "editorial.model_overridden",
      requested: raw,
      model: EDITORIAL_MODEL_ID,
    }));
  }
  return EDITORIAL_MODEL_ID;
}

/**
 * Model for the independent verify pass. Defaults to the editorial model;
 * set EDITORIAL_VERIFY_MODEL to an OpenRouter id to check drafts with a
 * different, stronger model than the one that wrote them.
 */
export function resolveEditorialVerifyModelId(value?: string | null): string {
  return value?.trim() || process.env.EDITORIAL_VERIFY_MODEL?.trim() || EDITORIAL_MODEL_ID;
}

export const EDITORIAL_OFFICIAL_DOMAINS = [
  "oireachtas.ie",
  "api.oireachtas.ie",
  "data.oireachtas.ie",
  "gov.ie",
  "citizensinformation.ie",
  "electoralcommission.ie",
  "irishstatutebook.ie",
  "president.ie",
  "courts.ie",
  "cso.ie",
  "military.ie",
  "europa.eu",
] as const;

/** Party and campaign sites. Useful for attributed claims, never silent facts. */
export const EDITORIAL_ORIGINATOR_DOMAINS = [
  "finegael.ie",
  "fiannafail.ie",
  "sinnfein.ie",
  "greenparty.ie",
  "labour.ie",
  "socialdemocrats.ie",
  "pbp.ie",
  "aontu.ie",
] as const;

// National publishers: BreakingNews, Newstalk and Today FM are intentionally
// excluded from this registry at the request of the editorial policy.
export const EDITORIAL_NATIONAL_DOMAINS = [
  "rte.ie",
  "thejournal.ie",
  "independent.ie",
  "irishtimes.com",
  "irishexaminer.com",
  "businesspost.ie",
  "farmersjournal.ie",
  "mirror.ie",
  "extra.ie",
  "agriland.ie",
] as const;

/**
 * One primary local source is used for every county. A second source is
 * included only where the county has a larger, independently useful news
 * market. Waterford is therefore represented by two choices rather than a
 * Waterford-heavy allow-list.
 */
export const EDITORIAL_LOCAL_DOMAINS_BY_COUNTY: Readonly<Record<string, readonly string[]>> = {
  Carlow: ["carlow-nationalist.ie"],
  Cavan: ["anglocelt.ie"],
  Clare: ["clareecho.ie"],
  Cork: ["echolive.ie", "corkbeo.ie"],
  Donegal: ["donegaldaily.com", "donegalnews.com"],
  Dublin: ["dublingazette.com", "dublinlive.ie"],
  Galway: ["galwaybeo.ie", "connachttribune.ie"],
  Kerry: ["kerryseye.com", "kerryman.ie"],
  Kildare: ["leinsterleader.ie"],
  Kilkenny: ["kilkennypeople.ie"],
  Laois: ["laois-nationalist.ie"],
  Leitrim: ["leitrimobserver.ie"],
  Limerick: ["limerickleader.ie", "limerickpost.ie"],
  Longford: ["longfordleader.ie"],
  Louth: ["dundalkdemocrat.ie"],
  Mayo: ["mayonews.ie"],
  Meath: ["meathchronicle.ie"],
  Monaghan: ["northernstandard.ie"],
  Offaly: ["offalyexpress.ie"],
  Roscommon: ["roscommonherald.ie"],
  Sligo: ["sligochampion.ie"],
  Tipperary: ["tipperarylive.ie"],
  Waterford: ["waterford-news.ie", "waterfordlive.ie"],
  Westmeath: ["westmeathexaminer.ie"],
  Wexford: ["wexfordpeople.ie", "wexfordlive.ie"],
  Wicklow: ["wicklowpeople.ie"],
} as const;

export const editorialCountySchema = z.string().trim().min(1).max(80);
const safeText = (maximum: number) => z.string().trim().min(1).max(maximum);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const editorialSourceSchema = z.strictObject({
  url: z.string().url(),
  title: safeText(240),
  publisher: safeText(120),
  publishedAt: z.string().trim().max(80).optional(),
  kind: z.enum(["official", "national_news", "local_news"]),
  county: editorialCountySchema.optional(),
  // Short evidence notes only; the article must paraphrase linked reporting.
  excerpt: z.string().trim().max(700).optional(),
});

export type EditorialSource = z.infer<typeof editorialSourceSchema>;

const editorialSectionSchema = z.strictObject({
  heading: safeText(180),
  purpose: z.enum(["event", "substance", "impact", "background", "response", "next_step"]).optional(),
  paragraphs: z.array(safeText(3000)).min(1),
  bullets: z.array(safeText(600)).optional(),
  sourceUrls: z.array(z.string().url()).min(1),
});

export const editorialPeriodSchema = z.strictObject({
  start: dateSchema,
  end: dateSchema,
});

export const editorialDraftSchema = z.strictObject({
  title: safeText(160),
  description: safeText(600),
  kicker: safeText(100),
  period: editorialPeriodSchema,
  relevantCounties: z.array(editorialCountySchema),
  representatives: z.array(safeText(140)).min(1),
  sections: z.array(editorialSectionSchema).min(1),
  sources: z.array(editorialSourceSchema).min(1),
  disclosure: safeText(500),
});

export type EditorialDraft = z.infer<typeof editorialDraftSchema>;

export const editorialResearchPassSchema = z.strictObject({
  ...editorialDraftSchema.shape,
  researchSummary: safeText(5000),
  researchSourceUrls: z.array(z.string().url()).min(1),
});

export type EditorialResearchPass = z.infer<typeof editorialResearchPassSchema>;

export const editorialLegacyFinalSchema = z.strictObject({
  ...editorialDraftSchema.shape,
  verification: z.strictObject({
    passed: z.boolean(),
    issues: z.array(z.string().trim().max(400)),
    checkedAt: z.string().datetime(),
    checks: z.array(z.string().trim().max(120)),
  }),
});

export type EditorialLegacyFinal = z.infer<typeof editorialLegacyFinalSchema>;

export const editorialEvidenceKindSchema = z.enum(["official", "reporting", "originator"]);

export const editorialArticleSourceSchema = z.strictObject({
  url: z.string().url(),
  title: safeText(240),
  publisher: safeText(120),
  publishedAt: z.string().trim().max(80).optional(),
  kind: editorialEvidenceKindSchema,
  excerpt: z.string().trim().max(700).optional(),
});

export const editorialFinalSchema = z.strictObject({
  title: safeText(160),
  format: z.enum(["brief", "article", "explainer"]).optional(),
  description: safeText(600),
  // Search-result title and snippet. Limits are loose so a long field is
  // clipped at render time instead of discarding the whole article.
  seoTitle: safeText(200).optional(),
  metaDescription: safeText(400).optional(),
  period: editorialPeriodSchema,
  sections: z.array(editorialSectionSchema).min(1),
  sources: z.array(editorialArticleSourceSchema).min(1),
  disclosure: safeText(500),
  verification: z.strictObject({
    passed: z.boolean(),
    issues: z.array(z.string().trim().max(400)),
    checkedAt: z.string().datetime(),
    checks: z.array(z.string().trim().max(120)),
  }),
});

export type EditorialFinal = z.infer<typeof editorialFinalSchema>;

export type EditorialBrief = {
  constituencyName: string;
  counties: string[];
  periodStart: string;
  periodEnd: string;
  representatives: Array<{
    name: string;
    party: string;
    role: string;
    area: string;
    facts: Array<{
      factType: string;
      payload: unknown;
      sourceUrl: string | null;
      effectiveAt: string | null;
    }>;
  }>;
};

export function localDomainsForCounties(counties: readonly string[]): string[] {
  return [...new Set(counties.flatMap((county) => EDITORIAL_LOCAL_DOMAINS_BY_COUNTY[county] ?? []))];
}

export function editorialAllowedDomains(counties: readonly string[] = []): string[] {
  return [
    ...EDITORIAL_OFFICIAL_DOMAINS,
    ...EDITORIAL_NATIONAL_DOMAINS,
    ...localDomainsForCounties(counties),
  ];
}

export function isAllowedEditorialHost(hostname: string, allowedDomains: readonly string[]): boolean {
  const host = hostname.toLocaleLowerCase("en-IE").replace(/^www\./, "");
  return allowedDomains.some((domain) => {
    const normalized = domain.toLocaleLowerCase("en-IE").replace(/^www\./, "");
    return host === normalized || host.endsWith(`.${normalized}`);
  });
}

export function isAllowedEditorialUrl(url: string, allowedDomains: readonly string[]): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password && (!parsed.port || parsed.port === "443") && isAllowedEditorialHost(parsed.hostname, allowedDomains);
  } catch {
    return false;
  }
}
