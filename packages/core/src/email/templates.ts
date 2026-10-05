export type ConfirmationTemplateInput = {
  confirmationUrl: string;
  locale?: "en" | "ga";
};

export function renderConfirmationEmail(input: ConfirmationTemplateInput) {
  if (input.locale === "ga") return renderIrishConfirmationEmail(input.confirmationUrl);

  const subject = "Confirm your DáilDex alerts";
  const text = [
    "Confirm your DáilDex email alerts",
    "",
    "Use this link to confirm the representatives you want to follow:",
    input.confirmationUrl,
    "",
    "The link expires in 24 hours. If you did not request this, ignore this email.",
    "",
    "DáilDex explains Oireachtas activity using official public records.",
  ].join("\n");

  const html = `<!doctype html>
<html lang="en"><body style="font-family:Arial,sans-serif;line-height:1.6;color:#17202a">
  <h1 style="font-size:24px">Confirm your DáilDex alerts</h1>
  <p>Confirm the representatives you want to follow:</p>
  <p><a href="${escapeHtml(input.confirmationUrl)}" style="display:inline-block;padding:12px 18px;background:#176b47;color:white;border-radius:999px;text-decoration:none">Confirm email alerts</a></p>
  <p>The link expires in 24 hours. If you did not request this, ignore this email.</p>
  <p>DáilDex explains Oireachtas activity using official public records.</p>
</body></html>`;

  return { subject, text, html };
}

function renderIrishConfirmationEmail(confirmationUrl: string) {
  const subject = "Deimhnigh d’fholáirimh DáilDex";
  const text = [
    "Deimhnigh d’fholáirimh ríomhphoist DáilDex",
    "",
    "Úsáid an nasc seo chun na hionadaithe ar mhaith leat a leanúint a dheimhniú:",
    confirmationUrl,
    "",
    "Rachaidh an nasc in éag i gceann 24 uair. Mura ndearna tú an t-iarratas seo, déan neamhaird den ríomhphost.",
    "",
    "Míníonn DáilDex gníomhaíocht an Oireachtais trí thaifid phoiblí oifigiúla a úsáid.",
  ].join("\n");
  const html = `<!doctype html>
<html lang="ga"><body style="font-family:Arial,sans-serif;line-height:1.6;color:#17202a">
  <h1 style="font-size:24px">Deimhnigh d’fholáirimh DáilDex</h1>
  <p>Deimhnigh na hionadaithe ar mhaith leat a leanúint:</p>
  <p><a href="${escapeHtml(confirmationUrl)}" style="display:inline-block;padding:12px 18px;background:#176b47;color:white;border-radius:999px;text-decoration:none">Deimhnigh foláirimh ríomhphoist</a></p>
  <p>Rachaidh an nasc in éag i gceann 24 uair. Mura ndearna tú an t-iarratas seo, déan neamhaird den ríomhphost.</p>
  <p>Míníonn DáilDex gníomhaíocht an Oireachtais trí thaifid phoiblí oifigiúla a úsáid.</p>
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
