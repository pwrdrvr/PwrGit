import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  ROOT_AGENTS_MD_MAX_BYTES,
  checkAgentInstructionsSize,
} from "./check-agent-instructions-size.mjs";

const CODEX_PROJECT_DOC_DEFAULT_MAX_BYTES = 32 * 1024;
const script = fileURLToPath(new URL("./check-agent-instructions-size.mjs", import.meta.url));
const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

function job(name) {
  const body = ci.split(`\n  ${name}:\n`)[1]?.split(/\n  [\w-]+:\n/)[0];
  if (!body) throw new Error(`Missing job: ${name}`);
  return body;
}

describe("checkAgentInstructionsSize", () => {
  it("keeps the limit at 24 KiB, under Codex's default project-doc budget", () => {
    expect(ROOT_AGENTS_MD_MAX_BYTES).toBe(24_576);
    expect(ROOT_AGENTS_MD_MAX_BYTES).toBeLessThan(CODEX_PROJECT_DOC_DEFAULT_MAX_BYTES);
  });

  it("passes exactly the sizes at or under the limit", () => {
    for (const limit of [0, 1, 100, ROOT_AGENTS_MD_MAX_BYTES]) {
      for (let bytes = Math.max(0, limit - 64); bytes <= limit + 64; bytes += 1) {
        const result = checkAgentInstructionsSize(bytes, limit);
        expect(result.ok, `${bytes}/${limit}`).toBe(bytes <= limit);
        if (!result.ok) {
          expect(result.message).toContain(`(${bytes - limit} over)`);
          expect(result.message).toContain("when-to-read");
        }
      }
    }
  });

  it("rejects a file Codex would truncate", () => {
    expect(checkAgentInstructionsSize(CODEX_PROJECT_DOC_DEFAULT_MAX_BYTES + 1).ok).toBe(false);
  });

  it("passes the repository's AGENTS.md from the CLI", () => {
    const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/^AGENTS\.md is \d+ of 24576 bytes\.$/m);
  });
});

describe("CI wiring", () => {
  it("runs the check in the classifier from a sparse checkout of the script's imports", () => {
    const changes = job("changes");
    expect(changes).toContain("run: node ./scripts/check-agent-instructions-size.mjs");
    for (const path of ["AGENTS.md", "scripts/check-agent-instructions-size.mjs", "scripts/lib/cli-entrypoint.mjs"]) {
      expect(changes).toMatch(new RegExp(`^            ${path.replaceAll(".", "\\.")}$`, "m"));
    }
    const imports = [...readFileSync(script, "utf8").matchAll(/from "(\.[^"]+)"/g)].map((m) => m[1]);
    expect(imports).toEqual(["./lib/cli-entrypoint.mjs"]);
  });

  // A skipped required check counts as satisfied, so a failed classifier must
  // not let Typecheck skip: it runs, repeats the check, and refuses to pass.
  it("keeps the required Typecheck check red when the classifier fails", () => {
    const typecheck = job("typecheck");
    expect(typecheck).toContain("name: Typecheck\n");
    expect(typecheck).toContain("!cancelled() &&");
    expect(typecheck).toContain("needs.changes.result != 'success'");
    expect(typecheck).toContain("run: node ./scripts/check-agent-instructions-size.mjs");
    const gate = typecheck.split(/^      - /m).find((step) => step.startsWith("name: Require change classification\n"));
    expect(gate).toBeDefined();
    const run = gate.split("        run: |\n")[1];
    for (const value of ["success", "failure", "skipped", "cancelled", ""]) {
      const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", run], {
        env: { ...process.env, CHANGES_RESULT: value },
        encoding: "utf8",
      });
      expect(result.status, value).toBe(value === "success" ? 0 : 1);
    }
  });
});
