import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { getEmailProvider, hashOpaqueToken, renderTdOutreachEmail } from "@daildex/core";

// One-off introduction email to sitting TDs. Dry run by default: prints the audience and
// writes a preview. Pass --send to deliver, --test=<email> to send one copy, --only=a@x,b@y
// to restrict the list, --as=<slug> to pick which TD a test copy is written for, --limit=N to send only the next N. Successful sends are logged to --log so a re-run skips them.
const CAMPAIGN = "td-intro-2026-09";

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.replace(/^--/, "").split("=");
    return [key, rest.length ? rest.join("=") : "true"] as const;
  }),
);
const siteUrl = process.env.APP_BASE_URL ?? "https://www.daildex.com";
const from = process.env.OUTREACH_FROM_EMAIL ?? "DáilDex <hello@daildex.com>";
const cc = (args.get("cc") ?? "repath500@gmail.com").split(",").filter(Boolean);
const replyTo = args.get("reply-to") ?? cc[0];
const logPath = args.get("log") ?? "td-outreach-sent.log";

type Recipient = { name: string; email: string; constituency: string; slug: string };

function required(name: string): string {
  const value = args.get(name);
  if (!value || value === "true") throw new Error(`--${name}=... is required`);
  return value;
}

async function main() {
  const senderName = required("sender");
  const all = JSON.parse(readFileSync(required("recipients"), "utf8")) as Recipient[];
  const only = args.get("only")?.toLowerCase().split(",").map((email) => email.trim());
  const alreadySent = new Set(existsSync(logPath) ? readFileSync(logPath, "utf8").split("\n").filter(Boolean) : []);

  const render = (td: Recipient) =>
    renderTdOutreachEmail({ siteUrl, tdName: td.name, tdSlug: td.slug, constituency: td.constituency, senderName });

  const previewPath = args.get("preview") ?? "td-outreach-preview.html";
  writeFileSync(previewPath, render(all[0]).html);
  writeFileSync(previewPath.replace(/\.html$/, ".txt"), render(all[0]).text);

  const testRecipient = args.get("test");
  const audience = testRecipient
    ? [{ ...(all.find((td) => td.slug === args.get("as")) ?? all[0]), email: testRecipient }]
    : all
        .filter((td) => (!only || only.includes(td.email)) && !alreadySent.has(td.email))
        .slice(0, args.has("limit") ? Number(args.get("limit")) : undefined);

  console.log(`From: ${from}  CC: ${testRecipient ? "(none for test)" : cc.join(", ")}  Reply-To: ${replyTo}`);
  console.log(`Audience: ${audience.length} recipient(s), ${alreadySent.size} already sent`);
  for (const td of audience) console.log(`  ${td.email}  (${td.name}, ${td.constituency})`);

  if (!args.has("send") && !testRecipient) {
    console.log(`\nDry run. Preview written to ${previewPath}. Re-run with --send to deliver.`);
    return;
  }

  const provider = getEmailProvider(from);
  let sent = 0;
  for (const td of audience) {
    const email = render(td);
    // Stable id doubles as the Resend idempotency key, so a re-run within 24h cannot double-send.
    const id = `${CAMPAIGN}-${hashOpaqueToken(td.email, CAMPAIGN).slice(0, 24)}${testRecipient ? `-test-${Date.now()}` : ""}`;
    try {
      const result = await provider.send({ id, recipient: td.email, replyTo, cc: testRecipient ? [] : cc, ...email });
      sent += 1;
      if (!testRecipient) appendFileSync(logPath, `${td.email}\n`);
      console.log(`sent ${td.email} ${result.providerMessageId}`);
    } catch (error) {
      console.error(`failed ${td.email}: ${error instanceof Error ? error.message : error}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  console.log(`\nDone: ${sent}/${audience.length} sent.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
