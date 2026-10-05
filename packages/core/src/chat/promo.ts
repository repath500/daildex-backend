import type { Database, TransactionDatabase } from "@daildex/db";
import { getDatabase } from "@daildex/db";

type Sql = Database | TransactionDatabase;

/** Blog promo: double Dex daily limits through the end of July 2026 (Ireland). */
export const GAEILGE_BLOG_PROMO = {
  code: "gaeilge-july-2026",
  multiplier: 2,
  source: "blog-training-irish-open-models",
  /** End of July 2026 in Ireland (IST, UTC+1). */
  expiresAt: new Date("2026-07-31T23:59:59+01:00"),
} as const;

export type PromoRedeemOutcome =
  | "redeemed"
  | "already_redeemed"
  | "no_dex_pass"
  | "promo_expired"
  | "invalid_email";

export type PromoRedeemResult = {
  outcome: PromoRedeemOutcome;
  email: string;
  dailyLimit?: number;
  expiresAt?: string;
  message: string;
};

export function isGaeilgePromoActive(now = new Date()) {
  return now.getTime() <= GAEILGE_BLOG_PROMO.expiresAt.getTime();
}

export async function logPromoEmailAttempt(
  input: {
    email: string;
    promoCode: string;
    source: string;
    outcome: PromoRedeemOutcome;
  },
  database: Sql = getDatabase(),
) {
  await database`
    INSERT INTO chat_promo_email_log (email, promo_code, source, outcome)
    VALUES (${input.email}, ${input.promoCode}, ${input.source}, ${input.outcome})
  `;
}

export async function getActivePromoMultiplier(
  email: string,
  database: Sql = getDatabase(),
  now = new Date(),
) {
  const rows = await database<{ multiplier: number; expires_at: Date }[]>`
    SELECT multiplier, expires_at
    FROM chat_promo_claims
    WHERE email = ${email}
      AND expires_at >= ${now}
    ORDER BY expires_at DESC
    LIMIT 1
  `;
  const claim = rows[0];
  if (!claim) return { multiplier: 1, expiresAt: null as Date | null };
  return { multiplier: claim.multiplier, expiresAt: claim.expires_at };
}

export async function redeemGaeilgeBlogPromo(
  emailInput: string,
  database: Sql = getDatabase(),
  now = new Date(),
): Promise<PromoRedeemResult> {
  const email = emailInput.trim().toLowerCase();
  const source = GAEILGE_BLOG_PROMO.source;

  if (!email || !email.includes("@") || email.length > 254) {
    await logPromoEmailAttempt(
      { email: email || "invalid", promoCode: GAEILGE_BLOG_PROMO.code, source, outcome: "invalid_email" },
      database,
    );
    return {
      outcome: "invalid_email",
      email,
      message: "Enter the exact email you use with Dex.",
    };
  }

  if (!isGaeilgePromoActive(now)) {
    await logPromoEmailAttempt(
      { email, promoCode: GAEILGE_BLOG_PROMO.code, source, outcome: "promo_expired" },
      database,
    );
    return {
      outcome: "promo_expired",
      email,
      message: "This July double-limit offer has ended.",
    };
  }

  const profiles = await database<{ id: string; cloud_training_consent: boolean }[]>`
    SELECT id, cloud_training_consent FROM chat_profiles WHERE email = ${email} LIMIT 1
  `;
  const profile = profiles[0];

  if (!profile) {
    await logPromoEmailAttempt(
      { email, promoCode: GAEILGE_BLOG_PROMO.code, source, outcome: "no_dex_pass" },
      database,
    );
    return {
      outcome: "no_dex_pass",
      email,
      message:
        "We saved that email. Open Dex with this exact address first, then redeem again to unlock double limits.",
    };
  }

  const existing = await database<{ id: string; expires_at: Date }[]>`
    SELECT id, expires_at
    FROM chat_promo_claims
    WHERE email = ${email} AND promo_code = ${GAEILGE_BLOG_PROMO.code}
    LIMIT 1
  `;

  if (existing[0] && existing[0].expires_at.getTime() >= now.getTime()) {
    await logPromoEmailAttempt(
      { email, promoCode: GAEILGE_BLOG_PROMO.code, source, outcome: "already_redeemed" },
      database,
    );
    const base = profile.cloud_training_consent ? 100 : 50;
    return {
      outcome: "already_redeemed",
      email,
      dailyLimit: base * GAEILGE_BLOG_PROMO.multiplier,
      expiresAt: existing[0].expires_at.toISOString(),
      message: "This email already has double Dex limits through the end of July.",
    };
  }

  await database`
    INSERT INTO chat_promo_claims (email, promo_code, multiplier, expires_at, profile_id, source)
    VALUES (
      ${email},
      ${GAEILGE_BLOG_PROMO.code},
      ${GAEILGE_BLOG_PROMO.multiplier},
      ${GAEILGE_BLOG_PROMO.expiresAt},
      ${profile.id},
      ${source}
    )
    ON CONFLICT (email, promo_code) DO UPDATE SET
      multiplier = EXCLUDED.multiplier,
      expires_at = EXCLUDED.expires_at,
      profile_id = EXCLUDED.profile_id,
      updated_at = now()
  `;

  await logPromoEmailAttempt(
    { email, promoCode: GAEILGE_BLOG_PROMO.code, source, outcome: "redeemed" },
    database,
  );

  const base = profile.cloud_training_consent ? 100 : 50;
  return {
    outcome: "redeemed",
    email,
    dailyLimit: base * GAEILGE_BLOG_PROMO.multiplier,
    expiresAt: GAEILGE_BLOG_PROMO.expiresAt.toISOString(),
    message: "Done. Double Dex limits are active on this email until 31 July 2026.",
  };
}
