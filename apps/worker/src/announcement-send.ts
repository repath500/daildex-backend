import { writeFileSync } from "node:fs";
import {
  getEmailProvider,
  hashOpaqueToken,
  normaliseFirstName,
  renderLaunchAnnouncementEmail,
  suppressionHash,
} from "@daildex/core";
import { getDatabase } from "@daildex/db";

// One-off launch announcement. Dry run by default: prints the audience and writes
// a preview. Pass --send to deliver, --only=a@x.ie,b@y.ie to restrict the audience,
// or --test=<email> to send a single copy.
const CAMPAIGN = "launch-2026-09";

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/, "").split("=");
    return [key, value ?? "true"] as const;
  }),
);
const siteUrl = process.env.APP_BASE_URL ?? "https://www.daildex.com";

type Recipient = { email: string; firstName: string | null };

async function loadAudience(): Promise<Recipient[]> {
  const sql = getDatabase();
  const rows = await sql<{ email: string; first_name: string | null }[]>`
    SELECT lower(email::text) AS email, max(first_name) AS first_name
    FROM (
      SELECT email, NULL::text AS first_name FROM subscribers WHERE status = 'active'
      UNION ALL
      SELECT p.email, p.first_name FROM chat_profiles p
      WHERE NOT EXISTS (
        SELECT 1 FROM subscribers s
        WHERE s.email = p.email AND s.status IN ('unsubscribed', 'suppressed')
      )
    ) audience
    GROUP BY lower(email::text)
    ORDER BY 1
  `;
  const tombstones = new Set(
    (await sql<{ email_hash: string }[]>`SELECT email_hash FROM suppression_tombstones`).map((row) => row.email_hash),
  );
  const only = args.get("only")?.toLowerCase().split(",").map((email) => email.trim());
  return rows
    .filter((row) => !tombstones.has(suppressionHash(row.email)))
    .filter((row) => !only || only.includes(row.email))
    .map((row) => ({ email: row.email, firstName: normaliseFirstName(row.first_name) }));
}

async function main() {
  const preview = renderLaunchAnnouncementEmail({ siteUrl, firstName: "Aoife" });
  const previewPath = args.get("preview") ?? "announcement-preview.html";
  writeFileSync(previewPath, preview.html);

  const testRecipient = args.get("test");
  const audience: Recipient[] = testRecipient ? [{ email: testRecipient, firstName: null }] : await loadAudience();

  console.log(`Audience: ${audience.length} recipient(s)`);
  for (const recipient of audience) {
    const { subject } = renderLaunchAnnouncementEmail({ siteUrl, firstName: recipient.firstName });
    console.log(`  ${recipient.email}  "${subject}"`);
  }

  if (!args.has("send") && !testRecipient) {
    console.log(`\nDry run. Preview written to ${previewPath}. Re-run with --send to deliver.`);
    return;
  }

  const provider = getEmailProvider();
  let sent = 0;
  for (const recipient of audience) {
    const email = renderLaunchAnnouncementEmail({ siteUrl, firstName: recipient.firstName });
    // Stable id doubles as the Resend idempotency key, so a re-run within 24h cannot double-send.
    const id = `${CAMPAIGN}-${hashOpaqueToken(recipient.email, CAMPAIGN).slice(0, 24)}${testRecipient ? `-test-${Date.now()}` : ""}`;
    try {
      const result = await provider.send({ id, recipient: recipient.email, ...email });
      sent += 1;
      console.log(`sent ${recipient.email} ${result.providerMessageId}`);
    } catch (error) {
      console.error(`failed ${recipient.email}: ${error instanceof Error ? error.message : error}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 600));
  }
  console.log(`\nDone: ${sent}/${audience.length} sent.`);
}

main()
  .then(() => getDatabase().end())
  .catch(async (error) => {
    console.error(error);
    await getDatabase().end();
    process.exit(1);
  });
