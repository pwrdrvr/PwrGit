import { defineConfig } from "vitest/config";

// Eleven main-process suites drive real `git` subprocesses against temp
// repos, and every operation pays full process-spawn cost. That is well
// outside what Vitest's 5s default is sized for: on Windows CI runners,
// where spawning is dearest, `rebase-assistant.test.ts` alone has run
// 14s and 24s for its 14 tests on identical code. A genuinely hung test
// still fails here — just not before a slow-but-healthy one has finished.
//
// Hooks get the same budget because they do the same work: a `beforeEach`
// that builds a fixture repo spawns git just as a test body does. Left on
// Vitest's 10s hook default, they were the tighter limit and failed PRs
// that never touched them — `open-pr-service.test.ts`'s fixture hook runs
// about 2s at the median on Windows CI, and has still passed 10s on a
// loaded runner.
//
// A timeout argument on a single test or hook overrides this
// unconditionally, including downwards: a suite that carries `}, 15_000)`
// from before this line existed runs on a *tighter* budget than the
// default, on exactly the platform named above. Add one only to go higher
// than 20s, say why, and never restate 20_000 — a hand-copied duplicate is
// what goes stale the next time this number moves.
const REAL_GIT_TIMEOUT_MS = 20_000;

// Node is the default test environment (main-process + shared-package units).
// Renderer component tests opt into jsdom per-file with a
// `// @vitest-environment jsdom` pragma at the top of the file.
export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["apps/desktop/src/main/git/test-support/tripwire-setup.ts"],
    testTimeout: REAL_GIT_TIMEOUT_MS,
    hookTimeout: REAL_GIT_TIMEOUT_MS,
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
