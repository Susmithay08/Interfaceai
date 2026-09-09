import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Browser-driven recovery tests wait on real page loads and re-authentication; the
    // default was tight enough on a loaded machine to fail on timing rather than behaviour.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
