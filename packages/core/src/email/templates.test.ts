import { describe, expect, it } from "vitest";
import { renderConfirmationEmail } from "./templates";

describe("confirmation email", () => {
  it("contains the confirmation link in text and HTML", () => {
    const url = "https://daildex.ie/confirm?token=abc_123";
    const email = renderConfirmationEmail({ confirmationUrl: url });
    expect(email.text).toContain(url);
    expect(email.html).toContain(url);
    expect(email.subject).toContain("Confirm");
  });

  it("renders an Irish confirmation and language declaration", () => {
    const email = renderConfirmationEmail({ confirmationUrl: "https://daildex.ie/ga/confirm?token=abc", locale: "ga" });
    expect(email.subject).toContain("Deimhnigh");
    expect(email.html).toContain('lang="ga"');
    expect(email.text).toContain("https://daildex.ie/ga/confirm?token=abc");
  });
});
