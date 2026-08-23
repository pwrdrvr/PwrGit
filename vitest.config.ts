import { defineConfig } from "vitest/config";

// Node is the default test environment (main-process + shared-package units).
// Renderer component tests opt into jsdom per-file with a
// `// @vitest-environment jsdom` pragma at the top of the file.
export default defineConfig({
  test: {
    environment: "node",
    // Eleven main-process suites drive real `git` subprocesses against temp
    // repos, and every operation pays full process-spawn cost. That is well
    // outside what Vitest's 5s default is sized for: on Windows CI runners,
    // where spawning is dearest, `rebase-assistant.test.ts` alone has run
    // 14s and 24s for its 14 tests on identical code. A genuinely hung test
    // still fails here — just not before a slow-but-healthy one has finished.
    testTimeout: 20_000,
    include: [
      "packages/*/src/**/*.test.ts",
      "apps/desktop/src/**/*.test.{ts,tsx}",
      "scripts/**/*.test.mjs",
      // Checked-in build assets and executable ESM packaging hooks are guarded
      // next to the scripts that own them, outside `src/`.
      "apps/desktop/scripts/**/*.test.{ts,mjs}"
    ],
    exclude: ["**/node_modules/**", "**/out/**", "apps/desktop/e2e/**"]
  }
});
