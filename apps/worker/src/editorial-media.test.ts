import { describe, expect, it } from "vitest";
import type { ClassifiedNewsItem } from "@daildex/shared";
import { shortlistNationalClusters } from "./editorial-media";
const item = (url: string, eventLabel: string, date = "2026-09-30"): ClassifiedNewsItem => ({
  url, publisher: new URL(url).hostname, title: eventLabel, publishedAt: date, snippet: null, relevant: true,
  eventLabel, eventDate: date, category: "policy_announcement", actors: [],
});
describe("national discovery shortlist", () => {
  it("prefers independent coverage over repeated coverage from one publisher", () => {
    const items = [1, 2, 3, 4].map((i) => item(`https://rte.ie/news/${i}`, "Cabinet approves harbour grants"));
    items.push(item("https://rte.ie/other", "Cabinet approves school grants"), item("https://irishtimes.com/other", "Cabinet approves school grants"));
    expect(shortlistNationalClusters(items, { start: "2026-09-28", end: "2026-09-30" }, 1)[0]).toHaveLength(2);
  });
  it("rejects old, future and impossible event dates", () => {
    const items = ["2026-01-01", "2026-10-02", "2026-99-99"].map((date, i) => item(`https://rte.ie/${i}`, "Cabinet approves harbour grants", date));
    expect(shortlistNationalClusters(items, { start: "2026-09-28", end: "2026-09-30" })).toEqual([]);
  });
});
