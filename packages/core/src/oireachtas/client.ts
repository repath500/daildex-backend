import type { OireachtasApiPage, OireachtasCategoryResult, OireachtasFetchOptions } from "./types";

const USER_AGENT = "DailDex/0.1 (contact: admin@daildex.ie)";
const DEFAULT_LIMIT = 1000;

export function getOireachtasBaseUrl(): string {
  return (process.env.OIREACHTAS_API_BASE_URL ?? "https://api.oireachtas.ie/v1").replace(/\/$/, "");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown Oireachtas API error";
}

export async function fetchOireachtasPages<T>(
  path: string,
  params: Record<string, string>,
  options?: OireachtasFetchOptions,
): Promise<OireachtasCategoryResult<T>> {
  const fetchImpl = options?.fetchImpl ?? globalThis.fetch;
  const limit = options?.limit ?? DEFAULT_LIMIT;
  const baseUrl = getOireachtasBaseUrl();
  const items: T[] = [];

  for (let skip = 0; ; skip += limit) {
    const url = new URL(`${baseUrl}${path}`);
    for (const [key, value] of Object.entries({
      ...params,
      limit: String(limit),
      skip: String(skip),
    })) {
      url.searchParams.set(key, value);
    }

    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": USER_AGENT,
        },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }

    if (!response.ok) {
      return { ok: false, error: `Oireachtas ${path} returned HTTP ${response.status}` };
    }

    let page: OireachtasApiPage<T>;
    try {
      page = (await response.json()) as OireachtasApiPage<T>;
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }

    const pageResults = page.results ?? [];
    items.push(...pageResults);
    if (pageResults.length < limit) break;
  }

  return { ok: true, items };
}

export async function fetchOireachtasChambers<T>(
  path: string,
  params: Record<string, string>,
  chambers: readonly string[],
  options?: OireachtasFetchOptions,
): Promise<OireachtasCategoryResult<T>> {
  const items: T[] = [];
  for (const chamber of chambers) {
    const page = await fetchOireachtasPages<T>(path, { ...params, chamber }, options);
    if (!page.ok) return page;
    items.push(...page.items);
  }
  return { ok: true, items };
}
