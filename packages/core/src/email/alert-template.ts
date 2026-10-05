export type AlertEmailInput = {
  representativeName: string;
  headline: string;
  explanation: string;
  sourceUrl: string;
  sourceLabel: string;
  manageUrl: string;
  unsubscribeUrl: string;
  unsubscribeApiUrl: string;
  replyTo: string;
  locale?: "en" | "ga";
};

export function renderAlertEmail(input: AlertEmailInput) {
  const copy = input.locale === "ga"
    ? {
        source: "Foinse",
        reply: "Freagair an ríomhphost seo chun ceist leantach a chur.",
        manage: "Bainistigh foláirimh",
        unsubscribe: "Díliostáil",
      }
    : {
        source: "Source",
        reply: "Reply to this email to ask a follow-up question.",
        manage: "Manage alerts",
        unsubscribe: "Unsubscribe",
      };
  const subject = `${input.representativeName}: ${input.headline}`;
  const text = [
    input.headline,
    "",
    input.explanation,
    "",
    `${copy.source}: ${input.sourceLabel}`,
    input.sourceUrl,
    "",
    copy.reply,
    `${copy.manage}: ${input.manageUrl}`,
    `${copy.unsubscribe}: ${input.unsubscribeUrl}`,
    "Parliamentary records: Houses of the Oireachtas Open Data API, reused under the Open Data PSI Licence (CC BY 4.0).",
    "DáilDex is an independent service and is not affiliated with the Houses of the Oireachtas.",
  ].join("\n");
  const html = `<!doctype html><html lang="${input.locale === "ga" ? "ga" : "en"}"><body style="font-family:Arial,sans-serif;line-height:1.6;color:#17202a">
    <h1 style="font-size:24px">${escapeHtml(input.headline)}</h1>
    <p>${escapeHtml(input.explanation)}</p>
    <p><strong>${copy.source}:</strong> <a href="${escapeHtml(input.sourceUrl)}">${escapeHtml(input.sourceLabel)}</a></p>
    <p>${copy.reply}</p>
    <hr><p style="font-size:13px"><a href="${escapeHtml(input.manageUrl)}">${copy.manage}</a> · <a href="${escapeHtml(input.unsubscribeUrl)}">${copy.unsubscribe}</a></p>
    <p style="font-size:12px;color:#59636e">Parliamentary records: <a href="https://api.oireachtas.ie/">Houses of the Oireachtas Open Data API</a>, reused under the <a href="https://www.oireachtas.ie/en/open-data/license/">Open Data PSI Licence (CC BY 4.0)</a>. DáilDex is an independent service and is not affiliated with the Houses of the Oireachtas.</p>
  </body></html>`;
  return {
    subject,
    text,
    html,
    replyTo: input.replyTo,
    unsubscribeApiUrl: input.unsubscribeApiUrl,
  };
}

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
