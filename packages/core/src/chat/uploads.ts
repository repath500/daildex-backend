import type { Database, TransactionDatabase } from "@daildex/db";
import { getDatabase } from "@daildex/db";
import { hasLaunchProAccess } from "@daildex/shared";
import { getTokenPepper } from "../config";
import { hashOpaqueToken } from "../security/tokens";
import { ChatAccessError, isProActive } from "./service";
import { FREE_UPLOADS_PER_WEEK, UPLOAD_WINDOW_DAYS as WINDOW_DAYS, uploadAllowance, type UploadAllowance } from "./upload-limits";

export { FREE_UPLOADS_PER_CHAT, FREE_UPLOADS_PER_WEEK, uploadAllowance, type UploadAllowance } from "./upload-limits";

export type UploadFile = { fingerprint: string; mediaType: string; bytes: number };

type ProfileRow = { id: string; plan: string; pro_until: Date | null; auth_subject: string | null };

async function usedThisWeek(database: Database | TransactionDatabase, profileId: string) {
  const rows = await database<{ count: number }[]>`
    SELECT count(DISTINCT fingerprint)::INTEGER AS count
    FROM chat_upload_events
    WHERE profile_id = ${profileId} AND created_at > now() - make_interval(days => ${WINDOW_DAYS})
  `;
  return rows[0]?.count ?? 0;
}

export async function getUploadAllowance(token: string, database: Database = getDatabase()): Promise<UploadAllowance> {
  const tokenHash = hashOpaqueToken(token, getTokenPepper());
  const rows = await database<ProfileRow[]>`SELECT id, plan, pro_until, auth_subject FROM chat_profiles WHERE token_hash = ${tokenHash}`;
  const profile = rows[0];
  if (!profile) throw new ChatAccessError("This Dex pass is no longer valid.", 401, "INVALID_TOKEN");
  const pro = isProActive(profile) || hasLaunchProAccess(profile);
  return uploadAllowance(pro, await usedThisWeek(database, profile.id));
}

/**
 * Record the files in a request. A fingerprint already seen this week is not counted again, so
 * follow-up messages in the same chat (which resend earlier files) cost nothing. Throws when
 * the free weekly allowance would be exceeded.
 */
export async function reserveUploads(token: string, files: UploadFile[], database: Database = getDatabase()): Promise<UploadAllowance> {
  const tokenHash = hashOpaqueToken(token, getTokenPepper());
  return database.begin(async (transaction) => {
    const profiles = await transaction<ProfileRow[]>`
      SELECT id, plan, pro_until, auth_subject FROM chat_profiles WHERE token_hash = ${tokenHash} FOR UPDATE
    `;
    const profile = profiles[0];
    if (!profile) throw new ChatAccessError("This Dex pass is no longer valid.", 401, "INVALID_TOKEN");
    const pro = isProActive(profile) || hasLaunchProAccess(profile);

    await transaction`DELETE FROM chat_upload_events WHERE profile_id = ${profile.id} AND created_at < now() - interval '30 days'`;

    const unique = [...new Map(files.map((file) => [file.fingerprint, file])).values()];
    const known = unique.length
      ? await transaction<{ fingerprint: string }[]>`
          SELECT DISTINCT fingerprint FROM chat_upload_events
          WHERE profile_id = ${profile.id}
            AND created_at > now() - make_interval(days => ${WINDOW_DAYS})
            AND fingerprint IN ${transaction(unique.map((file) => file.fingerprint))}
        `
      : [];
    const knownSet = new Set(known.map((row) => row.fingerprint));
    const fresh = unique.filter((file) => !knownSet.has(file.fingerprint));
    const used = await usedThisWeek(transaction, profile.id);

    if (!pro && used + fresh.length > FREE_UPLOADS_PER_WEEK) {
      const left = Math.max(0, FREE_UPLOADS_PER_WEEK - used);
      throw new ChatAccessError(
        left === 0
          ? `You have used all ${FREE_UPLOADS_PER_WEEK} free uploads for this week. Dex Pro has no upload limit.`
          : `Only ${left} free ${left === 1 ? "upload is" : "uploads are"} left this week. Remove a file or go Pro for unlimited uploads.`,
        429,
        "UPLOAD_LIMIT_REACHED",
      );
    }

    for (const file of fresh) {
      await transaction`
        INSERT INTO chat_upload_events (profile_id, fingerprint, media_type, bytes)
        VALUES (${profile.id}, ${file.fingerprint}, ${file.mediaType.slice(0, 80)}, ${Math.min(file.bytes, 2_000_000_000)})
      `;
    }
    return uploadAllowance(pro, used + fresh.length);
  });
}
