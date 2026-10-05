import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.integration.test.ts", "apps/**/*.integration.test.ts"],
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    fileParallelism: false,
  },
});
