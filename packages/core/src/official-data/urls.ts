const OIREACHTAS_SITE = "https://www.oireachtas.ie";

/**
 * API `uri` values point at data.oireachtas.ie identifiers (often 403 in a browser).
 * Map them to the public www.oireachtas.ie pages users can open.
 * Direct PDF/XML file URLs on data.oireachtas.ie are left as-is.
 */
export function toPublicOireachtasUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }

  if (url.protocol !== "https:") return undefined;

  const host = url.hostname.replace(/^www\./, "");
  if (host === "oireachtas.ie") return url.toString();

  if (host !== "data.oireachtas.ie") return url.toString();

  // Published files (PDFs, XML) are browsable; bare resource ids are not.
  if (/\.(pdf|xml)$/i.test(url.pathname)) return url.toString();

  const path = url.pathname.replace(/\/+$/, "");

  const bill = path.match(/^\/ie\/oireachtas\/bill\/(\d{4})\/(\d+)$/);
  if (bill) return `${OIREACHTAS_SITE}/en/bills/bill/${bill[1]}/${bill[2]}/`;

  const vote = path.match(/^\/ie\/oireachtas\/division\/house\/(dail|seanad)\/(\d+)\/(\d{4}-\d{2}-\d{2})\/vote_(\d+)$/);
  if (vote) return `${OIREACHTAS_SITE}/en/debates/vote/${vote[1]}/${vote[2]}/${vote[3]}/${vote[4]}/`;

  const debate = path.match(/^\/akn\/ie\/debateRecord\/(dail|seanad)\/(\d{4}-\d{2}-\d{2})\/debate(?:\/(?:main|dbsect_(\d+)))?$/);
  if (debate) {
    const base = `${OIREACHTAS_SITE}/en/debates/debate/${debate[1]}/${debate[2]}/`;
    return debate[3] ? `${base}#dbsect_${debate[3]}` : base;
  }

  const question = path.match(/^\/ie\/oireachtas\/question\/(\d{4}-\d{2}-\d{2})\/pq_(\d+)$/);
  if (question) return `${OIREACHTAS_SITE}/en/debates/question/${question[1]}/${question[2]}/`;

  // A written-answers section id is not the question number, so open that day's answers.
  const writtens = path.match(/^\/akn\/ie\/debateRecord\/(?:dail|seanad)\/(\d{4}-\d{2}-\d{2})\/writtens(?:\/dbsect_\d+)?$/);
  if (writtens) return `${OIREACHTAS_SITE}/en/debates/question/${writtens[1]}/`;

  const member = path.match(/^\/ie\/oireachtas\/member\/id\/([^/]+)$/);
  if (member) return `${OIREACHTAS_SITE}/en/members/member/${member[1]}/`;

  return undefined;
}

/**
 * The link an alert email shows. Questions use their own public page when the
 * record carries the question URI; everything else maps through
 * toPublicOireachtasUrl, keeping the original only when no public page is known.
 */
export function publicAlertSourceUrl(sourceUrl: string, questionUri?: string | null): string {
  return toPublicOireachtasUrl(questionUri) ?? toPublicOireachtasUrl(sourceUrl) ?? sourceUrl;
}
