import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "act-warning-guard-self-test",
    globals: true,
    pool: "threads",
    environment: "jsdom",
    runner: "apps/desktop/test-support/act-warning-runner.ts",
    setupFiles: ["apps/desktop/src/renderer/src/test-support/react-act-setup.ts"],
    include: ["apps/desktop/src/renderer/src/test-support/fixtures/act-warning-guard.fixture.tsx"],
  },
});
