import { defineConfig } from "vitest/config";

// Node is the default test environment (main-process + shared-package units).
// Renderer component tests opt into jsdom per-file with a
// `// @vitest-environment jsdom` pragma at the top of the file.
export default defineConfig({
  test: {
    environment: "node",
    include: [
      "packages/*/src/**/*.test.ts",
      "apps/desktop/src/**/*.test.{ts,tsx}",
      "scripts/**/*.test.mjs"
    ],
    exclude: ["**/node_modules/**", "**/out/**", "apps/desktop/e2e/**"]
  }
});
