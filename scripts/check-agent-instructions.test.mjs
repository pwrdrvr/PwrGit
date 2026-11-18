import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  AGENTS_MD_CHAIN_MAX_BYTES,
  ROOT_AGENTS_MD_MAX_BYTES,
  agentInstructionChains,
  brokenRelativeLinks,
  checkAgentInstructionChains,
  checkAgentInstructionsSize,
} from "./check-agent-instructions.mjs";

const CODEX_PROJECT_DOC_DEFAULT_MAX_BYTES = 32 * 1024;
const script = fileURLToPath(new URL("./check-agent-instructions.mjs", import.meta.url));
const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

function job(name) {
  const body = ci.split(`\n  ${name}:\n`)[1]?.split(/\n  [\w-]+:\n/)[0];
  if (!body) throw new Error(`Missing job: ${name}`);
  return body;
}

// Small deterministic PRNG so the model test is reproducible.
function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

describe("checkAgentInstructionsSize (root file)", () => {
  it("keeps both limits under Codex's default project-doc budget", () => {
    expect(ROOT_AGENTS_MD_MAX_BYTES).toBe(24_576);
    expect(AGENTS_MD_CHAIN_MAX_BYTES).toBe(28_672);
    expect(ROOT_AGENTS_MD_MAX_BYTES).toBeLessThan(AGENTS_MD_CHAIN_MAX_BYTES);
    expect(AGENTS_MD_CHAIN_MAX_BYTES).toBeLessThan(CODEX_PROJECT_DOC_DEFAULT_MAX_BYTES);
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
});

describe("agentInstructionChains", () => {
  // Oracle: a file is in a directory's chain when its directory is the root
  // or a whole-component prefix of that directory. "apps/desk" is not a
  // prefix of "apps/desktop".
  function oracle(sizes) {
    const dirs = [...sizes.keys()].map((path) => path.replace(/\/?AGENTS\.md$/, ""));
    return new Map(dirs.map((dir) => [dir, [...sizes].filter(([path]) => {
      const fileDir = path.replace(/\/?AGENTS\.md$/, "");
      return fileDir === "" || dir === fileDir || dir.startsWith(`${fileDir}/`);
    }).reduce((sum, [, bytes]) => sum + bytes, 0)]));
  }

  it("matches the prefix oracle on random trees, and flags exactly the chains over the limit", () => {
    const names = ["apps", "desk", "desktop", "src", "main", "git", "a", "ab"];
    const random = rng(0x5eed);
    for (let trial = 0; trial < 500; trial += 1) {
      const sizes = new Map();
      if (random() < 0.8) sizes.set("AGENTS.md", Math.floor(random() * 20_000));
      const count = Math.floor(random() * 8);
      for (let i = 0; i < count; i += 1) {
        const depth = 1 + Math.floor(random() * 4);
        const dir = Array.from({ length: depth }, () => names[Math.floor(random() * names.length)]).join("/");
        sizes.set(`${dir}/AGENTS.md`, Math.floor(random() * 20_000));
      }
      const expected = oracle(sizes);
      const chains = agentInstructionChains(sizes);
      expect(new Map(chains.map(({ dir, total }) => [dir, total]))).toEqual(expected);
      const limit = Math.floor(random() * 40_000);
      const failures = checkAgentInstructionChains(sizes, limit);
      expect(failures.map(({ dir }) => dir).sort()).toEqual(
        [...expected].filter(([, total]) => total > limit).map(([dir]) => dir).sort(),
      );
      for (const failure of failures) expect(failure.message).toContain(`(${failure.total - limit} over)`);
    }
  });

  it("names every file in an over-budget chain", () => {
    const [failure] = checkAgentInstructionChains(new Map([
      ["AGENTS.md", 10], ["apps/AGENTS.md", 20], ["apps/desktop/AGENTS.md", 30], ["other/AGENTS.md", 1],
    ]), 59);
    expect(failure.dir).toBe("apps/desktop");
    expect(failure.message).toContain("AGENTS.md 10 + apps/AGENTS.md 20 + apps/desktop/AGENTS.md 30");
    expect(failure.message).toContain("(1 over)");
  });
});

describe("brokenRelativeLinks", () => {
  const present = new Set(["docs/a.md", "docs/guides/x/b.md", "apps/desktop/AGENTS.md", "docs", "scripts/s.mjs"]);
  const exists = (path) => present.has(path);

  it("resolves relative, root-absolute and anchored links from the file's directory", () => {
    const markdown = [
      "[a](../../docs/a.md) [b](../../docs/guides/x/b.md#anchor) [root](/docs/a.md)",
      "[dir](../../docs/) [self](#section) [web](https://example.com/x) [mail](mailto:x@y)",
      "[titled](../../scripts/s.mjs \"Title\")",
    ].join("\n");
    expect(brokenRelativeLinks(markdown, "apps/desktop/AGENTS.md", exists)).toEqual([]);
  });

  it("reports missing targets and links that escape the repository", () => {
    const markdown = "[gone](../../docs/gone.md) [up](../../../outside.md) [deep](docs/a.md)";
    expect(brokenRelativeLinks(markdown, "apps/desktop/AGENTS.md", exists))
      .toEqual(["../../docs/gone.md", "../../../outside.md", "docs/a.md"]);
  });

  it("ignores link syntax inside code spans and fenced blocks", () => {
    const markdown = "`[x](missing.md)`\n\n```md\n[y](missing.md)\n```\n\n[z](missing.md)";
    expect(brokenRelativeLinks(markdown, "AGENTS.md", exists)).toEqual(["missing.md"]);
  });
});

describe("the repository", () => {
  it("passes the CLI: root size, every chain, and every link", () => {
    const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/^AGENTS\.md is \d+ of 24576 bytes; .* all links resolve\.$/m);
  });
});

describe("CI wiring", () => {
  it("runs the check in the classifier, before any install", () => {
    const changes = job("changes");
    expect(changes).toContain("run: node ./scripts/check-agent-instructions.mjs");
    expect(changes).not.toMatch(/configure-nodejs|pnpm/);
    // Dependency-free: only Node built-ins and the shared CLI guard.
    const imports = [...readFileSync(script, "utf8").matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    expect(imports.filter((specifier) => !specifier.startsWith("node:"))).toEqual(["./lib/cli-entrypoint.mjs"]);
  });

  // A skipped required check counts as satisfied, so a failed classifier must
  // not let Typecheck skip: it runs, repeats the check, and refuses to pass.
  it("keeps the required Typecheck check red when the classifier fails", () => {
    const typecheck = job("typecheck");
    expect(typecheck).toContain("name: Typecheck\n");
    expect(typecheck).toContain("!cancelled() &&");
    expect(typecheck).toContain("needs.changes.result != 'success'");
    expect(typecheck).toContain("run: node ./scripts/check-agent-instructions.mjs");
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
