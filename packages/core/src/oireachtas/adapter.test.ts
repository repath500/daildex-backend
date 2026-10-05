import { describe, expect, it, vi } from "vitest";
import { fetchOireachtasVotes } from "./divisions";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("oireachtas adapter", () => {
  it("returns ok:false when votes request fails with HTTP 500", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ results: [] }, 500));

    const result = await fetchOireachtasVotes("2026-01-01", "2026-01-07", fetchImpl);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/votes|HTTP 500/i);
  });

  it("returns ok:true with empty items for votes with no results", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ results: [] }));

    const result = await fetchOireachtasVotes("2026-01-01", "2026-01-07", fetchImpl);

    expect(result).toEqual({ ok: true, items: [] });
    expect(fetchImpl).toHaveBeenCalled();
  });

  it("normalizes a division with three tally participants into one record", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("chamber=seanad")) {
        return jsonResponse({ results: [] });
      }
      return jsonResponse({
        results: [
          {
            division: {
              uri: "https://data.oireachtas.ie/ie/oireachtas/division/house/dail/34/2026-01-15/vote_1",
              voteId: "1",
              date: "2026-01-15T14:00:00",
              outcome: "Carried",
              subject: { showAs: "Motion on housing", uri: null },
              debate: {
                showAs: "Private Members' Business",
                uri: "https://www.oireachtas.ie/en/debates/debate/dail/2026-01-15/",
              },
              tallies: {
                taVotes: {
                  members: [{ member: { showAs: "Alice Murphy", memberCode: "Alice-Murphy" } }],
                },
                nilVotes: {
                  members: [{ member: { showAs: "Bob Byrne", memberCode: "Bob-Byrne" } }],
                },
                staonVotes: {
                  members: [{ member: { showAs: "Carol Kelly", memberCode: "Carol-Kelly" } }],
                },
              },
            },
          },
        ],
      });
    };

    const result = await fetchOireachtasVotes("2026-01-01", "2026-01-31", fetchImpl);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      kind: "vote",
      subject: "Motion on housing",
      date: "2026-01-15",
      outcome: "Carried (Tá 1, Níl 1, Staon 1)",
      sourceKey: "https://data.oireachtas.ie/ie/oireachtas/division/house/dail/34/2026-01-15/vote_1",
      url: "https://www.oireachtas.ie/en/debates/debate/dail/2026-01-15/",
    });
    expect(result.items[0]?.participants).toEqual([
      { name: "Alice Murphy", memberCode: "Alice-Murphy", party: null, participation: "Tá" },
      { name: "Bob Byrne", memberCode: "Bob-Byrne", party: null, participation: "Níl" },
      { name: "Carol Kelly", memberCode: "Carol-Kelly", party: null, participation: "Staon" },
    ]);
  });

  it("returns ok:false when a later votes page fails", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return jsonResponse({
          results: [
            {
              division: {
                uri: "urn:vote:1",
                voteId: "1",
                date: "2026-01-01",
                subject: { showAs: "First" },
              },
            },
            {
              division: {
                uri: "urn:vote:2",
                voteId: "2",
                date: "2026-01-02",
                subject: { showAs: "Second" },
              },
            },
          ],
        });
      }
      return jsonResponse({ results: [] }, 500);
    });

    const result = await fetchOireachtasVotes("2026-01-01", "2026-01-31", fetchImpl, { limit: 2 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/votes|HTTP 500/i);
  });
});
