import { fetchOireachtasPages } from "./client";
import { normalizeQuestion } from "./normalize";
import type {
  NormalizedParliamentaryRecord,
  OireachtasCategoryResult,
  OireachtasFetchOptions,
  QuestionResult,
} from "./types";

export async function fetchOireachtasQuestions(
  periodStart: string,
  periodEnd: string,
  fetchImpl?: typeof fetch,
  options?: Omit<OireachtasFetchOptions, "fetchImpl">,
): Promise<OireachtasCategoryResult<NormalizedParliamentaryRecord>> {
  const page = await fetchOireachtasPages<QuestionResult>(
    "/questions",
    {
      date_start: periodStart,
      date_end: periodEnd,
      show_answers: "true",
    },
    { fetchImpl, limit: options?.limit },
  );
  if (!page.ok) return page;

  const items: NormalizedParliamentaryRecord[] = [];
  for (const result of page.items) {
    const normalized = normalizeQuestion(result);
    if (normalized) items.push(normalized);
  }
  return { ok: true, items };
}
