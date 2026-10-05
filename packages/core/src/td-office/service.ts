import { createHmac, timingSafeEqual } from "node:crypto";
import { getDatabase, type Database } from "@daildex/db";
import { AppError } from "@daildex/shared";
import { z } from "zod";
import { getAppBaseUrl, getTokenPepper } from "../config";
import { enforceHourlyRateLimit } from "../security/rate-limit";
import { createOpaqueToken, hashOpaqueToken } from "../security/tokens";

/** Aggregates below this are shown as "fewer than", so no follower can be singled out. */
export const TD_OFFICE_MIN_AGGREGATE = 5;
export const TD_OFFICE_SESSION_DAYS = 30;
const LOGIN_TTL_MINUTES = 30;

export const tdOfficeLoginRequestSchema = z.strictObject({
  representativeId: z.string().trim().min(1).max(160),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(254)
    .email()
    .refine((value) => value.endsWith("@oireachtas.ie"), "Use an @oireachtas.ie address."),
  locale: z.enum(["en", "ga"]).default("en"),
});

export type TdOfficeLoginRequest = z.input<typeof tdOfficeLoginRequestSchema>;

function letters(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

/**
 * True when an Oireachtas address looks like the TD's own, e.g.
 * aengus.osnodaigh@ for Aengus Ó Snodaigh or conor.mcguinness@ for Conor D. McGuinness.
 * Only these addresses become owners and earn the public badge.
 */
export function isOwnerEmail(representativeName: string, email: string): boolean {
  const [local, domain] = email.toLowerCase().split("@");
  if (domain !== "oireachtas.ie" || !local) return false;
  const words = representativeName.trim().split(/\s+/).map(letters).filter(Boolean);
  if (words.length < 2) return false;
  const first = words[0];
  const surname = words.at(-1)!;
  const localLetters = letters(local);
  const hasSurname = localLetters.includes(surname);
  const hasFirst = localLetters.includes(first) || localLetters.startsWith(`${first[0]}${words.slice(1).join("")}`);
  return hasSurname && hasFirst;
}

export async function requestTdOfficeLogin(
  input: TdOfficeLoginRequest,
  requestKeys: readonly string[] = [],
  database: Database = getDatabase(),
): Promise<{ accepted: true }> {
  const parsed = tdOfficeLoginRequestSchema.parse(input);
  for (const key of new Set([`email:${parsed.email}`, ...requestKeys])) {
    await enforceHourlyRateLimit(
      {
        namespace: "td_office_login",
        key,
        limit: key.startsWith("email:") ? 5 : 20,
        message: "Too many sign-in links requested. Try again in an hour.",
      },
      database,
    );
  }

  const representatives = await database<{ id: string; name: string }[]>`
    SELECT id, name FROM representatives
    WHERE representative_key = ${parsed.representativeId}
      AND status = 'active' AND chamber = 'Dáil' AND role = 'TD'
  `;
  const representative = representatives[0];
  if (!representative) throw new AppError("INVALID_REQUEST", "Choose a sitting TD.", 400);

  const token = createOpaqueToken();
  const tokenHash = hashOpaqueToken(token, getTokenPepper());
  const localePrefix = parsed.locale === "ga" ? "/ga" : "";
  const loginUrl = `${getAppBaseUrl()}${localePrefix}/for-tds/verify?token=${encodeURIComponent(token)}`;
  const email = renderTdOfficeLoginEmail({ loginUrl, representativeName: representative.name, locale: parsed.locale });
  const role = isOwnerEmail(representative.name, parsed.email) ? "owner" : "staff";

  await database.begin(async (transaction) => {
    const members = await transaction<{ id: string; status: string }[]>`
      INSERT INTO td_office_members (representative_id, email, role)
      VALUES (${representative.id}, ${parsed.email}, ${role})
      ON CONFLICT (representative_id, email) DO UPDATE SET role = EXCLUDED.role
      RETURNING id, status
    `;
    const member = members[0];
    // A removed address gets no link, and the reply stays the same so it cannot probe.
    if (!member || member.status === "revoked") return;

    await transaction`
      INSERT INTO td_office_login_tokens (token_hash, member_id, expires_at)
      VALUES (${tokenHash}, ${member.id}, now() + (${LOGIN_TTL_MINUTES} * interval '1 minute'))
    `;
    await transaction`
      INSERT INTO email_outbox (kind, recipient, payload, idempotency_key)
      VALUES ('td_office_login', ${parsed.email}, ${transaction.json(email)}, ${`td-office-login:${tokenHash}`})
    `;
  });

  return { accepted: true };
}

export async function consumeTdOfficeLogin(
  token: string,
  database: Database = getDatabase(),
): Promise<{ memberId: string; sessionVersion: number }> {
  if (!token || token.length > 200) throw new AppError("INVALID_REQUEST", "This sign-in link is not valid.", 400);
  const tokenHash = hashOpaqueToken(token, getTokenPepper());

  return database.begin(async (transaction) => {
    const rows = await transaction<{ member_id: string; status: string; session_version: number }[]>`
      UPDATE td_office_login_tokens login
      SET used_at = now()
      FROM td_office_members member
      WHERE login.token_hash = ${tokenHash}
        AND login.used_at IS NULL
        AND login.expires_at > now()
        AND member.id = login.member_id
      RETURNING login.member_id, member.status, member.session_version
    `;
    const row = rows[0];
    if (!row || row.status === "revoked") {
      throw new AppError("INVALID_REQUEST", "This sign-in link has expired or was already used. Request a new one.", 400);
    }
    await transaction`
      UPDATE td_office_members
      SET status = 'active', verified_at = COALESCE(verified_at, now()), last_login_at = now()
      WHERE id = ${row.member_id}
    `;
    return { memberId: row.member_id, sessionVersion: row.session_version };
  });
}

function sessionSignature(memberId: string, version: number, expiresAt: number, pepper: string): string {
  return createHmac("sha256", pepper).update(`td-office:${memberId}:${version}:${expiresAt}`, "utf8").digest("hex");
}

export function createTdOfficeSession(
  memberId: string,
  sessionVersion: number,
  now = Date.now(),
  pepper = getTokenPepper(),
): string {
  const expiresAt = Math.floor(now / 1000) + TD_OFFICE_SESSION_DAYS * 86_400;
  return `${memberId}.${sessionVersion}.${expiresAt}.${sessionSignature(memberId, sessionVersion, expiresAt, pepper)}`;
}

export function verifyTdOfficeSession(
  value: string | undefined,
  now = Date.now(),
  pepper = getTokenPepper(),
): { memberId: string; sessionVersion: number } | null {
  const parts = value?.split(".") ?? [];
  if (parts.length !== 4) return null;
  const [memberId, versionText, expiresText, signature] = parts;
  const sessionVersion = Number(versionText);
  const expiresAt = Number(expiresText);
  if (!/^[0-9a-f-]{36}$/i.test(memberId) || !Number.isSafeInteger(sessionVersion) || !Number.isSafeInteger(expiresAt)) {
    return null;
  }
  if (expiresAt * 1000 < now) return null;
  const expected = sessionSignature(memberId, sessionVersion, expiresAt, pepper);
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  return { memberId, sessionVersion };
}

export type TdOfficeMember = {
  memberId: string;
  email: string;
  role: "owner" | "staff";
  representative: { id: string; key: string; name: string; area: string; party: string };
};

export async function getTdOfficeMember(
  session: { memberId: string; sessionVersion: number },
  database: Database = getDatabase(),
): Promise<TdOfficeMember | null> {
  const rows = await database<{
    member_id: string;
    email: string;
    role: "owner" | "staff";
    rep_id: string;
    rep_key: string;
    name: string;
    area: string;
    party: string;
  }[]>`
    SELECT member.id AS member_id, member.email::TEXT AS email, member.role,
      representative.id AS rep_id, representative.representative_key AS rep_key,
      representative.name, representative.area, representative.party_name AS party
    FROM td_office_members member
    JOIN representatives representative ON representative.id = member.representative_id
    WHERE member.id = ${session.memberId}
      AND member.status = 'active'
      AND member.session_version = ${session.sessionVersion}
      AND representative.status = 'active'
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    memberId: row.member_id,
    email: row.email,
    role: row.role,
    representative: { id: row.rep_id, key: row.rep_key, name: row.name, area: row.area, party: row.party },
  };
}

/** A count, or null when it is below the aggregate floor. */
function floored(count: number): number | null {
  return count >= TD_OFFICE_MIN_AGGREGATE ? count : null;
}

export type TdOfficeDashboard = {
  followers: number | null;
  newFollowersThisWeek: number | null;
  topics: { tag: string; followers: number }[];
  team: { id: string; email: string; role: "owner" | "staff"; lastLoginAt: string | null }[];
};

export async function getTdOfficeDashboard(
  member: TdOfficeMember,
  database: Database = getDatabase(),
): Promise<TdOfficeDashboard> {
  const [counts] = await database<{ followers: number; new_this_week: number }[]>`
    SELECT count(*)::INT AS followers,
      count(*) FILTER (WHERE follow.created_at > now() - interval '7 days')::INT AS new_this_week
    FROM subscriber_follows follow
    JOIN subscribers subscriber ON subscriber.id = follow.subscriber_id AND subscriber.status = 'active'
    WHERE follow.representative_id = ${member.representative.id}
  `;
  const topics = await database<{ tag: string; followers: number }[]>`
    SELECT tag, count(*)::INT AS followers
    FROM subscriber_follows follow
    JOIN subscribers subscriber ON subscriber.id = follow.subscriber_id AND subscriber.status = 'active'
    CROSS JOIN LATERAL unnest(follow.topic_tags) AS tag
    WHERE follow.representative_id = ${member.representative.id}
    GROUP BY tag
    HAVING count(*) >= ${TD_OFFICE_MIN_AGGREGATE}
    ORDER BY followers DESC, tag
  `;
  const team = await database<{ id: string; email: string; role: "owner" | "staff"; last_login_at: Date | null }[]>`
    SELECT id, email::TEXT AS email, role, last_login_at
    FROM td_office_members
    WHERE representative_id = ${member.representative.id} AND status = 'active'
    ORDER BY role, email
  `;
  const followers = counts?.followers ?? 0;
  return {
    followers: floored(followers),
    newFollowersThisWeek: followers >= TD_OFFICE_MIN_AGGREGATE ? floored(counts?.new_this_week ?? 0) : null,
    topics: followers >= TD_OFFICE_MIN_AGGREGATE ? topics : [],
    team: team.map((row) => ({
      id: row.id,
      email: row.email,
      role: row.role,
      lastLoginAt: row.last_login_at ? row.last_login_at.toISOString() : null,
    })),
  };
}

/** An owner removes another address from their office; that address is signed out at once. */
export async function revokeTdOfficeMember(
  actor: TdOfficeMember,
  targetMemberId: string,
  database: Database = getDatabase(),
): Promise<void> {
  if (actor.role !== "owner") throw new AppError("UNAUTHORIZED", "Only the TD's own address can remove access.", 403);
  if (actor.memberId === targetMemberId) throw new AppError("INVALID_REQUEST", "You cannot remove your own access.", 400);
  const rows = await database<{ id: string }[]>`
    UPDATE td_office_members
    SET status = 'revoked', revoked_at = now(), revoked_by = ${actor.memberId},
      session_version = session_version + 1
    WHERE id = ${targetMemberId} AND representative_id = ${actor.representative.id} AND status <> 'revoked'
    RETURNING id
  `;
  if (!rows[0]) throw new AppError("NOT_FOUND", "That address does not have access.", 404);
}

/** Representative keys whose own Oireachtas address has signed in. */
export async function listVerifiedTdOffices(database: Database = getDatabase()): Promise<string[]> {
  const rows = await database<{ key: string }[]>`
    SELECT DISTINCT representative.representative_key AS key
    FROM td_office_members member
    JOIN representatives representative ON representative.id = member.representative_id
    WHERE member.role = 'owner' AND member.status = 'active'
  `;
  return rows.map((row) => row.key);
}

export function renderTdOfficeLoginEmail(input: {
  loginUrl: string;
  representativeName: string;
  locale?: "en" | "ga";
}) {
  const url = escapeHtml(input.loginUrl);
  const name = escapeHtml(input.representativeName);
  if (input.locale === "ga") {
    const subject = `Nasc sínithe isteach DáilDex d’oifig ${input.representativeName}`;
    const text = [
      `Sínigh isteach i bpainéal oifige DáilDex do ${input.representativeName}:`,
      input.loginUrl,
      "",
      `Rachaidh an nasc in éag i gceann ${LOGIN_TTL_MINUTES} nóiméad agus oibríonn sé uair amháin. Mura ndearna tú an t-iarratas seo, déan neamhaird den ríomhphost.`,
    ].join("\n");
    const html = `<!doctype html>
<html lang="ga"><body style="font-family:Arial,sans-serif;line-height:1.6;color:#17202a">
  <h1 style="font-size:22px">Painéal oifige DáilDex do ${name}</h1>
  <p><a href="${url}" style="display:inline-block;padding:12px 18px;background:#176b47;color:white;border-radius:999px;text-decoration:none">Sínigh isteach</a></p>
  <p>Rachaidh an nasc in éag i gceann ${LOGIN_TTL_MINUTES} nóiméad agus oibríonn sé uair amháin. Mura ndearna tú an t-iarratas seo, déan neamhaird den ríomhphost.</p>
</body></html>`;
    return { subject, text, html };
  }
  const subject = `Your DáilDex sign-in link for ${input.representativeName}'s office`;
  const text = [
    `Sign in to the DáilDex office dashboard for ${input.representativeName}:`,
    input.loginUrl,
    "",
    `The link expires in ${LOGIN_TTL_MINUTES} minutes and works once. If you did not ask for it, ignore this email.`,
  ].join("\n");
  const html = `<!doctype html>
<html lang="en"><body style="font-family:Arial,sans-serif;line-height:1.6;color:#17202a">
  <h1 style="font-size:22px">DáilDex office dashboard for ${name}</h1>
  <p><a href="${url}" style="display:inline-block;padding:12px 18px;background:#176b47;color:white;border-radius:999px;text-decoration:none">Sign in</a></p>
  <p>The link expires in ${LOGIN_TTL_MINUTES} minutes and works once. If you did not ask for it, ignore this email.</p>
</body></html>`;
  return { subject, text, html };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
