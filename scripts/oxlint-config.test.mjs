import { spawnSync } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const cli = fileURLToPath(new URL("../node_modules/oxlint/bin/oxlint", import.meta.url));

describe("Oxlint correctness scope", () => {
  it("rejects unsafe optional accesses in root, main, renderer and tests", () => {
    const files = [
      "__pwrgit_lint_probe.ts",
      "apps/desktop/src/main/__pwrgit_lint_probe.ts",
      "apps/desktop/src/renderer/src/__pwrgit_lint_probe.ts",
      "packages/shared/src/__pwrgit_lint_probe.test.ts",
      "scripts/__pwrgit_lint_probe.mjs",
    ];
    const created = [];
    try {
      for (const file of files) {
        writeFileSync(new URL(`../${file}`, import.meta.url), "const maybe = globalThis.probe; (maybe?.items).map(String);\n", { flag: "wx" });
        created.push(file);
      }
      const result = spawnSync(process.execPath, [cli, "--format", "json", ...files], { cwd: root, encoding: "utf8" });
      expect(result.status).toBe(1);
      const diagnostics = JSON.parse(result.stdout).diagnostics;
      for (const file of files) {
        expect(diagnostics.some((diagnostic) => diagnostic.filename === file && diagnostic.code === "eslint(no-unsafe-optional-chaining)")).toBe(true);
      }
    } finally {
      for (const file of created) rmSync(new URL(`../${file}`, import.meta.url));
    }
  });

  it("rejects conditional Hooks in renderer components", () => {
    const file = "apps/desktop/src/renderer/src/__pwrgit_hooks_probe.tsx";
    const path = new URL(`../${file}`, import.meta.url);
    writeFileSync(path, 'import { useState } from "react";\nexport function Probe({ flag }) { if (flag) useState(0); return null; }\n', { flag: "wx" });
    try {
      const result = spawnSync(process.execPath, [cli, "--format", "json", file], { cwd: root, encoding: "utf8" });
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout).diagnostics.some((diagnostic) => diagnostic.code === "react-hooks(rules-of-hooks)")).toBe(true);
    } finally { rmSync(path); }
  });
});
