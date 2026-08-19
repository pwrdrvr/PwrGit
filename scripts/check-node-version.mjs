#!/usr/bin/env node
// Fails `pnpm install` when the active Node is not the one `.nvmrc` pins.
//
// Native modules (better-sqlite3) are compiled against the ABI of whichever
// Node ran the install. A non-interactive shell usually has no nvm at all, so
// `node` is whatever the machine defaults to — and a wrong-ABI build does not
// surface until much later, as a test failure or a launch crash that reads
// like a broken database. Fail here, where the cause is still obvious.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pinned = readFileSync(resolve(repoRoot, ".nvmrc"), "utf8").trim();

// `.nvmrc` may pin a major (`24`) or an exact version (`v24.14.1`); compare at
// whatever precision it asks for.
const wanted = pinned.replace(/^v/, "").split(".");
const active = process.version.replace(/^v/, "").split(".");
if (!wanted.every((part, i) => active[i] === part)) {
  fail([
    `expected Node ${pinned} from .nvmrc, got ${process.version}.`,
    "Run: source ~/.nvm/nvm.sh && nvm use",
    "Then re-run pnpm install from the repo root."
  ]);
}

// CI installs Node without nvm, so only developer machines that have nvm at
// all are held to running Node from it — a system Node that happens to match
// the pinned major still drifts out from under `nvm use` later. Both sides are
// resolved through realpath first: `process.execPath` comes back with symlinks
// already resolved, so an `~/.nvm` that is itself a symlink (a dev volume, a
// dotfiles farm) would otherwise fail a Node that nvm really did activate.
const nvmDir = process.env.NVM_DIR || resolve(process.env.HOME ?? "", ".nvm");
const inCi = process.env.CI === "true" || process.env.CI === "1";
if (!inCi && existsSync(nvmDir)) {
  const nvmRoot = realpath(nvmDir);
  const nodePath = realpath(process.execPath);
  if (!nodePath.startsWith(nvmRoot.endsWith(sep) ? nvmRoot : `${nvmRoot}${sep}`)) {
    fail([
      `Node ${process.version} is not running from nvm.`,
      `  node: ${nodePath}`,
      `  nvm:  ${nvmRoot}`,
      "Run: source ~/.nvm/nvm.sh && nvm use"
    ]);
  }
}

function realpath(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function fail(lines) {
  console.error(["[check-node-version]", ...lines].join("\n"));
  process.exit(1);
}
