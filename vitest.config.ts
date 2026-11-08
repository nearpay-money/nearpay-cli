import { defineConfig } from "vitest/config";

// Coverage gate (foundations §16): ≥ 90% lines and ≥ 85% branches on the CLI library code. `src/cli.ts`
// (process entry) and `src/commands/*` (commander wiring) are exercised by the integration suite.
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/lib/**/*.ts"],
      reporter: ["text", "json-summary"],
      thresholds: { branches: 85, lines: 90 },
    },
  },
});
