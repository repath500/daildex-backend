function requireValue(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

export function getTokenPepper(): string {
  return requireValue("TOKEN_HASH_PEPPER");
}

export function getAppBaseUrl(): string {
  return requireValue("APP_BASE_URL").replace(/\/$/, "");
}

export function getEmailReplyDomain(): string {
  return requireValue("EMAIL_REPLY_DOMAIN").replace(/^@/, "");
}
