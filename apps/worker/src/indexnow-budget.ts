import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { indexNowSiteUrl, submitIndexNow } from "./indexnow";

/** Every Budget 2027 URL, in English and Irish. Keep in step with BUDGET_TOPICS. */
export const BUDGET_TOPIC_SLUGS = [
  "tax-and-pay",
  "pensions-and-welfare",
  "families-and-children",
  "housing",
  "energy-and-fuel",
  "education",
  "business-and-vat",
] as const;

export function budgetUrls(siteUrl = indexNowSiteUrl()): string[] {
  const paths = ["/budget-2027", "/budget-2027/calculator", ...BUDGET_TOPIC_SLUGS.map((slug) => `/budget-2027/${slug}`), "/blog/budget-2027-guide", "/sitemap.xml"];
  return paths.flatMap((path) => (path === "/sitemap.xml" ? [`${siteUrl}${path}`] : [`${siteUrl}${path}`, `${siteUrl}/ga${path}`]));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const urls = budgetUrls();
  submitIndexNow(urls).then((result) => {
    console.log(JSON.stringify({ event: "indexnow.budget", urls: urls.length, ...result }));
    if (!result.ok) process.exitCode = 1;
  });
}
