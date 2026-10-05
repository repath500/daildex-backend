import { LAUNCH_PRO_WEEK } from "@daildex/shared";
import { normaliseFirstName } from "./announcement-template";

export type LaunchWeekTemplateInput = {
  siteUrl: string;
  firstName?: string | null;
};

// Hex equivalents of the brand colours; email clients do not support oklch.
const GREEN = "#00481e";
const GREEN_ACCENT = "#0f7e3d";
const ON_GREEN = "#dbe9df";
const RULE_ON_GREEN = "#2f6a48";
const INK = "#0b151f";
const MUTED = "#44565d";
const PAPER = "#fbf8f0";
const RULE = "#e4e8df";
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";

const models = [
  { name: "Claude Opus 5.5", note: "Most capable in Dex", isNew: false },
  { name: "GPT 6 Astra", note: "Flagship reasoning", isNew: false },
  { name: "GPT 6.1 Sol", note: "Clear reasoning", isNew: false },
  { name: "Kimi K3", note: "Frontier model", isNew: false },
  { name: "Claude Sonnet 5.5", note: "Upgraded from Sonnet 5", isNew: true },
  { name: "Grok 4.7", note: "Direct explanations", isNew: false },
  { name: "GLM 5.3", note: "Frontier analysis", isNew: false },
  { name: "GLM 5.3 Prime", note: "Pro-only", isNew: true },
  { name: "Qwen 3.8 Max Prime", note: "Pro-only", isNew: true },
  { name: "MiMo V2.6 Pro Ultraspeed", note: "Pro-only", isNew: true },
  { name: "Fugu Ultra V2", note: "Pro-only", isNew: true },
  { name: "MiMo V2.6 Pro", note: "Cloud-agreement model", isNew: true },
  { name: "Fugu Max", note: "Cloud-agreement model", isNew: true },
] as const;

const perks = [
  { title: "Documents you can keep", body: "Notes, briefings, legal memos, speeches, or a letter to your TD, as Word, PDF or Markdown (/doc)." },
  { title: "Deep research", body: "Longer investigations across the Oireachtas record and trusted Irish sources (/deep)." },
  { title: "Fact-checks", body: "Test a claim against the record, with dated evidence (/factcheck)." },
  { title: "A study coach", body: "Exam practice for CSPE and Politics and Society, with marking (/exam)." },
  { title: "Irish legal research", body: "Cited to the Act, section or article. Information, not legal advice." },
  { title: "500 messages a day", body: "Ten times the free allowance." },
] as const;

export function renderLaunchWeekEmail(input: LaunchWeekTemplateInput) {
  const site = input.siteUrl.replace(/\/$/, "");
  const url = (path: string) => `${site}${path}${path.includes("?") ? "&" : "?"}utm_source=email&utm_medium=announcement&utm_campaign=${LAUNCH_PRO_WEEK.code}`;
  const name = normaliseFirstName(input.firstName);
  const claim = url("/auth/login?returnTo=%2Fchat&screen_hint=signup");
  const blog = url("/blog/dex-pro-free-week");

  const subject = name
    ? `${name}, Dex Pro is free this week: Claude Opus 5.5, Kimi K3 and more`
    : "Dex Pro is free this week: Claude Opus 5.5, Kimi K3 and more";
  const preheader = `Sign in by ${LAUNCH_PRO_WEEK.endsLabel} and every model is yours. No card needed.`;
  const greeting = name ? `Hi ${name},` : "Hi there,";
  const intro = `For one week, every signed-in Dex account gets Dex Pro free. That means Claude Opus 5.5, GPT 6 Astra, GPT 6.1 Sol, Kimi K3, Claude Sonnet 5.5, Grok 4.7 and GLM 5.3, plus four Pro-only models we have just added (GLM 5.3 Prime, Qwen 3.8 Max Prime, MiMo V2.6 Pro Ultraspeed and Fugu Ultra V2), with 500 messages a day.`;

  const text = [
    greeting,
    "",
    "Dex Pro is free for a week.",
    "",
    intro,
    "",
    `When: ${LAUNCH_PRO_WEEK.startsLabel} to the end of ${LAUNCH_PRO_WEEK.endsLabel} (Irish time).`,
    "How: sign in to Dex. Pro switches on by itself. No card, nothing to cancel.",
    `Claim it: ${claim}`,
    "",
    "The models:",
    ...models.map((model) => `- ${model.name}${model.isNew ? " (new)" : ""}: ${model.note}`),
    "",
    "Everything else Pro does:",
    ...perks.map((perk) => `- ${perk.title}: ${perk.body}`),
    "",
    "After the week your account goes back to the free plan on its own. Your chats stay.",
    `Read the details: ${blog}`,
    "",
    "Go raibh maith agat,",
    "The DáilDex team",
    "",
    "—",
    "You're getting this because you have a DáilDex account or email alerts. This is a one-off announcement, not a newsletter. Reply \"unsubscribe\" and we won't send another.",
  ].join("\n");

  const modelRows = models
    .map(
      (model) => `
            <tr>
              <td style="padding:10px 0;border-bottom:1px solid ${RULE_ON_GREEN}">
                <span style="font-family:${FONT};font-size:16px;font-weight:700;color:#ffffff">${escapeHtml(model.name)}</span>${model.isNew ? `<span style="font-family:${FONT};font-size:13px;font-weight:700;color:#8fe0ac">&nbsp;new</span>` : ""}
                <span style="font-family:${FONT};font-size:14px;color:${ON_GREEN}">&nbsp;&nbsp;${escapeHtml(model.note)}</span>
              </td>
            </tr>`,
    )
    .join("");

  const perkRows = perks
    .map(
      (perk) => `
            <tr>
              <td width="26" valign="top" style="padding:0 0 12px 0;font-family:${FONT};font-size:16px;font-weight:800;color:${GREEN_ACCENT}">&#10003;</td>
              <td valign="top" style="padding:0 0 14px 0;font-family:${FONT};font-size:15px;line-height:1.55;color:${MUTED}"><strong style="color:${INK}">${escapeHtml(perk.title)}.</strong> ${escapeHtml(perk.body)}</td>
            </tr>`,
    )
    .join("");

  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light">
<title>${escapeHtml(subject)}</title>
<style>
  @media (max-width:600px){
    .px{padding-left:22px!important;padding-right:22px!important}
    .h1{font-size:34px!important}
  }
</style>
</head>
<body style="margin:0;padding:0;background:${PAPER};-webkit-text-size-adjust:100%">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(preheader)}&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAPER}">
    <tr><td align="center" style="padding:28px 12px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#ffffff;border-radius:20px;overflow:hidden;border:1px solid ${RULE}">

        <tr><td class="px" bgcolor="${GREEN}" style="background:${GREEN};padding:44px 40px 30px 40px">
          <p style="margin:0 0 14px 0;font-family:${FONT};font-size:15px;font-weight:600;color:#8fe0ac">${escapeHtml(greeting)}</p>
          <h1 class="h1" style="margin:0 0 18px 0;font-family:${FONT};font-size:42px;line-height:1.04;font-weight:800;letter-spacing:-0.035em;color:#ffffff">Every model in Dex is open until Monday&nbsp;5&nbsp;October.</h1>
          <p style="margin:0 0 26px 0;font-family:${FONT};font-size:16px;line-height:1.65;color:${ON_GREEN}">${escapeHtml(intro)}</p>
          <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
            <td style="border-radius:8px;background:${PAPER}">
              <a href="${escapeHtml(claim)}" style="display:inline-block;white-space:nowrap;padding:15px 28px;font-family:${FONT};font-size:16px;font-weight:800;color:${GREEN};text-decoration:none;border-radius:8px">Claim free Pro</a>
            </td>
            <td style="padding-left:20px">
              <a href="${escapeHtml(blog)}" style="font-family:${FONT};font-size:15px;font-weight:600;color:#ffffff;text-decoration:underline;white-space:nowrap">Read the details</a>
            </td>
          </tr></table>
          <p style="margin:18px 0 0 0;font-family:${FONT};font-size:13px;color:${ON_GREEN}">${escapeHtml(LAUNCH_PRO_WEEK.startsLabel)} to ${escapeHtml(LAUNCH_PRO_WEEK.endsLabel)}. Sign-in required, no card.</p>
        </td></tr>

        <tr><td class="px" bgcolor="${GREEN}" style="background:${GREEN};padding:6px 40px 38px 40px">
          <p style="margin:0 0 4px 0;font-family:${FONT};font-size:18px;font-weight:800;color:#ffffff">The models you get</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid #ffffff">${modelRows}
          </table>
        </td></tr>

        <tr><td class="px" style="padding:34px 40px 8px 40px">
          <p style="margin:0 0 16px 0;font-family:${FONT};font-size:18px;font-weight:800;color:${INK}">And everything else Pro does</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${perkRows}
          </table>
        </td></tr>

        <tr><td class="px" style="padding:6px 40px 32px 40px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
            <td style="background:${PAPER};border:1px solid ${RULE};border-radius:14px;padding:20px 22px">
              <p style="margin:0 0 6px 0;font-family:${FONT};font-size:16px;line-height:1.4;font-weight:700;color:${INK}">Then it goes back on its own.</p>
              <p style="margin:0;font-family:${FONT};font-size:15px;line-height:1.6;color:${MUTED}">After ${escapeHtml(LAUNCH_PRO_WEEK.endsLabel)} your account returns to the free plan. Your chats stay. If you want to keep Pro, it is &euro;10 a month. <a href="${escapeHtml(blog)}" style="color:${GREEN};font-weight:700;text-decoration:none">Read the details&nbsp;&rarr;</a></p>
            </td>
          </tr></table>
        </td></tr>

        <tr><td class="px" style="padding:0 40px 40px 40px">
          <p style="margin:0;font-family:${FONT};font-size:16px;line-height:1.65;color:${INK}">Go raibh maith agat,<br><strong>The DáilDex team</strong></p>
        </td></tr>
      </table>

      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px">
        <tr><td style="padding:22px 28px 8px 28px;font-family:${FONT};font-size:12px;line-height:1.65;color:${MUTED};text-align:center">
          You’re getting this because you have a DáilDex account or email alerts. This is a one-off announcement, not a newsletter. Reply “unsubscribe” and we won’t send another.<br>
          DáilDex explains Oireachtas activity using official public records. · <a href="${escapeHtml(`${site}/privacy`)}" style="color:${MUTED}">Privacy</a>
        </td></tr>
      </table>
    </td></tr>
  </table>
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
