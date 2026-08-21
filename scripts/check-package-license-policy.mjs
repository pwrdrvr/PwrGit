#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIRST_PARTY_OWNER = "PwrDrvr LLC";
const FIRST_PARTY_COPYRIGHT = `Copyright © 2026 ${FIRST_PARTY_OWNER}`;
const LICENSE_COPYRIGHT = `Copyright (c) 2026 ${FIRST_PARTY_OWNER}`;

// Every workspace package is listed deliberately. Adding a package requires
// choosing its license and ownership rather than silently inheriting assumed
// defaults.
const EXPECTED_PACKAGE_POLICIES = new Map([
  ["package.json", { license: "MIT", author: FIRST_PARTY_OWNER }],
  ["apps/desktop/package.json", { license: "MIT", author: FIRST_PARTY_OWNER }],
  ["packages/shared/package.json", { license: "MIT", author: FIRST_PARTY_OWNER }],
]);

// Keep former-employer names out of first-party source. These are assembled so
// the policy file does not itself become a match. The one public dependency
// whose npm scope names its vendor is intentionally retained; only the files
// required to declare, use, lock, and attribute that dependency may name it.
const PROHIBITED_NAMES = [
  ["gi", "phy"].join(""),
  ["ss", "tk"].join(""),
];
const PUBLIC_DEPENDENCY_VENDOR = ["shutter", "stock"].join("");
const PUBLIC_DEPENDENCY_REFERENCE_PATHS = new Set([
  "THIRD_PARTY_LICENSES",
  "apps/desktop/package.json",
  "apps/desktop/src/main/util/map-limit.ts",
  "apps/desktop/src/renderer/src/lib/asyncFill.ts",
  "pnpm-lock.yaml",
]);

const SKIP_DIRS = new Set([
  ".git",
  ".worktrees",
  ".claude",
  ".agents",
  "node_modules",
  "release-stage",
  "dist",
  "out",
  "playwright-report",
  "test-results",
]);

export function* walkPackageJsonFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walkPackageJsonFiles(join(dir, entry.name));
    } else if (entry.name === "package.json") {
      yield join(dir, entry.name);
    }
  }
}

export function checkPackageLicensePolicy(root = repoRoot) {
  const failures = [];
  const seen = new Set();

  for (const packagePath of walkPackageJsonFiles(root)) {
    // Canonicalize to forward slashes so policy paths work on Windows too.
    const packageRelativePath = relative(root, packagePath).split(sep).join("/");
    seen.add(packageRelativePath);
    const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
    const expected = EXPECTED_PACKAGE_POLICIES.get(packageRelativePath);

    if (expected === undefined) {
      failures.push(
        `${packageRelativePath} is not covered by scripts/check-package-license-policy.mjs; add an explicit expected license`,
      );
      continue;
    }
    if (packageJson.license !== expected.license) {
      failures.push(
        `${packageRelativePath} declares license ${JSON.stringify(packageJson.license)}; expected ${JSON.stringify(expected.license)}`,
      );
    }
    if (packageJson.author !== expected.author) {
      failures.push(
        `${packageRelativePath} declares author ${JSON.stringify(packageJson.author)}; expected ${JSON.stringify(expected.author)}`,
      );
    }
    if (packageJson.copyright !== FIRST_PARTY_COPYRIGHT) {
      failures.push(
        `${packageRelativePath} declares copyright ${JSON.stringify(packageJson.copyright)}; expected ${JSON.stringify(FIRST_PARTY_COPYRIGHT)}`,
      );
    }
  }

  for (const expectedPath of EXPECTED_PACKAGE_POLICIES.keys()) {
    if (!seen.has(expectedPath)) {
      failures.push(`${expectedPath} is missing; update the package license policy`);
    }
  }

  const licensePath = join(root, "LICENSE");
  if (!existsSync(licensePath)) {
    failures.push("LICENSE is missing");
  } else {
    const license = readFileSync(licensePath, "utf8");
    if (!license.startsWith("MIT License\n")) {
      failures.push("LICENSE must contain the MIT License");
    }
    if (!license.includes(LICENSE_COPYRIGHT)) {
      failures.push(`LICENSE must contain ${JSON.stringify(LICENSE_COPYRIGHT)}`);
    }
  }

  const electronBuilderPath = join(root, "apps", "desktop", "electron-builder.yml");
  if (!existsSync(electronBuilderPath)) {
    failures.push("apps/desktop/electron-builder.yml is missing");
  } else {
    const electronBuilder = readFileSync(electronBuilderPath, "utf8");
    for (const expectedAttribution of [
      `copyright: "${FIRST_PARTY_COPYRIGHT}."`,
      `NSHumanReadableCopyright: "${FIRST_PARTY_COPYRIGHT}."`,
      `maintainer: ${FIRST_PARTY_OWNER}`,
    ]) {
      if (!electronBuilder.includes(expectedAttribution)) {
        failures.push(
          `apps/desktop/electron-builder.yml must contain ${JSON.stringify(expectedAttribution)}`,
        );
      }
    }
  }

  return failures.sort((a, b) => a.localeCompare(b));
}

function trackedMatches(root, name) {
  const result = spawnSync(
    "git",
    ["grep", "-I", "-i", "-n", "-e", name, "--", "."],
    { cwd: root, encoding: "utf8" },
  );
  if (result.error) {
    throw new Error(`failed to scan tracked files: ${result.error.message}`);
  }
  if (result.status === 1) return [];
  if (result.status !== 0) {
    throw new Error(
      `failed to scan tracked files for ${JSON.stringify(name)}: ${result.stderr.trim()}`,
    );
  }
  return result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf(":");
      return {
        line,
        path: separator === -1 ? line : line.slice(0, separator),
      };
    });
}

export function checkFirstPartyNamePolicy(root = repoRoot) {
  const failures = [];
  for (const name of PROHIBITED_NAMES) {
    for (const match of trackedMatches(root, name)) {
      failures.push(`prohibited name ${JSON.stringify(name)} appears at ${match.line}`);
    }
  }
  for (const match of trackedMatches(root, PUBLIC_DEPENDENCY_VENDOR)) {
    if (!PUBLIC_DEPENDENCY_REFERENCE_PATHS.has(match.path)) {
      failures.push(
        `unexpected public-dependency vendor reference appears at ${match.line}`,
      );
    }
  }
  return failures.sort((a, b) => a.localeCompare(b));
}

function runCli() {
  const failures = [
    ...checkPackageLicensePolicy(),
    ...checkFirstPartyNamePolicy(),
  ].sort((a, b) => a.localeCompare(b));
  if (failures.length > 0) {
    console.error("package license policy check failed:");
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exit(1);
  }

  console.log("package license policy check passed");
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runCli();
}
