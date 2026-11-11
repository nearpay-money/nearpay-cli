import { defineWorkspace } from "vitest/config";

// unit: every module in-process — SSE parser, stream client, signing, login flow, credential stores,
// API client and trigger fixtures — against an in-process spec-validating mock of the public API.
// integration: the built `nearpay` binary run as a child process against a stateful fake NearPay
// (spec-validating, SSE included) and a local webhook receiver that verifies with @nearpay-money/node.
export default defineWorkspace([
  {
    test: {
      name: "unit",
      include: ["test/unit/**/*.test.ts"],
    },
  },
  {
    test: {
      name: "integration",
      include: ["test/integration/**/*.test.ts"],
      testTimeout: 60_000,
      hookTimeout: 60_000,
      pool: "forks",
      poolOptions: { forks: { singleFork: true } },
    },
  },
]);
