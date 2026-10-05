import { vi } from "vitest";

// Study offer lookups would query Postgres. Default every test to "no offer"; a test can override with vi.mocked(...).
vi.mock("@daildex/core/study/offer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@daildex/core/study/offer")>();
  return {
    ...actual,
    getStudyOfferStatusForProfile: vi.fn(async () => null),
    getStudyOfferStatus: vi.fn(async () => null),
    claimStudyOffer: vi.fn(),
    reserveStudyOfferRequest: vi.fn(async () => undefined),
    releaseStudyOfferRequest: vi.fn(async () => undefined),
  };
});
