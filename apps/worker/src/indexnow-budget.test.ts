import { describe, expect, it } from "vitest";
import { budgetUrls } from "./indexnow-budget";

describe("Budget IndexNow URLs", () => {
  it("lists English and Irish pages on the site's own host", () => {
    const urls = budgetUrls("https://www.daildex.com");
    expect(urls).toContain("https://www.daildex.com/budget-2027/calculator");
    expect(urls).toContain("https://www.daildex.com/ga/budget-2027/housing");
    expect(urls.every((url) => url.startsWith("https://www.daildex.com/"))).toBe(true);
  });
});
