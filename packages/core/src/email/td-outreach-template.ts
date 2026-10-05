export type TdOutreachInput = {
  siteUrl: string;
  tdName: string;
  tdSlug: string;
  constituency: string;
  senderName: string;
};

const ACCENT = "#0f7e3d";
const INK = "#0b151f";
const MUTED = "#44565d";
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";

// One-off introduction to sitting TDs. Deliberately plain: a personal letter, not a campaign.
// Everything under "What we're building" is not live yet and is worded as an offer of early access.
export function renderTdOutreachEmail(input: TdOutreachInput) {
  const site = input.siteUrl.replace(/\/$/, "");
  const utm = "utm_source=email&utm_medium=outreach&utm_campaign=td-intro-2026-09";
  const pageUrl = `${site}/td/${input.tdSlug}?${utm}`;
  const followUrl = `${site}/follow?td=${encodeURIComponent(input.tdSlug)}&${utm}`;
  const homeUrl = `${site}/?${utm}`;

  const subject = `Your Dáil record, in plain English: an introduction to DáilDex`;
  const greeting = `Dear Deputy ${input.tdName},`;

  const blocks: Block[] = [
    { p: `My name is ${input.senderName} and I'm writing to introduce DáilDex, an independent, non-partisan website that helps people follow what happens in the Oireachtas.` },
    { p: `We take the official record from the Houses of the Oireachtas open data service and explain it in plain English. Every claim links back to its source.` },
    { p: `Your page is already live. It shows your recent votes, parliamentary questions and contributions to debates:`, link: { href: pageUrl, text: `Your DáilDex page` } },
    { h: "What DáilDex does today" },
    {
      list: [
        `People in ${input.constituency} can follow you by email. When you vote, speak or table a question, they get a short alert with a link to the official source.`,
        `Dex, our assistant, answers questions about Irish politics in plain English, using real Tá/Níl vote tallies.`,
        `Daily news at 07:00 and 18:00. A story is only published if every quote in it appears in the source it cites.`,
        `Free guides in English and Irish, used by CSPE and Politics and Society students.`,
      ],
    },
    { h: "What we're building for TDs, and where you come in" },
    { p: `We want to build the next part with TDs' offices rather than for them. All of it will be free and the same for every TD, whatever their party:` },
    {
      list: [
        `A verified page. You or your staff sign in with your official @oireachtas.ie address and your page shows that your office uses DáilDex.`,
        `A weekly "My week in the Dáil" card, with your votes and questions and the official sources, ready for your social media each Friday.`,
        `Follower insights: how many constituents follow you and which issues they care about most. We will only ever show totals, never anything that could identify a person.`,
        `Later, "In their own words": a short, clearly labelled note under a vote explaining your position. It will sit beneath the official record and never replace it.`,
      ],
    },
    { p: `We'd really welcome your help. If you'd like your office to be one of the first to try these features, or you'd like to tell us what would be useful, just reply. We'd also be glad to arrange a short call with you or a member of your staff.` },
    { p: `If anything on your page is wrong or missing, please let us know and we'll correct it. And if you'd like constituents to follow your work, this link opens DáilDex with you already selected:`, link: { href: followUrl, text: `Follow Deputy ${input.tdName} on DáilDex` } },
  ];

  const signoff = ["Go raibh maith agat,", input.senderName, "DáilDex"];
  const footer = `DáilDex is independent. It is not affiliated with any political party or with the Houses of the Oireachtas. This is a one-off email sent to your public Oireachtas address. Reply "no more" and we won't contact you again.`;

  const text = [
    greeting,
    "",
    ...blocks.flatMap((block) => {
      if ("h" in block) return [block.h.toUpperCase(), ""];
      if ("list" in block) return [...block.list.map((item) => `- ${item}`), ""];
      return [block.p, ...(block.link ? [block.link.href] : []), ""];
    }),
    ...signoff,
    homeUrl,
    "",
    "—",
    footer,
  ].join("\n");

  const body = blocks
    .map((block) => {
      if ("h" in block) {
        return `<p style="margin:28px 0 10px 0;font-size:16px;font-weight:700;color:${INK}">${escapeHtml(block.h)}</p>`;
      }
      if ("list" in block) {
        return `<ul style="margin:0 0 16px 0;padding-left:20px">${block.list
          .map((item) => `<li style="margin:0 0 8px 0">${escapeHtml(item)}</li>`)
          .join("")}</ul>`;
      }
      const link = block.link
        ? `<br><a href="${escapeHtml(block.link.href)}" style="color:${ACCENT};font-weight:700">${escapeHtml(block.link.text)}&nbsp;&rarr;</a>`
        : "";
      return `<p style="margin:0 0 16px 0">${escapeHtml(block.p)}${link}</p>`;
    })
    .join("\n");

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#ffffff">
  <div style="max-width:600px;margin:0 auto;padding:28px 20px;font-family:${FONT};font-size:15px;line-height:1.65;color:${INK}">
    <p style="margin:0 0 16px 0">${escapeHtml(greeting)}</p>
    ${body}
    <p style="margin:24px 0 0 0">${signoff.map(escapeHtml).join("<br>")}<br><a href="${escapeHtml(homeUrl)}" style="color:${ACCENT}">daildex.com</a></p>
    <p style="margin:32px 0 0 0;padding-top:16px;border-top:1px solid #e4e8df;font-size:12px;line-height:1.6;color:${MUTED}">${escapeHtml(footer)}</p>
  </div>
</body></html>`;

  return { subject, text, html };
}

type Block = { h: string } | { list: string[] } | { p: string; link?: { href: string; text: string } };

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
