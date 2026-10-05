import { createHash } from "node:crypto";
import type { Database } from "@daildex/db";
import { getDatabase } from "@daildex/db";
import { STUDENT_DEAL, studentDealKey } from "@daildex/shared/student-deal";
import { ensureAccountProfileId, isProActive, type AccountLogin } from "./service";

export type StudentDealAccount = {
  profileId: string;
  stripeCustomerId: string | null;
  /** Already on a paid Pro plan, so a second subscription would double-bill them. */
  proActive: boolean;
  /** This account, or an account with the same university mailbox, has already used the deal. */
  claimed: boolean;
};

/** Claims are counted per college mailbox and stored as a hash, so the address itself isn't retained. */
export function studentDealEmailKey(email: string): string {
  const key = studentDealKey(email) ?? email.trim().toLocaleLowerCase("en-IE");
  return createHash("sha256").update(key, "utf8").digest("hex");
}

/** A claim is held a little longer than the Stripe session it belongs to stays open. */
const HOLD_MINUTES = STUDENT_DEAL.checkoutWindowMinutes + 3;

/** Where this signed-in account stands with the student deal. Links or creates the account's chat profile. */
export async function getStudentDealAccount(login: AccountLogin, database: Database = getDatabase()): Promise<StudentDealAccount> {
  const profileId = await ensureAccountProfileId(login, database);
  const [profiles, claims] = await Promise.all([
    database<{ plan: string; pro_until: Date | null; stripe_customer_id: string | null }[]>`
      SELECT plan, pro_until, stripe_customer_id FROM chat_profiles WHERE id = ${profileId}
    `,
    database<{ id: string }[]>`
      SELECT id FROM student_deal_claims
      WHERE deal = ${STUDENT_DEAL.code} AND status = 'claimed' AND (profile_id = ${profileId} OR email_key = ${studentDealEmailKey(login.email)})
    `,
  ]);
  const profile = profiles[0];
  return {
    profileId,
    stripeCustomerId: profile?.stripe_customer_id ?? null,
    proActive: profile ? isProActive(profile) : false,
    claimed: claims.length > 0,
  };
}

export type StudentDealReservation =
  | { status: "reserved"; id: string }
  | { status: "claimed" }
  /** Another checkout for this account or mailbox is still open. */
  | { status: "in_progress" };

/**
 * Hold the deal for this person before a checkout is created, atomically, so several checkouts can't be opened (and
 * paid) in parallel. The hold lapses on its own if the checkout is abandoned, and is turned into a claim by
 * {@link recordStudentDealClaim} once Stripe reports the payment.
 */
export async function reserveStudentDeal(
  input: { profileId: string; email: string },
  database: Database = getDatabase(),
): Promise<StudentDealReservation> {
  const emailKey = studentDealEmailKey(input.email);
  await database`
    DELETE FROM student_deal_claims
    WHERE deal = ${STUDENT_DEAL.code} AND status = 'pending' AND reserved_until < now()
      AND (profile_id = ${input.profileId} OR email_key = ${emailKey})
  `;
  const inserted = await database<{ id: string }[]>`
    INSERT INTO student_deal_claims (profile_id, deal, email_key, status, reserved_until)
    VALUES (${input.profileId}, ${STUDENT_DEAL.code}, ${emailKey}, 'pending', now() + make_interval(mins => ${HOLD_MINUTES}))
    ON CONFLICT DO NOTHING
    RETURNING id
  `;
  if (inserted[0]) return { status: "reserved", id: inserted[0].id };
  const holders = await database<{ status: string }[]>`
    SELECT status FROM student_deal_claims
    WHERE deal = ${STUDENT_DEAL.code} AND (profile_id = ${input.profileId} OR email_key = ${emailKey})
  `;
  return holders.some((holder) => holder.status === "claimed") ? { status: "claimed" } : { status: "in_progress" };
}

/** Drop a hold when its checkout couldn't be created, so the person can try again straight away. */
export async function releaseStudentDealReservation(id: string, database: Database = getDatabase()) {
  await database`DELETE FROM student_deal_claims WHERE id = ${id} AND status = 'pending'`;
}

/**
 * Record that a checkout using the student deal completed. Idempotent: it turns this account's hold into a claim, or
 * inserts one if the hold is gone, and a claim that already exists for the same mailbox is left alone rather than
 * failing the webhook. Returns whether this call recorded a new claim.
 */
export async function recordStudentDealClaim(
  input: { profileId: string; email: string; sessionId?: string | null },
  database: Database = getDatabase(),
) {
  const emailKey = studentDealEmailKey(input.email);
  const upgraded = await database<{ id: string }[]>`
    UPDATE student_deal_claims
    SET status = 'claimed', reserved_until = NULL, stripe_session_id = ${input.sessionId ?? null}, claimed_at = now()
    WHERE deal = ${STUDENT_DEAL.code} AND profile_id = ${input.profileId} AND email_key = ${emailKey} AND status = 'pending'
    RETURNING id
  `;
  if (upgraded.length > 0) return true;
  const rows = await database<{ id: string }[]>`
    INSERT INTO student_deal_claims (profile_id, deal, email_key, status, stripe_session_id)
    SELECT id, ${STUDENT_DEAL.code}::TEXT, ${emailKey}::TEXT, 'claimed', ${input.sessionId ?? null}::TEXT FROM chat_profiles WHERE id = ${input.profileId}
    ON CONFLICT DO NOTHING
    RETURNING id
  `;
  return rows.length > 0;
}
