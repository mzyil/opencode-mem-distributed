import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // NOTE: Only the new vitest tests are included here.
    // Pre-existing tests/ files use bun:test and continue to run via `bun test`.
    // Do not migrate them to vitest without first removing their bun:test imports.
    include: [
      "tests/scope-free-form.test.ts",
      "tests/session-context.test.ts",
      "tests/pgvector-scope-filter.test.ts",
    ],
    testTimeout: 30_000,
  },
});
