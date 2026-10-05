import { describe, expect, it } from "vitest";
import { AppError } from "@daildex/shared";
import { parsePublicActivityQuery, parsePublicListQuery } from "./service";

describe("public API query parsing", () => {
  it("applies bounded pagination defaults", () => {
    expect(parsePublicListQuery({})).toMatchObject({ limit: 25, offset: 0 });
  });

  it("accepts valid public activity filters", () => {
    expect(parsePublicActivityQuery({
      type: "vote",
      representative: "example-td",
      chamber: "Dáil",
      date_start: "2026-07-01",
      date_end: "2026-07-09",
      limit: "50",
      offset: "10",
    })).toMatchObject({ type: "vote", limit: 50, offset: 10 });
  });

  it("rejects invalid date ranges and oversized pages", () => {
    expect(() => parsePublicListQuery({
      date_start: "2026-07-09",
      date_end: "2026-07-01",
    })).toThrow(AppError);
    expect(() => parsePublicListQuery({ limit: "500" })).toThrow(AppError);
  });
});
