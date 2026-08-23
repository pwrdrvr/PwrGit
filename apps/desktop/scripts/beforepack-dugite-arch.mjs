#!/usr/bin/env node
/**
 * electron-builder beforePack hook: stage native payloads for the architecture
 * being packed.
 *
 * better-sqlite3 v13 ships all platform/arch Node-API prebuilds and its normal
 * Electron rebuild removes build/Release without replacing it. Every platform
 * pass copies the target prebuild to build/Release before dependency files are
 * collected; electron-builder.yml disables the destructive rebuild and drops
 * the original multi-arch prebuild directory.
 *
 * dugite's postinstall downloads a single-arch git distribution matching the
 * install host (e.g. darwin-arm64 on an Apple Silicon runner), so the
 * release-stage starts with only that slice. A `--mac --universal` build packs
 * an x64 tree and an arm64 tree from the same stage and then merges them with
 * @electron/universal — without this hook both trees would carry the host's
 * git and Intel Macs would receive arm64 binaries.
 *
 * For each darwin arch pass this hook wipes node_modules/dugite/git and
 * re-runs dugite's own download script with `npm_config_arch` set (dugite
 * supports it for exactly this cross-compilation case). The two trees then
 * differ only in Mach-O contents, which @electron/universal lipo-merges into
 * universal binaries. release.mjs verifies the merged git with
 * `lipo -verify_arch x86_64 arm64` afterwards.
 *
 * Windows/Linux dugite packs run on a host whose platform+arch already match
 * the target, so only the better-sqlite3 staging applies there.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stageBetterSqlite3 } from "./stage-better-sqlite3-arch.mjs";

// electron-builder's Arch enum, by value. Not imported from electron-builder
// because this hook runs inside the production-only release-stage where
// electron-builder itself is not installed.
const ARCH_NAMES = { 0: "ia32", 1: "x64", 2: "armv7l", 3: "arm64", 4: "universal" };

export default async function beforePack(context) {
  const arch = ARCH_NAMES[context.arch];
  if (arch !== "x64" && arch !== "arm64") {
    // The universal pass is the @electron/universal merge of the two real
    // packs; nothing to download for it.
    return;
  }

  // The stage being packed: electron-builder's project dir when available,
  // else this script's parent (the hook file is copied into the stage by
  // `pnpm deploy`, so both resolve to the same place there).
  const appDir =
    context.packager?.info?.appDir ??
    resolve(dirname(fileURLToPath(import.meta.url)), "..");

  stageBetterSqlite3({
    appDir,
    platform: context.electronPlatformName,
    arch,
  });

  if (context.electronPlatformName !== "darwin") {
    return;
  }

  const dugiteDir = join(appDir, "node_modules", "dugite");
  const downloadScript = join(dugiteDir, "script", "download-git.js");
  if (!existsSync(downloadScript)) {
    throw new Error(`dugite download script missing at ${downloadScript}`);
  }

  console.log(`  beforePack: staging dugite embedded git for darwin-${arch}`);
  rmSync(join(dugiteDir, "git"), { recursive: true, force: true });

  const result = spawnSync(process.execPath, [downloadScript], {
    cwd: dugiteDir,
    stdio: "inherit",
    env: {
      ...process.env,
      npm_config_arch: arch,
      // Cache the per-arch tarballs so the second universal build pass (and
      // repeated local builds) don't re-download ~50 MB each time.
      DUGITE_CACHE_DIR: process.env.DUGITE_CACHE_DIR ?? join(tmpdir(), "dugite-arch-cache"),
    },
  });
  if (result.status !== 0) {
    throw new Error(`dugite download-git failed for darwin-${arch} (exit ${result.status})`);
  }

  const gitBinary = join(dugiteDir, "git", "bin", "git");
  if (!existsSync(gitBinary)) {
    throw new Error(`dugite download completed but ${gitBinary} is missing`);
  }

  // Prune Git Credential Manager from the distribution. GCM is a
  // self-contained .NET deployment (~104 MB of *.dll, .NET runtime dylibs,
  // Avalonia UI, and per-culture resource dirs strewn through
  // libexec/git-core) whose IL assemblies and deps.json are arch-specific,
  // and @electron/universal hard-fails when any non-Mach-O file differs
  // between the x64 and arm64 trees (only Mach-O files get the x64ArchFiles
  // escape hatch). Nothing configures GCM as a default helper (dugite's
  // etc/gitconfig doesn't set credential.helper) and PwrGit supplies
  // credentials through its own GitExec environment, so dropping it is safe.
  // Everything that is genuinely git's in git-core starts with git/scalar or
  // is the mergetools dir; keep those, drop the rest (and GCM's git-prefixed
  // entrypoints explicitly).
  const gitCore = join(dugiteDir, "git", "libexec", "git-core");
  let pruned = 0;
  for (const entry of readdirSync(gitCore)) {
    const isGitFile = /^(git|scalar|mergetools)/.test(entry);
    const isGcmEntrypoint = entry.startsWith("git-credential-manager");
    if (!isGitFile || isGcmEntrypoint) {
      rmSync(join(gitCore, entry), { recursive: true, force: true });
      pruned += 1;
    }
  }
  console.log(`  beforePack: pruned ${pruned} Git Credential Manager files from git-core`);
}
