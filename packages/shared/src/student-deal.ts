/**
 * The student deal: three months of Dex Pro at €3 a month (€9 in all, less than one regular €10 month) for anyone
 * who signs up and verifies a university email address. After the three months it renews at the regular price
 * unless cancelled, and each person can claim it once.
 */
export const STUDENT_DEAL = {
  code: "student-3-for-3-2026",
  months: 3,
  monthlyPriceEur: 3,
  regularPriceEur: 10,
  /** Stripe coupon taking the regular €10 price down to €3, for the first three billing periods. */
  couponId: "daildex-student-3-for-3",
  amountOffCents: 700,
  /** How long a Stripe Checkout session for the deal stays open. The claim is held a few minutes longer than this. */
  checkoutWindowMinutes: 32,
} as const;

/** What the three months cost in total, in euro. */
export const STUDENT_DEAL_TOTAL_EUR = STUDENT_DEAL.months * STUDENT_DEAL.monthlyPriceEur;

/**
 * Registered domains of Irish universities, technological universities and higher-education colleges.
 * A mail domain counts when it equals one of these or is a subdomain of it, so `mail.dcu.ie`, `umail.ucc.ie`
 * and `student.ncirl.ie` all match without being listed. Derived from the open JetBrains `swot` list plus the
 * student-mail domains the colleges publish.
 */
const IRISH_COLLEGE_DOMAINS = [
  "ait.ie", "atu.ie", "cct.ie", "cit.ie", "dbs.ie", "dcu.ie", "dit.ie", "dkit.ie", "gcd.ie", "gmit.ie", "griffith.ie",
  "iadt.ie", "itb.ie", "itcarlow.ie", "itsligo.ie", "ittdublin.ie", "ittralee.ie", "lit.ie", "lsb.ie", "lyit.ie",
  "may.ie", "mie.ie", "mtu.ie", "mu.ie", "mumail.ie", "mycit.ie", "mydbs.ie", "mydit.ie", "mymtu.ie", "mytudublin.ie",
  "ncad.ie", "ncirl.ie", "nui.ie", "nuigalway.ie", "nuim.ie", "rcpi.ie", "rcsi.com", "rcsi.ie", "setu.ie", "tcd.ie",
  "tudublin.ie", "tus.ie", "ucc.ie", "ucd.ie", "ucdconnect.ie", "ucg.ie", "ul.ie", "universityofgalway.ie", "wit.ie",
] as const;

/** Registries that only issue names to accredited colleges, so any name under them is a college address. */
const ACADEMIC_SUFFIXES = ["ac.uk", "edu"] as const;

const DOMAIN_LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/** The mail domain of an address, lower-cased, or null when the address isn't a plausible single email. */
export function emailDomain(email: string): string | null {
  const value = email.trim().toLocaleLowerCase("en-IE");
  const at = value.indexOf("@");
  if (at < 1 || at !== value.lastIndexOf("@") || /\s/.test(value)) return null;
  const domain = value.slice(at + 1).replace(/\.$/, "");
  const labels = domain.split(".");
  if (labels.length < 2 || !labels.every((label) => DOMAIN_LABEL.test(label))) return null;
  return domain;
}

const underDomain = (domain: string, base: string) => domain === base || domain.endsWith(`.${base}`);

/**
 * True for a university address: an Irish college domain (or a subdomain of one), a UK `.ac.uk` name or a `.edu` name.
 * This says whose mail server the address is on, not that its owner is enrolled: the sign-up must also have verified
 * the address, which {@link getAccountLogin} requires before it returns a login.
 */
export function isUniversityEmail(email: string): boolean {
  const domain = emailDomain(email);
  if (!domain) return false;
  return IRISH_COLLEGE_DOMAINS.some((base) => underDomain(domain, base)) || ACADEMIC_SUFFIXES.some((suffix) => underDomain(domain, suffix));
}

/**
 * The identity a claim is counted against, so one person can't claim once per alias: the address lower-cased, the
 * `+tag` dropped from the local part, and the mail domain reduced to the college's registered domain
 * (`ciara+1@mail.tcd.ie` and `ciara@tcd.ie` are the same inbox). Null when the address isn't a plausible email.
 */
export function studentDealKey(email: string): string | null {
  const domain = emailDomain(email);
  if (!domain) return null;
  const local = email.trim().toLocaleLowerCase("en-IE").slice(0, email.trim().lastIndexOf("@")).split("+")[0]!;
  if (!local) return null;
  const college = IRISH_COLLEGE_DOMAINS.find((base) => underDomain(domain, base));
  if (college) return `${local}@${college}`;
  const suffix = ACADEMIC_SUFFIXES.find((candidate) => underDomain(domain, candidate));
  if (suffix) {
    // Colleges register one label under the academic suffix (ox.ac.uk, mit.edu); anything deeper is a department.
    const labels = domain.split(".");
    const registered = labels.slice(-(suffix.split(".").length + 1)).join(".");
    return `${local}@${registered}`;
  }
  return `${local}@${domain}`;
}
