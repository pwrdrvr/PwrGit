#!/usr/bin/env node

/**
 * Per-product branching lint.
 *
 * Fails when non-test source under `packages/shared/src` or `apps/desktop/src`
 * compares a value against a forge kind by hand — `x === "github"`,
 * `x !== "gitlab"`, `case "github":`.
 *
 * Why this is a check and not a convention: the two shapes fail differently.
 * A `Record<ForgeKind, …>` missing a member is a type error that names itself,
 * so `tsc` hands you the list to fill in. A ternary silently answers a third
 * product as GitHub, and nothing catches it — not the compiler, and not a test
 * that only covers the two kinds that exist. Twenty-nine of these had
 * accumulated across eighteen files before the registry landed, precisely
 * because each one on its own looked harmless and nothing counted them.
 *
 * The fix for a violation is never to add an exception here. The value belongs
 * in `FORGE_PRODUCTS` (`packages/shared/src/forge-product.ts`) if it is data,
 * or behind a provider method if it is behaviour; `isForgeKind` / `toForgeHost`
 * are the guards for narrowing an unknown. `apps/desktop/src/main/forge/AGENTS.md`
 * has the whole rule under "Adding a forge".
 *
 * Tests are exempt: a test that pins one product's wording is stating the
 * expected value, not branching on it.
 *
 * Wire-up: `pnpm lint:forge-kinds` standalone; `pnpm lint` runs it first in the
 * chain, since it is by far the cheapest. CI's Typecheck job invokes `pnpm lint`.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const roots = ["packages/shared/src", "apps/desktop/src"];
const extensions = [".ts", ".tsx"];

/** The literal forge kinds, read from the one array that defines them, so this
 *  check cannot fall behind the union it is policing. */
function forgeKinds() {
  const types = readFileSync(
    resolve(repoRoot, "packages/shared/src/types.ts"),
    "utf8"
  );
  const declaration = /export const FORGE_KINDS = \[([^\]]*)\] as const;/.exec(
    types
  );
  if (declaration === null) {
    throw new Error(
      "check-forge-kind-branching: could not find FORGE_KINDS in packages/shared/src/types.ts"
    );
  }
  const kinds = [...declaration[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  if (kinds.length === 0) {
    throw new Error("check-forge-kind-branching: FORGE_KINDS parsed as empty");
  }
  return kinds;
}

function sourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const path = resolve(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === "node_modules" || entry === "dist" || entry === "out") continue;
      sourceFiles(path, out);
      continue;
    }
    // `.test.` and `.spec.` files state expected values; they do not branch.
    if (/\.(test|spec)\.[cm]?tsx?$/.test(entry)) continue;
    if (extensions.some((ext) => entry.endsWith(ext))) out.push(path);
  }
  return out;
}

export function findings(source, kinds) {
  const pattern = new RegExp(
    `(?:[!=]==?\\s*|case\\s+)"(${kinds.join("|")})"|"(${kinds.join("|")})"\\s*[!=]==?`,
    "g"
  );
  const out = [];
  source.split("\n").forEach((line, index) => {
    // A line that is only a comment is documentation about the rule, not a use
    // of it — this file's own prose would otherwise fail the check it defines.
    if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) return;
    for (const match of line.matchAll(pattern)) {
      out.push({ line: index + 1, text: line.trim(), kind: match[1] ?? match[2] });
    }
  });
  return out;
}

// Self-tests — the check has to catch the shapes it claims to catch.
{
  const k = ["github", "gitlab"];
  const cases = [
    ['if (kind === "gitlab") return 1;', 1],
    ['if (kind !== "github") return 1;', 1],
    ['switch (k) { case "gitlab": break; }', 1],
    ['if ("gitlab" === kind) return 1;', 1],
    ['const x = kind === "github" ? a : b;', 1],
    ['// `kind === "gitlab"` is the shape this rejects', 0],
    [' * A ternary like kind === "github" fails silently.', 0],
    ['const label = FORGE_PRODUCTS[kind].label;', 0],
    ['forges.register(new GitHubRepoProvider());', 0],
    ['expect(row.kind).toBe("gitlab");', 0]
  ];
  for (const [source, expected] of cases) {
    const got = findings(source, k).length;
    if (got !== expected) {
      throw new Error(
        `self-test: ${JSON.stringify(source)} expected ${expected} finding(s), got ${got}`
      );
    }
  }
}

const kinds = forgeKinds();
const violations = [];
for (const root of roots) {
  for (const file of sourceFiles(resolve(repoRoot, root))) {
    for (const finding of findings(readFileSync(file, "utf8"), kinds)) {
      violations.push({ file: relative(repoRoot, file), ...finding });
    }
  }
}

if (violations.length > 0) {
  console.error(
    `forge-kind branching lint failed — ${violations.length} hand-written comparison(s):\n`
  );
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}\n    ${v.text}`);
  }
  console.error(
    "\nA comparison against a forge kind silently answers a third product as the" +
      "\nfirst branch. Put the value in FORGE_PRODUCTS (packages/shared/src/forge-product.ts)" +
      "\nif it is data, or behind a provider method if it is behaviour; use isForgeKind /" +
      "\ntoForgeHost to narrow an unknown. See apps/desktop/src/main/forge/AGENTS.md."
  );
  process.exit(1);
}

console.log(
  `forge-kind branching lint passed (${kinds.length} kinds: ${kinds.join(", ")})`
);
