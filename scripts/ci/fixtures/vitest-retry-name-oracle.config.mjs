import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["scripts/ci/fixtures/vitest-retry-name-oracle.fixture.mjs"],
  },
});
