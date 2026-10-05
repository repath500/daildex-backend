import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ profile: vi.fn() }));
vi.mock("../chat/service", () => ({ ensureAccountProfileId: mocks.profile }));
vi.mock("@daildex/db", () => ({ getDatabase: () => { throw new Error("tests must inject a database"); } }));
vi.unmock("./offer"); // the global setup mocks this module for every other test
import { claimStudyOffer, getStudyOfferStatus, isStudyOfferOpen, releaseStudyOfferRequest, reserveStudyOfferRequest, STUDY_OCTOBER_OFFER, StudyOfferError } from "./offer";

type Call = { sql: string; values: unknown[] };
function fakeDatabase(replies: unknown[][]) {
  const calls: Call[] = [];
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => { calls.push({ sql: strings.join("?").replace(/\s+/g, " ").trim(), values }); return Promise.resolve(replies.shift() ?? []); };
  return { database: run as never, calls };
}
const login = { subject: "auth0|1", email: "a@example.com", firstName: "A" };
const inOctober = new Date("2026-10-15T12:00:00Z");
beforeEach(() => { vi.clearAllMocks(); mocks.profile.mockResolvedValue("profile-1"); });

describe("October Study offer", () => {
  it("is open for the whole of October in Irish time and closed either side", () => {
    expect(isStudyOfferOpen(new Date("2026-09-30T22:59:59Z"))).toBe(false); // 23:59:59 IST on 30 September
    expect(isStudyOfferOpen(new Date("2026-09-30T23:00:00Z"))).toBe(true); // midnight IST, 1 October
    expect(isStudyOfferOpen(new Date("2026-10-31T23:59:59Z"))).toBe(true); // last second, GMT
    expect(isStudyOfferOpen(new Date("2026-11-01T00:00:00Z"))).toBe(false);
  });
  it("claims once per account and reports an active offer with today's usage", async () => {
    const { database, calls } = fakeDatabase([[], [{ claimed_at: inOctober }], [{ request_count: 4 }]]);
    const status = await claimStudyOffer(login, database, inOctober);
    expect(calls[0].sql).toContain("ON CONFLICT (profile_id, offer) DO NOTHING");
    expect(calls[0].values).toEqual(["profile-1", STUDY_OCTOBER_OFFER.code]);
    expect(status).toMatchObject({ open: true, claimed: true, active: true, usedToday: 4, dailyRequests: STUDY_OCTOBER_OFFER.dailyRequests });
  });
  it("refuses to claim after the offer ends, and is inactive when unclaimed", async () => {
    await expect(claimStudyOffer(login, fakeDatabase([]).database, new Date("2026-11-02T00:00:00Z"))).rejects.toBeInstanceOf(StudyOfferError);
    expect(await getStudyOfferStatus(login, fakeDatabase([[], []]).database, inOctober)).toMatchObject({ claimed: false, active: false, usedToday: 0 });
  });
  it("counts requests against a daily cap instead of Dex messages, and gives back failed ones", async () => {
    const ok = fakeDatabase([[{ request_count: 1 }]]);
    await reserveStudyOfferRequest("profile-1", ok.database);
    expect(ok.calls[0].sql).toContain("request_count < ?"); expect(ok.calls[0].values).toContain(STUDY_OCTOBER_OFFER.dailyRequests);
    await expect(reserveStudyOfferRequest("profile-1", fakeDatabase([[]]).database)).rejects.toMatchObject({ status: 429, code: "OFFER_DAILY_LIMIT" });
    const release = fakeDatabase([[]]);
    await releaseStudyOfferRequest("profile-1", release.database);
    expect(release.calls[0].sql).toContain("GREATEST(request_count - 1, 0)");
  });
});
