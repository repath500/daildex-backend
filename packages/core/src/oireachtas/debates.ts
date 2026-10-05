import { fetchOireachtasChambers } from "./client";
import { normalizeDebate } from "./normalize";
import type {
  DebateResult,
  NormalizedParliamentaryRecord,
  OireachtasCategoryResult,
  OireachtasFetchOptions,
} from "./types";

const CHAMBERS = ["dail", "seanad"] as const;

export async function fetchOireachtasDebates(
  periodStart: string,
  periodEnd: string,
  fetchImpl?: typeof fetch,
  options?: Omit<OireachtasFetchOptions, "fetchImpl">,
): Promise<OireachtasCategoryResult<NormalizedParliamentaryRecord>> {
  const page = await fetchOireachtasChambers<DebateResult>(
    "/debates",
    {
      chamber_type: "house",
      date_start: periodStart,
      date_end: periodEnd,
    },
    CHAMBERS,
    { fetchImpl, limit: options?.limit },
  );
  if (!page.ok) return page;

  const items: NormalizedParliamentaryRecord[] = [];
  for (const result of page.items) {
    items.push(...normalizeDebate(result));
  }
  return { ok: true, items };
}
