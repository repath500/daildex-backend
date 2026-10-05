import type { Database } from "@daildex/db";
import { getDatabase } from "@daildex/db";
import { ensureAccountProfileId, type AccountLogin } from "../chat/service";

/**
 * October 2026 launch offer: accounts that claim it can use the cloud opt-in models (normally unlocked by cloud-training
 * consent or Pro) inside Dex Study, and Study requests don't use their Dex daily messages. Study material is still never
 * used for training. A generous daily fair-use cap keeps costs bounded.
 */
export const STUDY_OCTOBER_OFFER = {
  code: "study-october-2026",
  /** 1 October 2026 00:00 in Ireland (IST, UTC+1). */
  startsAt: new Date("2026-10-01T00:00:00+01:00"),
  /** 31 October 2026 23:59:59 in Ireland (GMT after clocks go back on 25 October). */
  endsAt: new Date("2026-10-31T23:59:59+00:00"),
  dailyRequests: 150,
} as const;

export class StudyOfferError extends Error {
  constructor(message: string, readonly status: number, readonly code: "OFFER_NOT_ACTIVE" | "OFFER_DAILY_LIMIT") {
    super(message);
  }
}

export type StudyOfferStatus = {
  code: string;
  /** The offer window is open now. */
  open: boolean;
  /** This account has claimed it. */
  claimed: boolean;
  /** Claimed and open: Study uses the offer instead of Dex messages. */
  active: boolean;
  usedToday: number;
  dailyRequests: number;
  endsAt: string;
};

export function isStudyOfferOpen(now = new Date()) {
  return now >= STUDY_OCTOBER_OFFER.startsAt && now <= STUDY_OCTOBER_OFFER.endsAt;
}

async function status(profileId: string, database: Database, now: Date): Promise<StudyOfferStatus> {
  const [claims, usage] = await Promise.all([
    database<{ claimed_at: Date }[]>`SELECT claimed_at FROM study_offer_claims WHERE profile_id = ${profileId} AND offer = ${STUDY_OCTOBER_OFFER.code}`,
    database<{ request_count: number }[]>`
      SELECT request_count FROM study_offer_usage
      WHERE profile_id = ${profileId} AND offer = ${STUDY_OCTOBER_OFFER.code} AND usage_date = (now() AT TIME ZONE 'UTC')::DATE
    `,
  ]);
  const open = isStudyOfferOpen(now), claimed = Boolean(claims[0]);
  return { code: STUDY_OCTOBER_OFFER.code, open, claimed, active: open && claimed, usedToday: usage[0]?.request_count ?? 0, dailyRequests: STUDY_OCTOBER_OFFER.dailyRequests, endsAt: STUDY_OCTOBER_OFFER.endsAt.toISOString() };
}

export async function getStudyOfferStatus(login: AccountLogin, database: Database = getDatabase(), now = new Date()) {
  return status(await ensureAccountProfileId(login, database), database, now);
}
export async function getStudyOfferStatusForProfile(profileId: string, database: Database = getDatabase(), now = new Date()) {
  return status(profileId, database, now);
}

/** Claim once per account; claiming again is a no-op. Only while the offer is open. */
export async function claimStudyOffer(login: AccountLogin, database: Database = getDatabase(), now = new Date()) {
  if (!isStudyOfferOpen(now)) throw new StudyOfferError("This offer has ended.", 410, "OFFER_NOT_ACTIVE");
  const profileId = await ensureAccountProfileId(login, database);
  await database`
    INSERT INTO study_offer_claims (profile_id, offer) VALUES (${profileId}, ${STUDY_OCTOBER_OFFER.code})
    ON CONFLICT (profile_id, offer) DO NOTHING
  `;
  return status(profileId, database, now);
}

/** Count one Study request against the offer's daily fair-use cap (instead of the Dex daily allowance). */
export async function reserveStudyOfferRequest(profileId: string, database: Database = getDatabase()) {
  const rows = await database<{ request_count: number }[]>`
    INSERT INTO study_offer_usage (profile_id, offer, usage_date, request_count)
    VALUES (${profileId}, ${STUDY_OCTOBER_OFFER.code}, (now() AT TIME ZONE 'UTC')::DATE, 1)
    ON CONFLICT (profile_id, offer, usage_date) DO UPDATE SET request_count = study_offer_usage.request_count + 1, updated_at = now()
    WHERE study_offer_usage.request_count < ${STUDY_OCTOBER_OFFER.dailyRequests}
    RETURNING request_count
  `;
  if (!rows[0]) throw new StudyOfferError(`You’ve used today’s ${STUDY_OCTOBER_OFFER.dailyRequests} Study requests on the October offer. It resets at midnight UTC.`, 429, "OFFER_DAILY_LIMIT");
}

/** Give back a request that delivered nothing. */
export async function releaseStudyOfferRequest(profileId: string, database: Database = getDatabase()) {
  await database`
    UPDATE study_offer_usage SET request_count = GREATEST(request_count - 1, 0), updated_at = now()
    WHERE profile_id = ${profileId} AND offer = ${STUDY_OCTOBER_OFFER.code} AND usage_date = (now() AT TIME ZONE 'UTC')::DATE
  `;
}
