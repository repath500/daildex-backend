import { describe, expect, it } from "vitest";
import { addOfficialPassages, fetchEvidencePage, fetchEvidencePages, fingerprintEvidencePages, htmlToEvidenceText, officialPassagesForPrompt, selectEvidencePassages } from "./editorial-evidence";

const body = "The Residential Tenancies Bill was carried by 81 votes to 64. ".repeat(10);

describe("editorial evidence pages", () => {
  it("does not lose an official answer when the fetched document already fills the storage budget", () => {
    const answer = "The minister confirmed the harbour route timetable and its funding decision.";
    const pages = new Map([["https://oireachtas.ie/record", "Unrelated business. ".repeat(10_000).slice(0, 150_000)]]);
    addOfficialPassages(pages, [{ url: "https://oireachtas.ie/record", text: answer, role: "answer" }], ["oireachtas.ie"], "harbour route");
    expect(pages.get("https://oireachtas.ie/record")).toContain(answer);
    expect(pages.get("https://oireachtas.ie/record")!.length).toBeLessThanOrEqual(150_000);
  });
  it("keeps attribution beside exact quotations and handles small passage budgets", () => {
    const text = "The Minister explained the harbour route timetable. ".repeat(100);
    const prompt = JSON.parse(officialPassagesForPrompt([{ url: "https://oireachtas.ie/record", text, speaker: "Example Minister", role: "speech" }], "harbour route", 250));
    expect(prompt[0].speaker).toBe("Example Minister");
    expect(prompt[0].passages[0].text.length).toBeLessThanOrEqual(250);
    expect(text.includes(prompt[0].passages[0].text)).toBe(true);
  });
  it("preserves official answers once and fingerprints changes without depending on URL order", () => {
    const pages = new Map([["https://oireachtas.ie/record", "The official question."]]);
    const passages = [{ url: "https://www.oireachtas.ie/record", text: "The minister's exact answer.", role: "answer" as const }];
    addOfficialPassages(pages, passages, ["oireachtas.ie"]);
    const before = fingerprintEvidencePages(pages);
    addOfficialPassages(pages, passages, ["oireachtas.ie"]);
    expect(fingerprintEvidencePages(pages)).toEqual(before);
    pages.set("https://oireachtas.ie/record", pages.get("https://oireachtas.ie/record") + " A published correction.");
    expect(fingerprintEvidencePages(pages)).not.toEqual(before);
  });
  it("keeps article text and drops scripts, navigation and entities", () => {
    const text = htmlToEvidenceText(
      `<html><body><nav>Menu</nav><script>track()</script><article><h1>Vote</h1><p>D&aacute;il &amp; Seanad&nbsp;agreed.</p></article><footer>Footer</footer></body></html>`,
    );
    expect(text).toContain("Dáil & Seanad agreed.");
    expect(text).not.toContain("Menu");
    expect(text).not.toContain("track()");
    expect(text).not.toContain("Footer");
  });

  it("only reads allow-listed pages with enough text", async () => {
    const domains = ["oireachtas.ie"];
    const fetchImpl = (async (url: string) =>
      new Response(`<article><p>${url.includes("short") ? "Subscribe" : body}</p></article>`, {
        headers: { "content-type": "text/html" },
      })) as unknown as typeof fetch;
    expect(await fetchEvidencePage("https://example.com/x", domains, fetchImpl)).toBeNull();
    expect(await fetchEvidencePage("https://www.oireachtas.ie/short", domains, fetchImpl)).toBeNull();
    const page = await fetchEvidencePage("https://www.oireachtas.ie/en/debates/1", domains, fetchImpl);
    expect(page?.text).toContain("carried by 81 votes to 64");
  });

  it("finds a relevant answer late in a long document and preserves exact text", () => {
    const answer = "The Minister answered that the East Harbour bus route will receive €2 million in funding next month.";
    const text = Array.from({ length: 100 }, (_, i) => `Unrelated procedural business number ${i}.`).join("\n") + "\n" + answer;
    const passages = selectEvidencePassages(text, "East Harbour bus route", 1000);
    expect(passages.some((passage) => passage.text.includes(answer))).toBe(true);
    for (const passage of passages) expect(text.slice(passage.start, passage.start + passage.text.length)).toBe(passage.text);
  });

  it("tries alternative sources when early reads fail", async () => {
    const fetchImpl: typeof fetch = async (input) => new Response(String(input).includes("failed") ? "Subscribe" : body, { headers: { "content-type": "text/plain" } });
    const urls = Array.from({ length: 5 }, (_, i) => `https://oireachtas.ie/failed-${i}`).concat("https://oireachtas.ie/readable");
    expect((await fetchEvidencePages(urls, ["oireachtas.ie"], { limit: 1, fetch: fetchImpl })).size).toBe(1);
  });

  it("rejects a streamed oversized body without trusting Content-Length", async () => {
    const fetchImpl: typeof fetch = async () => new Response("x".repeat(2_000_001), { headers: { "content-type": "text/plain" } });
    expect(await fetchEvidencePage("https://oireachtas.ie/record", ["oireachtas.ie"], fetchImpl)).toBeNull();
  });

  it("does not follow a redirect outside the source policy", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => { calls += 1; return new Response(null, { status: 302, headers: { location: "https://example.com/other" } }); };
    expect(await fetchEvidencePage("https://oireachtas.ie/record", ["oireachtas.ie"], fetchImpl)).toBeNull();
    expect(calls).toBe(1);
  });
});
