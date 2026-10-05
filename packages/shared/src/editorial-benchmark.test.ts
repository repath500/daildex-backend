import { describe, expect, it } from "vitest";
import { runEditorialBenchmark } from "./editorial-benchmark";
describe("editorial regression benchmark", () => {
  for (const result of runEditorialBenchmark()) it(result.id, () => expect(result.passed, JSON.stringify(result.issues)).toBe(true));
});
