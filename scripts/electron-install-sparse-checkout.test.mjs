import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

// Port of PwrAgent #3580's Git sparse-checkout oracle. PwrGit's entry point
// includes a side-effect import, and its current workflows use full checkouts.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = "apps/desktop/scripts/install-electron-binary.mjs";
const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function checkoutsIn(workflow) {
  const lines = readFileSync(join(root, workflow), "utf8").split("\n");
  const checkouts = [];
  for (let index = 0; index < lines.length; index++) {
    const match = /^(\s*)(- )?uses:\s*actions\/checkout@/.exec(lines[index]);
    if (!match) continue;
    const stepIndent = match[1].length - (match[2] ? 0 : 2);
    let end = index + 1;
    while (end < lines.length && (!lines[end].trim() || lines[end].search(/\S/) > stepIndent)) end++;
    const step = lines.slice(index, end);
    const sparseIndex = step.findIndex((line) => /^\s*sparse-checkout:/.test(line));
    let patterns;
    if (sparseIndex !== -1) {
      if (!/sparse-checkout: \|[-+]?\s*$/.test(step[sparseIndex])) {
        throw new Error(`${workflow}:${index + 1}: sparse patterns must be auditable literal lines`);
      }
      const indent = step[sparseIndex].search(/\S/);
      patterns = [];
      for (let next = sparseIndex + 1; next < step.length; next++) {
        if (!step[next].trim()) continue;
        if (step[next].search(/\S/) <= indent) break;
        patterns.push(step[next].trim());
      }
    }
    checkouts.push({ workflow, line: index + 1, patterns,
      cone: !step.some((line) => /^\s*sparse-checkout-cone-mode:\s*false\s*$/.test(line)),
    });
  }
  return checkouts;
}

// Discover the actual closure, including PwrGit's side-effect import. Future
// relative static, re-export and literal dynamic imports must remain available.
function importClosure(file, files = new Map()) {
  if (files.has(file)) return files;
  const source = readFileSync(join(root, file), "utf8");
  files.set(file, source);
  for (const [, specifier] of source.matchAll(/\b(?:from\s*|import\s*(?:\(\s*)?)["'](\.[^"']+)["']/g)) {
    importClosure(join(dirname(file), specifier).replaceAll("\\", "/"), files);
  }
  return files;
}

function assertRetained({ workflow, line, patterns, cone }) {
  const directory = mkdtempSync(join(tmpdir(), "pwrgit-sparse-install-"));
  directories.push(directory);
  const git = (args, options = {}) => execFileSync("git", args, {
    cwd: directory, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], ...options,
  });
  git(["init", "--quiet"]);
  const files = importClosure(entry);
  for (const [file, source] of files) {
    mkdirSync(dirname(join(directory, file)), { recursive: true });
    writeFileSync(join(directory, file), source);
  }
  git(["add", "--force", "."]);
  const tree = git(["write-tree"]).trim();
  // Use Git's actual pattern handling, including cone expansion. Full
  // checkouts are represented by a non-cone pattern retaining the whole tree.
  git(["sparse-checkout", "set", patterns && cone ? "--cone" : "--no-cone", "--stdin"], {
    input: `${(patterns ?? ["/*"]).join("\n")}\n`,
  });
  git(["read-tree", "-mu", tree]);
  for (const file of files.keys()) {
    expect(existsSync(join(directory, file)), `${workflow}:${line} omits required import ${file}`).toBe(true);
  }
}

const workflows = readdirSync(join(root, ".github/workflows"))
  .filter((name) => /\.ya?ml$/.test(name)).map((name) => `.github/workflows/${name}`);
const checkouts = workflows.flatMap(checkoutsIn);

it("discovers CI and release checkouts and every sparse input", () => {
  for (const workflow of [".github/workflows/ci.yml", ".github/workflows/release.yml"]) {
    expect(checkouts.some((checkout) => checkout.workflow === workflow), workflow).toBe(true);
  }
  const sparseInputs = workflows.reduce((count, workflow) => count
    + [...readFileSync(join(root, workflow), "utf8").matchAll(/^\s*sparse-checkout:/gm)].length, 0);
  expect(checkouts.filter(({ patterns }) => patterns !== undefined)).toHaveLength(sparseInputs);
});

it.each(checkouts)("Git oracle: $workflow:$line retains the Electron install import closure", assertRetained);

it("rejects the parent regression: installer and adapter selected without their helper", () => {
  expect(() => assertRetained({
    workflow: "regression fixture", line: 1, cone: false,
    patterns: [entry, "apps/desktop/scripts/ensure-electron-runtime.mjs"],
  })).toThrow("omits required import apps/desktop/scripts/electron-runtime-cache.mjs");
});

it("accepts directory selection in cone mode using Git's own expansion", () => {
  assertRetained({ workflow: "cone fixture", line: 1, cone: true, patterns: ["apps/desktop/scripts"] });
});
