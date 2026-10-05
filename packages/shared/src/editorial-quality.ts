import { z } from "zod";
import type { EditorialFinal } from "./editorial";

export const EDITORIAL_FACETS = ["event", "substance", "impact", "background", "response", "next_step"] as const;
export const editorialResearchBriefSchema = z.strictObject({
  facts: z.array(z.strictObject({
    facet: z.enum(EDITORIAL_FACETS),
    text: z.string().trim().min(1).max(700),
    sourceUrl: z.string().url(),
    excerpt: z.string().trim().min(20).max(700),
  })).max(40),
  missingFacets: z.array(z.enum(EDITORIAL_FACETS)).max(6),
  followUpQueries: z.array(z.string().trim().min(1).max(400)).max(2),
});
export type EditorialResearchBrief = z.infer<typeof editorialResearchBriefSchema>;
export type EditorialFormat = "brief" | "article" | "explainer";
export const EDITORIAL_LENGTHS = {
  brief: { target: "200–350", minimum: 150, maximum: 450 },
  article: { target: "550–850", minimum: 400, maximum: 1000 },
  explainer: { target: "900–1,200", minimum: 750, maximum: 1500 },
} as const;

/** Depth follows distinct supported facts and coverage, rather than URL volume. */
export function editorialFormatForBrief(brief: EditorialResearchBrief): EditorialFormat {
  const facets = new Set(brief.facts.map((fact) => fact.facet));
  const distinct = new Set(brief.facts.map((fact) => fact.text.toLowerCase())).size;
  if (!facets.has("event") || !facets.has("substance")) return "brief";
  if (facets.size === 6 && distinct >= 16) return "explainer";
  if (facets.size >= 4 && distinct >= 8) return "article";
  return "brief";
}

export function editorialWordCount(post: Pick<EditorialFinal, "sections">): number {
  return post.sections.flatMap((section) => [...section.paragraphs, ...(section.bullets ?? [])])
    .join(" ").split(/\s+/).filter(Boolean).length;
}

export function editorialFeaturedNames(post: EditorialFinal, names: readonly string[]): string[] {
  const prose = [post.title, post.description, ...post.sections.flatMap((section) => [...section.paragraphs, ...(section.bullets ?? [])])]
    .join(" ").toLocaleLowerCase("en-IE");
  return [...new Set(names.map((name) => name.trim()).filter((name) => name && prose.includes(name.toLocaleLowerCase("en-IE"))))];
}

export function evaluateEditorialQuality(post: EditorialFinal) {
  const wordCount = editorialWordCount(post);
  const issues: string[] = [];
  const seen = new Set<string>();
  let repeatedParagraphs = 0;
  for (const section of post.sections) {
    for (const paragraph of section.paragraphs) {
      const key = paragraph.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
      if (key.split(" ").length >= 12 && seen.has(key)) repeatedParagraphs += 1;
      seen.add(key);
    }
  }
  if (repeatedParagraphs) issues.push("The article repeats a substantive paragraph.");
  if (post.format) {
    if (post.sections.some((section) => !section.purpose)) issues.push("Each section needs an editorial purpose.");
    const length = EDITORIAL_LENGTHS[post.format];
    if (wordCount < length.minimum) issues.push(`The ${post.format} is too thin (${wordCount} words; minimum ${length.minimum}). Research more or defer it; do not pad it.`);
    if (wordCount > length.maximum) issues.push(`The ${post.format} exceeds its useful length budget (${length.maximum} words).`);
  }
  return { wordCount, format: post.format ?? "legacy", sections: post.sections.length,
    sourceCount: post.sources.length, quotedSources: post.sources.filter((source) => source.excerpt).length,
    repeatedParagraphs, issues };
}
