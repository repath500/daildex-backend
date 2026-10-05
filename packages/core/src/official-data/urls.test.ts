import { describe, expect, it } from "vitest";
import { publicAlertSourceUrl, toPublicOireachtasUrl } from "./urls";

describe("public Oireachtas links", () => {
  it("sends questions to their own public page", () => {
    expect(toPublicOireachtasUrl("https://data.oireachtas.ie/ie/oireachtas/question/2026-07-02/pq_213"))
      .toBe("https://www.oireachtas.ie/en/debates/question/2026-07-02/213/");
  });

  it("sends a written-answers section to that day's answers", () => {
    expect(toPublicOireachtasUrl("https://data.oireachtas.ie/akn/ie/debateRecord/dail/2026-09-23/writtens/dbsect_210"))
      .toBe("https://www.oireachtas.ie/en/debates/question/2026-09-23/");
  });

  it("prefers the question URI for an alert and never returns a data-host record id", () => {
    const section = "https://data.oireachtas.ie/akn/ie/debateRecord/dail/2026-09-23/writtens/dbsect_210";
    expect(publicAlertSourceUrl(section, "https://data.oireachtas.ie/ie/oireachtas/question/2026-09-24/pq_387"))
      .toBe("https://www.oireachtas.ie/en/debates/question/2026-09-24/387/");
    expect(publicAlertSourceUrl(section, null)).toBe("https://www.oireachtas.ie/en/debates/question/2026-09-23/");
    expect(publicAlertSourceUrl("https://data.oireachtas.ie/akn/ie/debateRecord/dail/2026-09-23/debate/main"))
      .toBe("https://www.oireachtas.ie/en/debates/debate/dail/2026-09-23/");
  });
});
