import { describe, expect, it } from "vitest";
import { AUTO_LANGUAGE, DEX_LANGUAGES, FEATURED_LANGUAGE_CODES, findDexLanguage, isDexLanguageCode } from "./languages";

describe("Dex languages", () => {
  it("lists well over a hundred unique, well-formed language codes", () => {
    const codes = DEX_LANGUAGES.map((language) => language.code);
    expect(codes.length).toBeGreaterThan(140);
    expect(new Set(codes).size).toBe(codes.length);
    // Must stay within the chat_profiles.preferred_language CHECK constraint.
    for (const code of codes) expect(code).toMatch(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/);
  });

  it("features only listed languages", () => {
    for (const code of FEATURED_LANGUAGE_CODES) expect(findDexLanguage(code)).toBeDefined();
  });

  it("accepts auto and listed codes only", () => {
    expect(isDexLanguageCode(AUTO_LANGUAGE)).toBe(true);
    expect(isDexLanguageCode("ga")).toBe(true);
    expect(isDexLanguageCode("pt-BR")).toBe(true);
    expect(isDexLanguageCode("klingon")).toBe(false);
    expect(findDexLanguage("auto")).toBeUndefined();
  });
});
