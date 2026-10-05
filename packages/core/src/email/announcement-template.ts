export type AnnouncementTemplateInput = {
  siteUrl: string;
  firstName?: string | null;
};

// Hex equivalents of the tokens.css brand colours; email clients do not support oklch.
const ACCENT = "#0f7e3d";
const ACCENT_DEEP = "#00481e";
const INK = "#0b151f";
const MUTED = "#44565d";
const PAPER = "#fbf8f0";
const WASH = "#e0f1db";
const RULE = "#e4e8df";
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";

const stats = [
  { value: "234", label: "TDs and Senators to follow" },
  { value: "44", label: "guides, in English and Irish" },
  { value: "2×", label: "daily news from the record" },
] as const;

const features = [
  {
    title: "Follow your TDs, by email",
    body: "Pick the TDs and Senators you care about. When they vote, speak or ask a question, you get a short alert with the source attached.",
    path: "/follow",
    link: "Choose who to follow",
  },
  {
    title: "Ask Dex anything about Irish politics",
    body: "Plain-English answers you can check, with charts, quizzes and real Tá/Níl vote tallies. Free, and no login needed.",
    path: "/chat",
    link: "Talk to Dex",
  },
  {
    title: "Daily news, checked against the record",
    body: "Short stories at 07:00 and 18:00. If a quote isn’t on the page it cites, the story doesn’t go out.",
    path: "/news",
    link: "Read today’s news",
  },
  {
    title: "Learn, and watch",
    body: "Guides for CSPE and Politics and Society, fair party comparisons, and short narrated films on housing and the courts.",
    path: "/learn",
    link: "Start learning",
  },
] as const;

export function normaliseFirstName(value: string | null | undefined): string | null {
  const name = value?.trim().split(/\s+/)[0];
  if (!name || !/^\p{L}[\p{L}'’-]{0,39}$/u.test(name)) return null;
  return name.charAt(0).toLocaleUpperCase("en-IE") + name.slice(1);
}

export function renderLaunchAnnouncementEmail(input: AnnouncementTemplateInput) {
  const site = input.siteUrl.replace(/\/$/, "");
  const url = (path: string) => `${site}${path}?utm_source=email&utm_medium=announcement&utm_campaign=launch-2026-09`;
  const name = normaliseFirstName(input.firstName);

  const subject = name ? `${name}, DáilDex is finally here` : "DáilDex is finally here";
  const preheader = "Follow your TDs, ask Dex anything, and read the Dáil in plain English.";
  const greeting = name ? `Hi ${name},` : "Hi there,";
  const intro =
    "You signed up early, so you’re hearing it first. DáilDex turns the official Oireachtas record into plain English: what your TDs voted for, what they said, and what it means. Every claim comes with a source.";

  const text = [
    greeting,
    "",
    "DáilDex is finally here.",
    "",
    intro.replaceAll("’", "'"),
    "",
    `Open DáilDex: ${url("/")}`,
    "",
    ...features.flatMap((feature, index) => [
      `${index + 1}. ${feature.title}`,
      feature.body.replaceAll("’", "'"),
      `${feature.link}: ${url(feature.path)}`,
      "",
    ]),
    "Everything that was free stays free. Dex Pro is optional, at €10 a month, if you want deep research and a study coach.",
    `See everything that's new: ${url("/blog/big-autumn-update")}`,
    "",
    "If anything looks wrong, just reply and tell us. We read every one.",
    "",
    "Go raibh maith agat,",
    "The DáilDex team",
    "",
    "—",
    "You're getting this because you have a DáilDex account or email alerts. This is a one-off launch note, not a newsletter. Reply \"unsubscribe\" and we won't send another.",
  ].join("\n");

  const statCells = stats
    .map(
      (stat) => `
              <td class="stat" width="33%" valign="top" style="padding:0 6px;text-align:center">
                <p style="margin:0;font-family:${FONT};font-size:28px;line-height:1.1;font-weight:800;letter-spacing:-0.02em;color:${ACCENT_DEEP}">${stat.value}</p>
                <p style="margin:6px 0 0 0;font-family:${FONT};font-size:12px;line-height:1.4;color:${MUTED}">${escapeHtml(stat.label)}</p>
              </td>`,
    )
    .join("");

  const featureRows = features
    .map(
      (feature, index) => `
            <tr>
              <td width="44" valign="top" style="padding:0 0 26px 0">
                <div style="width:32px;height:32px;line-height:32px;border-radius:10px;background:${WASH};color:${ACCENT_DEEP};font-family:${FONT};font-size:13px;font-weight:800;text-align:center">0${index + 1}</div>
              </td>
              <td valign="top" style="padding:0 0 26px 0">
                <p style="margin:4px 0 6px 0;font-family:${FONT};font-size:17px;line-height:1.35;font-weight:700;color:${INK}">${escapeHtml(feature.title)}</p>
                <p style="margin:0 0 8px 0;font-family:${FONT};font-size:15px;line-height:1.6;color:${MUTED}">${escapeHtml(feature.body)}</p>
                <a href="${escapeHtml(url(feature.path))}" style="font-family:${FONT};font-size:15px;font-weight:700;color:${ACCENT};text-decoration:none">${escapeHtml(feature.link)}&nbsp;&rarr;</a>
              </td>
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
    .stat{display:block!important;width:100%!important;padding:0 0 16px 0!important}
  }
</style>
</head>
<body style="margin:0;padding:0;background:${PAPER};-webkit-text-size-adjust:100%">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(preheader)}&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAPER}">
    <tr><td align="center" style="padding:28px 12px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#ffffff;border-radius:20px;overflow:hidden;border:1px solid ${RULE}">

        <tr><td style="background:#000000;padding:0;line-height:0">
          <a href="${escapeHtml(url("/media"))}"><img src="${escapeHtml(`${site}/assets/daildex-intro-poster.jpg`)}" width="600" alt="DáilDex. It’s here." style="display:block;width:100%;max-width:600px;height:auto;border:0"></a>
        </td></tr>

        <tr><td class="px" style="background:#000000;padding:30px 40px 36px 40px">
          <p style="margin:0 0 10px 0;font-family:${FONT};font-size:15px;font-weight:600;color:#8fd6a4">${escapeHtml(greeting)}</p>
          <h1 class="h1" style="margin:0 0 16px 0;font-family:${FONT};font-size:36px;line-height:1.1;font-weight:800;letter-spacing:-0.025em;color:#ffffff">DáilDex is finally here.</h1>
          <p style="margin:0 0 26px 0;font-family:${FONT};font-size:16px;line-height:1.65;color:#c9d3cf">${escapeHtml(intro)}</p>
          <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
            <td style="border-radius:999px;background:#3ccf6e">
              <a href="${escapeHtml(url("/"))}" style="display:inline-block;white-space:nowrap;padding:15px 28px;font-family:${FONT};font-size:16px;font-weight:800;color:${INK};text-decoration:none;border-radius:999px">Open DáilDex&nbsp;&rarr;</a>
            </td>
            <td style="padding-left:18px">
              <a href="${escapeHtml(url("/media"))}" style="font-family:${FONT};font-size:15px;font-weight:600;color:#ffffff;text-decoration:underline;white-space:nowrap">Watch the film</a>
            </td>
          </tr></table>
        </td></tr>

        <tr><td class="px" style="background:${WASH};padding:24px 34px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>${statCells}
          </tr></table>
        </td></tr>

        <tr><td class="px" style="padding:36px 40px 10px 40px">
          <p style="margin:0 0 22px 0;font-family:${FONT};font-size:12px;font-weight:800;letter-spacing:0.12em;text-transform:uppercase;color:${ACCENT}">What you can do today</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${featureRows}
          </table>
        </td></tr>

        <tr><td class="px" style="padding:0 40px 32px 40px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
            <td style="background:${PAPER};border:1px solid ${RULE};border-radius:14px;padding:20px 22px">
              <p style="margin:0 0 6px 0;font-family:${FONT};font-size:16px;line-height:1.4;font-weight:700;color:${INK}">Everything that was free stays free.</p>
              <p style="margin:0;font-family:${FONT};font-size:15px;line-height:1.6;color:${MUTED}">Dex Pro is optional, at €10 a month, if you want deep research and a study coach. <a href="${escapeHtml(url("/blog/big-autumn-update"))}" style="color:${ACCENT};font-weight:700;text-decoration:none">See everything that’s new&nbsp;&rarr;</a></p>
            </td>
          </tr></table>
        </td></tr>

        <tr><td class="px" style="padding:0 40px 40px 40px">
          <p style="margin:0 0 14px 0;font-family:${FONT};font-size:16px;line-height:1.65;color:${INK}">If anything looks wrong, just reply and tell us. We read every one.</p>
          <p style="margin:0;font-family:${FONT};font-size:16px;line-height:1.65;color:${INK}">Go raibh maith agat,<br><strong>The DáilDex team</strong></p>
        </td></tr>
      </table>

      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px">
        <tr><td style="padding:22px 28px 8px 28px;font-family:${FONT};font-size:12px;line-height:1.65;color:${MUTED};text-align:center">
          You’re getting this because you have a DáilDex account or email alerts. This is a one-off launch note, not a newsletter. Reply “unsubscribe” and we won’t send another.<br>
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
