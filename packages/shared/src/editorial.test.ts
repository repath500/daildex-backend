import { describe, expect, it } from "vitest";
import {
  EDITORIAL_LOCAL_DOMAINS_BY_COUNTY,
  EDITORIAL_NATIONAL_DOMAINS,
  EDITORIAL_OFFICIAL_DOMAINS,
  editorialAllowedDomains,
  isAllowedEditorialUrl,
} from "./editorial";

describe("editorial source policy", () => {
  it("keeps national sources broad and excludes the retired broadcasters", () => {
    expect(EDITORIAL_NATIONAL_DOMAINS).toContain("rte.ie");
    expect(EDITORIAL_NATIONAL_DOMAINS).not.toContain("breakingnews.ie");
    expect(EDITORIAL_NATIONAL_DOMAINS).not.toContain("newstalk.com");
    expect(EDITORIAL_NATIONAL_DOMAINS).not.toContain("todayfm.co");
  });

  it("allows Defence Forces records as primary evidence", () => {
    expect(EDITORIAL_OFFICIAL_DOMAINS).toContain("military.ie");
    expect(isAllowedEditorialUrl("https://www.military.ie/en/news-and-events/news/briefing", EDITORIAL_OFFICIAL_DOMAINS)).toBe(true);
  });

  it("gives every county a primary and only selected counties a fallback", () => {
    expect(Object.keys(EDITORIAL_LOCAL_DOMAINS_BY_COUNTY)).toHaveLength(26);
    expect(EDITORIAL_LOCAL_DOMAINS_BY_COUNTY.Westmeath).toHaveLength(1);
    expect(EDITORIAL_LOCAL_DOMAINS_BY_COUNTY.Waterford).toHaveLength(2);
    expect(EDITORIAL_LOCAL_DOMAINS_BY_COUNTY.Cork).toHaveLength(2);
  });

  it("matches hosts safely and rejects lookalike domains", () => {
    const allowed = editorialAllowedDomains(["Waterford"]);
    expect(isAllowedEditorialUrl("https://www.waterford-news.ie/story", allowed)).toBe(true);
    expect(isAllowedEditorialUrl("https://waterford-news.ie.evil.example/story", allowed)).toBe(false);
  });
});
