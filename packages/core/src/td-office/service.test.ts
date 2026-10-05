import { describe, expect, it } from "vitest";
import {
  createTdOfficeSession,
  isOwnerEmail,
  renderTdOfficeLoginEmail,
  tdOfficeLoginRequestSchema,
  verifyTdOfficeSession,
} from "./service";

describe("TD office owner addresses", () => {
  it("recognise the TD's own Oireachtas address in common forms", () => {
    expect(isOwnerEmail("Aengus Ó Snodaigh", "aengus.osnodaigh@oireachtas.ie")).toBe(true);
    expect(isOwnerEmail("Conor D. McGuinness", "conor.mcguinness@oireachtas.ie")).toBe(true);
    expect(isOwnerEmail("Cian O'Callaghan", "cian.ocallaghan@oireachtas.ie")).toBe(true);
    expect(isOwnerEmail("Mary Butler", "mbutler@oireachtas.ie")).toBe(true);
  });

  it("treat other Oireachtas addresses as staff, never as the owner", () => {
    expect(isOwnerEmail("Mary Butler", "john.murphy@oireachtas.ie")).toBe(false);
    expect(isOwnerEmail("Mary Butler", "mary.butler@gmail.com")).toBe(false);
    expect(isOwnerEmail("Mary Butler", "butler.office@oireachtas.ie")).toBe(false);
  });

  it("only accept @oireachtas.ie sign-in addresses", () => {
    expect(() => tdOfficeLoginRequestSchema.parse({ representativeId: "mary-butler", email: "mary@gmail.com" })).toThrow();
    expect(() => tdOfficeLoginRequestSchema.parse({ representativeId: "mary-butler", email: "x@oireachtas.ie.evil.com" })).toThrow();
    expect(tdOfficeLoginRequestSchema.parse({ representativeId: "mary-butler", email: " Mary.Butler@Oireachtas.ie " }).email)
      .toBe("mary.butler@oireachtas.ie");
  });
});

describe("TD office sessions", () => {
  const memberId = "123e4567-e89b-42d3-a456-426614174000";

  it("round-trip and reject tampering, another key, a new version or expiry", () => {
    const now = Date.parse("2026-09-27T12:00:00Z");
    const session = createTdOfficeSession(memberId, 1, now, "pepper");
    expect(verifyTdOfficeSession(session, now, "pepper")).toEqual({ memberId, sessionVersion: 1 });
    expect(verifyTdOfficeSession(session, now, "other")).toBeNull();
    expect(verifyTdOfficeSession(session.replace(".1.", ".2."), now, "pepper")).toBeNull();
    expect(verifyTdOfficeSession(session, now + 31 * 86_400_000, "pepper")).toBeNull();
    expect(verifyTdOfficeSession(undefined, now, "pepper")).toBeNull();
  });
});

describe("TD office sign-in email", () => {
  it("escapes the link and name", () => {
    const email = renderTdOfficeLoginEmail({ loginUrl: "https://daildex.com/x?a=1&b=\"2\"", representativeName: "A <B>" });
    expect(email.html).toContain("a=1&amp;b=&quot;2&quot;");
    expect(email.html).toContain("A &lt;B&gt;");
  });
});
