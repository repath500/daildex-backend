import { createHash } from "node:crypto";
import { isAllowedEditorialUrl, normalizeEditorialUrl, type EditorialStoryCandidate } from "@daildex/shared";

const USER_AGENT = "DailDexBot/1.0 (+https://www.daildex.com/methodology)";
const MAX_BYTES = 2_000_000;
const MAX_STORED_CHARS = 150_000;

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: "\"",
  apos: "'",
  nbsp: " ",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  euro: "€",
  aacute: "á",
  eacute: "é",
  iacute: "í",
  oacute: "ó",
  uacute: "ú",
  Aacute: "Á",
  Eacute: "É",
  Iacute: "Í",
  Oacute: "Ó",
  Uacute: "Ú",
};

function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const code = entity[1]?.toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity] ?? match;
  });
}

/** Reduce an HTML page to readable body text, preferring <article> or <main>. */
export function htmlToEvidenceText(html: string): string {
  const withoutNoise = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe|form|nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, " ");
  const focused =
    withoutNoise.match(/<article\b[\s\S]*<\/article>/i)?.[0] ??
    withoutNoise.match(/<main\b[\s\S]*<\/main>/i)?.[0] ??
    withoutNoise.match(/<body\b[\s\S]*<\/body>/i)?.[0] ??
    withoutNoise;
  return decodeEntities(
    focused
      .replace(/<\/(p|div|li|h[1-6]|tr|section|br)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim()
    .slice(0, MAX_STORED_CHARS);
}

export type EvidencePage = { url: string; text: string };

export function addOfficialPassages(pages: Map<string, string>, passages: EditorialStoryCandidate["passages"], domains: readonly string[], query = "") {
  const grouped = new Map<string, string[]>();
  for (const passage of passages ?? []) {
    const key = normalizeEditorialUrl(passage.url);
    if (!isAllowedEditorialUrl(key, domains) || !passage.text.trim()) continue;
    const texts = grouped.get(key) ?? [];
    if (!texts.includes(passage.text)) texts.push(passage.text);
    grouped.set(key, texts);
  }
  for (const [key, texts] of grouped) {
    const existing = pages.get(key) ?? "";
    if (texts.every((text) => existing.includes(text))) continue;
    // Reserve space for API answers/speeches before a long HTML/XML page can crowd them out.
    const official = selectEvidencePassages(texts.join("\n"), query, MAX_STORED_CHARS / 2).map((passage) => passage.text).join("\n");
    if (existing.startsWith(official)) continue;
    pages.set(key, `${official}\n${existing}`.trim().slice(0, MAX_STORED_CHARS));
  }
}

export function fingerprintEvidencePages(pages: ReadonlyMap<string, string>): Record<string, string> {
  return Object.fromEntries([...pages].map(([url, text]) => [url, createHash("sha256").update(text).digest("hex")]));
}

export async function fetchEvidencePage(
  url: string,
  allowedDomains: readonly string[],
  fetchImpl: typeof fetch = fetch,
): Promise<EvidencePage | null> {
  if (!isAllowedEditorialUrl(url, allowedDomains)) return null;
  try {
    const response = await fetchImpl(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return null;
      const next = new URL(location, url).toString();
      if (!isAllowedEditorialUrl(next, allowedDomains)) return null;
      // A bounded redirect fetch avoids following an unapproved URL, even transiently.
      const redirected = await fetchImpl(next, { headers: { "User-Agent": USER_AGENT }, redirect: "error", signal: AbortSignal.timeout(15_000) });
      return await readEvidenceResponse(redirected, url);
    }
    return await readEvidenceResponse(response, url);
  } catch {
    return null;
  }
}

async function readEvidenceResponse(response: Response, url: string): Promise<EvidencePage | null> {
    if (!response.ok) return null;
    // A redirect off the allow-list is treated as unread.
    const type = response.headers.get("content-type") ?? "";
    if (!/text\/html|application\/xhtml|text\/plain|(?:application|text)\/xml/i.test(type)) return null;
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > MAX_BYTES) return null;
    if (!response.body) return null;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        bytes += result.value.byteLength;
        if (bytes > MAX_BYTES) { await reader.cancel(); return null; }
        chunks.push(result.value);
      }
    } finally { reader.releaseLock(); }
    const body = Buffer.concat(chunks).toString("utf8");
    const text = /text\/plain/i.test(type) ? body.slice(0, MAX_STORED_CHARS) : htmlToEvidenceText(body);
    // Paywalls and consent walls leave almost nothing; do not treat them as read.
    if (text.length < 400) return null;
    return { url: normalizeEditorialUrl(url), text };
}

export async function fetchEvidencePages(
  urls: readonly string[],
  allowedDomains: readonly string[],
  options: { limit?: number; fetch?: typeof fetch; maxAttempts?: number } = {},
): Promise<Map<string, string>> {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const url of urls) {
    let key: string;
    try {
      key = normalizeEditorialUrl(url);
    } catch {
      continue;
    }
    if (seen.has(key) || !isAllowedEditorialUrl(url, allowedDomains)) continue;
    seen.add(key);
    unique.push(url);
    if (unique.length >= (options.maxAttempts ?? 16)) break;
  }
  const result = new Map<string, string>();
  const limit = options.limit ?? 8;
  for (let offset = 0; offset < unique.length && result.size < limit;) {
    const batch = unique.slice(offset, offset + Math.min(4, limit - result.size));
    offset += batch.length;
    const pages = await Promise.all(batch
      .map((url) => fetchEvidencePage(url, allowedDomains, options.fetch)));
    for (const page of pages) if (page) result.set(page.url, page.text);
  }
  return result;
}

/** Select exact passages throughout a document; retain their order and offsets. */
export function selectEvidencePassages(text: string, query: string, budget = 7_500): Array<{ start: number; text: string }> {
  if (budget <= 0) return [];
  if (text.length <= budget) return [{ start: 0, text }];
  const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? [])];
  const chunks: Array<{ start: number; text: string; score: number }> = [];
  const pattern = /[^\n]+(?:\n|$)/g;
  for (const match of text.matchAll(pattern)) {
    const chunkSize = Math.min(1200, budget);
    for (let offset = 0; offset < match[0].length; offset += chunkSize) {
      const part = match[0].slice(offset, offset + chunkSize);
      const lower = part.toLowerCase();
      const relevance = terms.reduce((score, term) => score + (lower.includes(term) ? 3 : 0), 0);
      const detail = /\b(?:minister|answer|amendment|proposed|cost|funding|affected|deadline|next|commence|implementation)\b/i.test(part) ? 2 : 0;
      chunks.push({ start: match.index + offset, text: part, score: relevance + detail });
    }
  }
  const selected: typeof chunks = [];
  let used = 0;
  for (const chunk of chunks.sort((a, b) => (b.score + (b.start < 1000 ? 4 : 0)) - (a.score + (a.start < 1000 ? 4 : 0)) || a.start - b.start)) {
    if (used + chunk.text.length > budget) continue;
    selected.push(chunk); used += chunk.text.length;
  }
  return selected.sort((a, b) => a.start - b.start).map(({ start, text }) => ({ start, text }));
}

/** Keep each official voice attached to its own exact words in the model context. */
export function officialPassagesForPrompt(passages: EditorialStoryCandidate["passages"], query: string, budget = 12_000): string {
  const usable = (passages ?? []).filter((passage) => passage.text.trim());
  const perPassage = Math.floor(budget / Math.max(1, usable.length));
  return JSON.stringify(usable.map((passage) => ({ url: passage.url, role: passage.role, speaker: passage.speaker ?? null,
    passages: selectEvidencePassages(passage.text, query, Math.min(2500, perPassage)) })));
}

export function evidencePagesForPrompt(pages: ReadonlyMap<string, string>, charsPerPage = 7_500, query = ""): string {
  return JSON.stringify(
    [...pages].map(([url, text]) => ({ url, passages: selectEvidencePassages(text, query, charsPerPage) })),
  );
}
