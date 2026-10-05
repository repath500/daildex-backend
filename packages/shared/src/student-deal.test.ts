import { describe, expect, it } from "vitest";
import { emailDomain, isUniversityEmail, STUDENT_DEAL, STUDENT_DEAL_TOTAL_EUR, studentDealKey } from "./student-deal";

describe("student deal terms", () => {
  it("costs less in total than one regular month", () => {
    expect(STUDENT_DEAL_TOTAL_EUR).toBe(9);
    expect(STUDENT_DEAL_TOTAL_EUR).toBeLessThan(STUDENT_DEAL.regularPriceEur);
  });

  it("discount takes the regular price to the student price", () => {
    expect(STUDENT_DEAL.regularPriceEur * 100 - STUDENT_DEAL.amountOffCents).toBe(STUDENT_DEAL.monthlyPriceEur * 100);
  });
});

describe("isUniversityEmail", () => {
  it.each([
    "ciara@tcd.ie",
    "ciara@ucdconnect.ie",
    "ciara@mail.dcu.ie",
    "ciara@umail.ucc.ie",
    "ciara@mumail.ie",
    "ciara@studentmail.ul.ie",
    "ciara@universityofgalway.ie",
    "ciara@mytudublin.ie",
    "ciara@mail.atu.ie",
    "ciara@student.ncirl.ie",
    "ciara@student.rcsi.com",
    "ciara@mymtu.ie",
    "ciara@qub.ac.uk",
    "ciara@students.ulster.ac.uk",
    "ciara@cs.stanford.edu",
    "  Ciara@UCD.IE  ",
  ])("accepts %s", (email) => expect(isUniversityEmail(email)).toBe(true));

  it.each([
    "ciara@gmail.com",
    "ciara@outlook.ie",
    "ciara@oireachtas.ie",
    "ciara@evil-tcd.ie",
    "ciara@tcd.ie.example.com",
    "ciara@nottcd.ie",
    "ciara@edu.example.com",
    "ciara@fake.ac.uk.attacker.io",
    "ciara@ac.uk.example.com",
    "tcd.ie",
    "@tcd.ie",
    "a@b@tcd.ie",
    "ciara @tcd.ie",
    "",
  ])("rejects %j", (email) => expect(isUniversityEmail(email)).toBe(false));
});

describe("emailDomain", () => {
  it("lower-cases and trims, and refuses malformed domains", () => {
    expect(emailDomain(" A@Mail.DCU.ie ")).toBe("mail.dcu.ie");
    expect(emailDomain("a@localhost")).toBeNull();
    expect(emailDomain("a@-bad.ie")).toBeNull();
  });
});

describe("studentDealKey", () => {
  it("counts plus-addresses and college subdomains as the same mailbox", () => {
    const key = studentDealKey("ciara@tcd.ie");
    expect(key).toBe("ciara@tcd.ie");
    expect(studentDealKey("Ciara+1@tcd.ie")).toBe(key);
    expect(studentDealKey("ciara+two@mail.tcd.ie")).toBe(key);
    expect(studentDealKey("ciara@student.mail.tcd.ie")).toBe(key);
  });

  it("reduces academic suffix names to the college's registered domain", () => {
    expect(studentDealKey("sam+x@cs.ox.ac.uk")).toBe("sam@ox.ac.uk");
    expect(studentDealKey("sam@cs.mit.edu")).toBe("sam@mit.edu");
  });

  it("keeps different people and different colleges apart, and rejects non-emails", () => {
    expect(studentDealKey("ciara@tcd.ie")).not.toBe(studentDealKey("sean@tcd.ie"));
    expect(studentDealKey("ciara@tcd.ie")).not.toBe(studentDealKey("ciara@ucd.ie"));
    expect(studentDealKey("not an email")).toBeNull();
    expect(studentDealKey("+tag@tcd.ie")).toBeNull();
  });
});
