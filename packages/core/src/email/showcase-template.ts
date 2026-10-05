import { normaliseFirstName } from "./announcement-template";

export type ShowcaseTemplateInput = {
  siteUrl: string;
  firstName?: string | null;
};

export const SHOWCASE_CAMPAIGN = "showcase-2026-10";
export const SHOWCASE_URL = "https://data.gov.ie/en_GB/showcase/daildex-making-irish-parliamentary-open-data-accessible";

// Hex equivalents of the brand colours; email clients do not support oklch.
const ACCENT = "#0f7e3d";
const ACCENT_DEEP = "#00481e";
const INK = "#0b151f";
const MUTED = "#44565d";
const PAPER = "#fbf8f0";
const WASH = "#e0f1db";
const RULE = "#e4e8df";
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";

const points = [
  {
    title: "What it is",
    body: "data.gov.ie is the Irish Government’s open data portal. Its Showcase section highlights projects that use public data to build something useful. DáilDex is now one of them.",
  },
  {
    title: "What it means",
    body: "Independent, official recognition that turning the Oireachtas record into plain English is a worthwhile use of open data. It does not change how DáilDex works, and it is not a government service.",
  },
  {
    title: "What stays the same",
    body: "Your alerts, Dex and the guides stay free. Every claim still links back to the official record, which remains the authority.",
  },
] as const;

const studyIntro =
  "We’re also excited to open Dex Study, a private study desk for anyone learning how Irish politics works. Keep your sources in one place, then read, ask Dex to teach you, practise and revise.";
const studyPoints = [
  "Learning paths: Irish politics from scratch, Politics & Society, CSPE, and researching Irish politics and law.",
  "Dex as a tutor that works only from your sources and cites the passage behind every answer.",
  "Practice checks and revision cards that come back when they’re due, in English or Irish.",
  "Your progress stays on your device.",
] as const;

export function renderShowcaseEmail(input: ShowcaseTemplateInput) {
  const site = input.siteUrl.replace(/\/$/, "");
  const url = (path: string) => `${site}${path}?utm_source=email&utm_medium=announcement&utm_campaign=${SHOWCASE_CAMPAIGN}`;
  const name = normaliseFirstName(input.firstName);

  const subject = name ? `${name}, DáilDex is featured on data.gov.ie` : "DáilDex is featured on data.gov.ie";
  const preheader = "We’re in the official Open Data Showcase. Here’s what that means for you.";
  const greeting = name ? `Hi ${name},` : "Hi there,";
  const intro =
    "A bit of good news to share. DáilDex has been featured in the official Showcase on data.gov.ie, the Irish Government’s open data portal, as an example of what can be built with Oireachtas open data.";
  const thanks = "You signed up early, and that is a big part of why it’s worth building. Thank you.";

  const text = [
    greeting,
    "",
    "DáilDex is featured on data.gov.ie.",
    "",
    intro.replaceAll("’", "'"),
    "",
    `See the showcase entry: ${SHOWCASE_URL}`,
    "",
    ...points.flatMap((point) => [point.title, point.body.replaceAll("’", "'"), ""]),
    "Also new: Dex Study",
    studyIntro.replaceAll("’", "'"),
    ...studyPoints.map((point) => `- ${point.replaceAll("’", "'")}`),
    `Try Dex Study: ${url("/study")}`,
    "",
    `Read the full story on our blog: ${url("/blog/featured-on-data-gov-ie")}`,
    `Open DáilDex: ${url("/")}`,
    "",
    thanks.replaceAll("’", "'"),
    "",
    "Go raibh maith agat,",
    "The DáilDex team",
    "",
    "—",
    "You're getting this because you have a DáilDex account or email alerts. This is a one-off note, not a newsletter. Reply \"unsubscribe\" and we won't send another.",
  ].join("\n");

  const pointRows = points
    .map(
      (point) => `
            <tr><td style="padding:0 0 22px 0">
              <p style="margin:0 0 6px 0;font-family:${FONT};font-size:17px;line-height:1.35;font-weight:700;color:${INK}">${escapeHtml(point.title)}</p>
              <p style="margin:0;font-family:${FONT};font-size:15px;line-height:1.6;color:${MUTED}">${escapeHtml(point.body)}</p>
            </td></tr>`,
    )
    .join("");

  const studyRows = studyPoints
    .map(
      (point) => `
                <tr>
                  <td width="22" valign="top" style="padding:0 0 8px 0;font-family:${FONT};font-size:15px;font-weight:800;color:${ACCENT}">&#10003;</td>
                  <td valign="top" style="padding:0 0 8px 0;font-family:${FONT};font-size:15px;line-height:1.55;color:${MUTED}">${escapeHtml(point)}</td>
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
    .h1{font-size:30px!important}
  }
</style>
</head>
<body style="margin:0;padding:0;background:${PAPER};-webkit-text-size-adjust:100%">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(preheader)}&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAPER}">
    <tr><td align="center" style="padding:28px 12px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#ffffff;border-radius:20px;overflow:hidden;border:1px solid ${RULE}">

        <tr><td class="px" bgcolor="${ACCENT_DEEP}" style="background:${ACCENT_DEEP};padding:40px 40px 38px 40px">
          <p style="margin:0 0 10px 0;font-family:${FONT};font-size:15px;font-weight:600;color:#8fe0ac">${escapeHtml(greeting)}</p>
          <p style="margin:0 0 14px 0;font-family:${FONT};font-size:12px;font-weight:800;letter-spacing:0.12em;text-transform:uppercase;color:#8fe0ac">As featured on data.gov.ie</p>
          <h1 class="h1" style="margin:0 0 16px 0;font-family:${FONT};font-size:34px;line-height:1.1;font-weight:800;letter-spacing:-0.025em;color:#ffffff">DáilDex is in the official Open Data Showcase.</h1>
          <p style="margin:0 0 26px 0;font-family:${FONT};font-size:16px;line-height:1.65;color:#dbe9df">${escapeHtml(intro)}</p>
          <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
            <td style="border-radius:999px;background:${PAPER}">
              <a href="${escapeHtml(SHOWCASE_URL)}" style="display:inline-block;white-space:nowrap;padding:15px 28px;font-family:${FONT};font-size:16px;font-weight:800;color:${ACCENT_DEEP};text-decoration:none;border-radius:999px">See the showcase entry&nbsp;&rarr;</a>
            </td>
          </tr></table>
        </td></tr>

        <tr><td class="px" style="padding:36px 40px 10px 40px">
          <p style="margin:0 0 22px 0;font-family:${FONT};font-size:12px;font-weight:800;letter-spacing:0.12em;text-transform:uppercase;color:${ACCENT}">What this means</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${pointRows}
          </table>
        </td></tr>

        <tr><td class="px" style="padding:6px 40px 32px 40px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
            <td style="background:${PAPER};border:1px solid ${RULE};border-radius:14px;padding:24px 24px 20px 24px">
              <p style="margin:0 0 8px 0;font-family:${FONT};font-size:12px;font-weight:800;letter-spacing:0.12em;text-transform:uppercase;color:${ACCENT}">Also new</p>
              <p style="margin:0 0 10px 0;font-family:${FONT};font-size:20px;line-height:1.3;font-weight:800;color:${INK}">Meet Dex Study</p>
              <p style="margin:0 0 14px 0;font-family:${FONT};font-size:15px;line-height:1.6;color:${MUTED}">${escapeHtml(studyIntro)}</p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${studyRows}
              </table>
              <p style="margin:8px 0 0 0"><a href="${escapeHtml(url("/study"))}" style="font-family:${FONT};font-size:15px;font-weight:700;color:${ACCENT};text-decoration:none">Try Dex Study&nbsp;&rarr;</a></p>
            </td>
          </tr></table>
        </td></tr>

        <tr><td class="px" style="padding:0 40px 32px 40px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
            <td style="background:${WASH};border-radius:14px;padding:20px 22px">
              <p style="margin:0;font-family:${FONT};font-size:15px;line-height:1.6;color:${ACCENT_DEEP}">${escapeHtml(thanks)} <a href="${escapeHtml(url("/blog/featured-on-data-gov-ie"))}" style="color:${ACCENT_DEEP};font-weight:700">Read the full story on our blog&nbsp;&rarr;</a></p>
            </td>
          </tr></table>
        </td></tr>

        <tr><td class="px" style="padding:0 40px 40px 40px">
          <p style="margin:0;font-family:${FONT};font-size:16px;line-height:1.65;color:${INK}">Go raibh maith agat,<br><strong>The DáilDex team</strong></p>
        </td></tr>
      </table>

      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px">
        <tr><td style="padding:22px 28px 8px 28px;font-family:${FONT};font-size:12px;line-height:1.65;color:${MUTED};text-align:center">
          You’re getting this because you have a DáilDex account or email alerts. This is a one-off note, not a newsletter. Reply “unsubscribe” and we won’t send another.<br>
          DáilDex is an independent project and is not run by or affiliated with the Government. · <a href="${escapeHtml(`${site}/privacy`)}" style="color:${MUTED}">Privacy</a>
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
