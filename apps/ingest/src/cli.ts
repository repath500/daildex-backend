import { closeDatabase } from "@daildex/db";
import { syncDebates, syncLegislation, syncMembers, syncQuestions, syncVotes } from "./oireachtas";
import { ingestPolicyManifest } from "./policy";

const command = process.argv[2];

try {
  if (command === "members") {
    console.log(await syncMembers());
  } else if (command === "votes") {
    const end = process.env.INGEST_DATE_END ?? new Date().toISOString().slice(0, 10);
    const startDate = new Date(`${end}T00:00:00Z`);
    startDate.setUTCDate(startDate.getUTCDate() - 2);
    const start = process.env.INGEST_DATE_START ?? startDate.toISOString().slice(0, 10);
    console.log(await syncVotes(start, end));
  } else if (command === "questions" || command === "debates") {
    const end = process.env.INGEST_DATE_END ?? new Date().toISOString().slice(0, 10);
    const startDate = new Date(`${end}T00:00:00Z`);
    startDate.setUTCDate(startDate.getUTCDate() - 2);
    const start = process.env.INGEST_DATE_START ?? startDate.toISOString().slice(0, 10);
    console.log(command === "questions" ? await syncQuestions(start, end) : await syncDebates(start, end));
  } else if (command === "legislation") {
    const end = process.env.INGEST_DATE_END ?? new Date().toISOString().slice(0, 10);
    const startDate = new Date(`${end}T00:00:00Z`);
    startDate.setUTCDate(startDate.getUTCDate() - 30);
    const start = process.env.INGEST_DATE_START ?? startDate.toISOString().slice(0, 10);
    console.log(await syncLegislation(start, end));
  } else if (command === "backfill") {
    // Walks a date range in 14-day windows so one slow window cannot lose the rest; safe to re-run
    // (every record is upserted by its official id). Example:
    //   npm run ingest:backfill -- votes 2024-11-29 2026-05-25
    const [kind, start, end = new Date().toISOString().slice(0, 10)] = process.argv.slice(3);
    const sync = kind === "votes" ? syncVotes : kind === "questions" ? syncQuestions : kind === "debates" ? syncDebates : null;
    const isDate = (value: string | undefined): value is string => /^\d{4}-\d{2}-\d{2}$/.test(value ?? "");
    if (!sync || !isDate(start) || !isDate(end) || start > end) {
      throw new Error("Usage: cli.ts backfill votes|questions|debates YYYY-MM-DD [YYYY-MM-DD]");
    }
    for (let cursor = new Date(`${start}T00:00:00Z`); cursor <= new Date(`${end}T00:00:00Z`);) {
      const windowEnd = new Date(Math.min(cursor.getTime() + 13 * 86_400_000, new Date(`${end}T00:00:00Z`).getTime()));
      const from = cursor.toISOString().slice(0, 10);
      const to = windowEnd.toISOString().slice(0, 10);
      console.log(from, to, await sync(from, to));
      cursor = new Date(windowEnd.getTime() + 86_400_000);
    }
  } else if (command === "policy") {
    if (!process.env.POLICY_MANIFEST_PATH) throw new Error("POLICY_MANIFEST_PATH is required");
    console.log(await ingestPolicyManifest(process.env.POLICY_MANIFEST_PATH));
  } else {
    throw new Error("Usage: cli.ts members|votes|questions|debates|legislation|backfill|policy");
  }
} finally {
  await closeDatabase();
}
