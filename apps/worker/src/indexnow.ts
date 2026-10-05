/**
 * IndexNow tells Bing (which powers ChatGPT search and Copilot), Yandex,
 * Seznam and Naver about new or changed URLs within minutes. The key is
 * public by design and is served from /public/<key>.txt.
 * https://www.indexnow.org/documentation
 */
export const INDEXNOW_KEY = "e5e00c8f946c0e927d67cb85fe751ca5";

export function indexNowSiteUrl(value = process.env.INDEXNOW_SITE_URL): string {
  return (value?.trim() || "https://www.daildex.com").replace(/\/$/, "");
}

export async function submitIndexNow(
  urls: readonly string[],
  options: { siteUrl?: string; fetch?: typeof fetch } = {},
): Promise<{ ok: boolean; status: number | null }> {
  const siteUrl = options.siteUrl ?? indexNowSiteUrl();
  const host = new URL(siteUrl).host;
  const urlList = [...new Set(urls)].filter((url) => {
    try {
      return new URL(url).host === host;
    } catch {
      return false;
    }
  });
  if (!urlList.length) return { ok: false, status: null };
  try {
    const response = await (options.fetch ?? fetch)("https://api.indexnow.org/indexnow", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        host,
        key: INDEXNOW_KEY,
        keyLocation: `${siteUrl}/${INDEXNOW_KEY}.txt`,
        urlList,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    // 200 and 202 both mean accepted.
    return { ok: response.status === 200 || response.status === 202, status: response.status };
  } catch {
    return { ok: false, status: null };
  }
}
