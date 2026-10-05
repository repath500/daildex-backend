import { fetchOireachtasChambers } from "./client";
import { normalizeVote } from "./normalize";
import type {
  NormalizedParliamentaryRecord,
  OireachtasCategoryResult,
  OireachtasFetchOptions,
  VoteResult,
} from "./types";

const CHAMBERS = ["dail", "seanad"] as const;

export async function fetchOireachtasVotes(
  periodStart: string,
  periodEnd: string,
  fetchImpl?: typeof fetch,
  options?: Omit<OireachtasFetchOptions, "fetchImpl">,
): Promise<OireachtasCategoryResult<NormalizedParliamentaryRecord>> {
  const page = await fetchOireachtasChambers<VoteResult>(
    "/votes",
    {
      date_start: periodStart,
      date_end: periodEnd,
    },
    CHAMBERS,
    { fetchImpl, limit: options?.limit },
  );
  if (!page.ok) return page;

  const items: NormalizedParliamentaryRecord[] = [];
  for (const result of page.items) {
    const normalized = normalizeVote(result);
    if (normalized) items.push(normalized);
  }
  return { ok: true, items };
}
