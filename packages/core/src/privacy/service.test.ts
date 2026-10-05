import { describe, expect, it } from "vitest";
import { suppressionHash } from "./service";

describe("privacy suppression hashes", () => {
  it("normalizes email case without storing the address", () => {
    expect(suppressionHash("Person@Example.ie", "pepper")).toBe(suppressionHash(" person@example.ie ", "pepper"));
    expect(suppressionHash("Person@Example.ie", "pepper")).not.toContain("person");
  });
});
