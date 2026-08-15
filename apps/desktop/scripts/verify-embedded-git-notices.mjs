#!/usr/bin/env node
// Checks the non-npm Git runtime resources after electron-builder has copied
// them. This keeps the notices tied to the same payload as the bundled Git.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// The protected Windows signing job receives a prepared release-stage rather
// than the workspace package tree. Allow release.mjs to point this verifier at
// the notices already copied into that verified stage.
const noticeSourceRoot = process.env.PWRGIT_NOTICE_SOURCE_ROOT?.trim()
  ? resolve(process.env.PWRGIT_NOTICE_SOURCE_ROOT)
  : desktopRoot;
const noticeSourceDir = join(noticeSourceRoot, "resources", "embedded-git");
const requiredNotices = [
  "COPYING",
  "LICENSE.git-lfs",
  "LICENSE.git-credential-manager",
  "NOTICE",
];

function resolveGitRuntimeDir(appPath) {
  const macPath = join(appPath, "Contents", "Resources", "git");
  if (existsSync(macPath)) return macPath;
  return join(appPath, "resources", "git");
}

export function verifyEmbeddedGitNotices(appPath) {
  const runtimeDir = resolveGitRuntimeDir(resolve(appPath));
  const failures = [];

  for (const file of requiredNotices) {
    const sourcePath = join(noticeSourceDir, file);
    const packagedPath = join(runtimeDir, file);
    if (!existsSync(sourcePath)) {
      failures.push(`source notice is missing: ${relative(noticeSourceRoot, sourcePath)}`);
      continue;
    }
    if (!existsSync(packagedPath)) {
      failures.push(`packaged Git runtime notice is missing: ${packagedPath}`);
      continue;
    }
    if (!readFileSync(sourcePath).equals(readFileSync(packagedPath))) {
      failures.push(`packaged Git runtime notice differs from source: ${file}`);
    }
  }

  return failures;
}

const appPath = process.argv[2];
if (!appPath) {
  console.error("usage: verify-embedded-git-notices.mjs <packaged-app-path>");
  process.exit(1);
}

const failures = verifyEmbeddedGitNotices(appPath);
if (failures.length > 0) {
  console.error("embedded Git runtime notice verification failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("embedded Git runtime notices verified");
