#!/usr/bin/env node
/**
 * PwrGit desktop release orchestrator, ported from PwrAgnt/PwrSnap.
 *
 * Why this script exists:
 *   - electron-builder's default node_modules walk does not understand pnpm's
 *     symlinked virtual store (`.pnpm/...`). Running it against the workspace
 *     root produces broken bundles. The fix is to first run `pnpm deploy` to
 *     materialize a flat node_modules tree under a stage dir, then point
 *     electron-builder at the stage. This script encapsulates that.
 *   - Modes:
 *       --dryrun      : build + package unsigned (ad-hoc), no publish
 *       --no-publish  : build + package signed/notarized, no publish
 *       --prepare-only: build + prepare release-stage, no package/sign/publish
 *       --sign-stage-only:
 *                       sign/notarize/publish an already prepared release-stage
 *                       without reinstalling dependencies or rerunning tests
 *       --win         : build/package a Windows x64 NSIS installer (unsigned,
 *                       no publish). Run on a Windows host/runner.
 *       --win --publish:
 *                       Authenticode-signed installer, published via
 *                       electron-builder (requires WIN_CSC_LINK /
 *                       WIN_CSC_KEY_PASSWORD or CSC_LINK/CSC_KEY_PASSWORD).
 *       --win --unsigned-release:
 *                       release-shaped installer without Authenticode and
 *                       without publishing. Only for the pre-signing-cert
 *                       phase; the workflow uploads it under an
 *                       `-unsigned-setup.exe` name.
 *       (default)     : build + package signed/notarized + publish to the
 *                       channel configured in electron-builder.yml
 *   - In CI, the App Store Connect API key may arrive as a base64-encoded
 *     env var (`APPLE_API_KEY_BASE64`) instead of a file path. This script
 *     decodes it to a temp file and re-exports `APPLE_API_KEY` for
 *     electron-builder before invoking it.
 *
 * dugite: the embedded git distribution is downloaded per-arch at install
 * time, so the staged copy matches the runner's arch only. The beforePack
 * hook (scripts/beforepack-dugite-arch.mjs, wired in electron-builder.yml)
 * re-downloads the right slice for each macOS arch pass; @electron/universal
 * then lipo-merges the Mach-O git binaries. The lipo verification below
 * fails the build loudly if that ever regresses.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const desktopRoot = resolve(__dirname, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const stageDir = join(desktopRoot, "release-stage");

const args = process.argv.slice(2);
const dryrun = args.includes("--dryrun");
const noPublish = args.includes("--no-publish");
const prepareOnly = args.includes("--prepare-only");
const signStageOnly = args.includes("--sign-stage-only");
const win = args.includes("--win");
const winPublish = args.includes("--publish");
const winUnsignedRelease = args.includes("--unsigned-release");

if (prepareOnly && signStageOnly) {
  throw new Error("--prepare-only and --sign-stage-only cannot be combined");
}
if (win && signStageOnly) {
  throw new Error("--win cannot be combined with --sign-stage-only");
}
if ((winPublish || winUnsignedRelease) && !win) {
  throw new Error("--publish/--unsigned-release are Windows sub-modes; add --win");
}
if (winPublish && winUnsignedRelease) {
  throw new Error("--publish and --unsigned-release cannot be combined");
}

const publish = !dryrun && !noPublish && !prepareOnly && (!win || winPublish);

function step(label) {
  console.log(`\n→ ${label}`);
}

function runChecked(file, args, opts = {}) {
  console.log(`  $ ${file} ${args.join(" ")}`);
  const result = spawnSync(file, args, {
    stdio: "inherit",
    cwd: opts.cwd ?? desktopRoot,
    env: { ...process.env, ...opts.env },
    // On Windows `pnpm` is a .cmd shim that spawnSync only resolves through a
    // shell (and Node refuses to spawn .cmd without one). Repo/stage paths here
    // contain no spaces, so unquoted shell args are safe.
    shell: process.platform === "win32",
  });
  if (result.error) {
    console.error(`  ! failed to spawn ${file}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function electronBuilderCli() {
  const cli = join(desktopRoot, "node_modules", "electron-builder", "cli.js");
  if (!existsSync(cli)) {
    throw new Error(
      `electron-builder CLI is missing at ${cli}; run \`pnpm install\` from the repo root first`,
    );
  }
  return cli;
}

function findWindowsUnpackedDir(distDir) {
  const candidates = readdirSync(distDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^win(?:-.+)?-unpacked$/.test(entry.name))
    .map((entry) => join(distDir, entry.name))
    .sort();
  if (candidates.length === 0) {
    throw new Error(`No windows unpacked app directory found under ${distDir}`);
  }
  return candidates[0];
}

function windowsInstallerArtifacts(distDir) {
  const artifacts = readdirSync(distDir)
    .filter((entry) => entry.endsWith("-setup.exe"))
    .sort()
    .map((name) => ({ name, path: join(distDir, name) }));
  if (artifacts.length === 0) {
    throw new Error(
      `electron-builder reported success but produced no *-setup.exe in ${distDir}. ` +
        `Check the electron-builder output above (icon conversion, native rebuilds).`,
    );
  }
  return artifacts;
}

function writeWindowsChecksums(distDir) {
  const artifacts = windowsInstallerArtifacts(distDir);
  const lines = artifacts
    .map(({ name, path }) => {
      const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
      return `${digest}  ${name}`;
    })
    .join("\n");
  const checksumPath = join(distDir, "SHA256SUMS");
  writeFileSync(checksumPath, `${lines}\n`);
  return checksumPath;
}

function assertWindowsReleaseInputs({ requireSigning }) {
  if (process.platform !== "win32") {
    throw new Error("Windows release packaging must run on Windows so native packaging is exercised.");
  }

  const cscLink = process.env.WIN_CSC_LINK || process.env.CSC_LINK;
  const cscPassword = process.env.WIN_CSC_KEY_PASSWORD || process.env.CSC_KEY_PASSWORD;
  if (requireSigning && (!cscLink || !cscPassword)) {
    throw new Error(
      "Windows release packaging requires WIN_CSC_LINK/WIN_CSC_KEY_PASSWORD " +
        "(or CSC_LINK/CSC_KEY_PASSWORD) for Authenticode signing.",
    );
  }
  if (cscLink && cscPassword) {
    process.env.CSC_LINK ??= cscLink;
    process.env.CSC_KEY_PASSWORD ??= cscPassword;
  }

  if (winPublish && !process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
    throw new Error("--publish requires GH_TOKEN or GITHUB_TOKEN so electron-builder can upload artifacts.");
  }
}

// Decode CI-provided Apple API key (if present) to a real .p8 file.
function maybeDecodeAppleApiKey() {
  if (process.env.APPLE_API_KEY && existsSync(process.env.APPLE_API_KEY)) {
    return; // already a path; nothing to do
  }
  const base64 = process.env.APPLE_API_KEY_BASE64;
  if (!base64) {
    return; // not set; signing/notarize will fail later if it was needed
  }
  const keyId = process.env.APPLE_API_KEY_ID;
  if (!keyId) {
    throw new Error("APPLE_API_KEY_BASE64 is set but APPLE_API_KEY_ID is missing");
  }
  const target = join(tmpdir(), `AuthKey_${keyId}.p8`);
  writeFileSync(target, Buffer.from(base64, "base64"));
  chmodSync(target, 0o600);
  process.env.APPLE_API_KEY = target;
  console.log("  decoded APPLE_API_KEY_BASE64 -> temporary App Store Connect key file");
}

if (win && (winPublish || winUnsignedRelease)) {
  assertWindowsReleaseInputs({ requireSigning: !winUnsignedRelease });
}

if (!signStageOnly) {
  // 1. Check license notices before doing expensive release work.
  step("license notices check");
  runChecked("pnpm", ["licenses:check"], { cwd: repoRoot });

  // 2. Build (electron-vite -> apps/desktop/out/).
  step("electron-vite build");
  runChecked("pnpm", ["--filter", "@pwrgit/desktop", "build"], { cwd: repoRoot });

  // 3. Materialize a self-contained, flat node_modules under stage.
  step("pnpm deploy --prod -> release-stage");
  if (existsSync(stageDir)) {
    rmSync(stageDir, { recursive: true, force: true });
  }
  mkdirSync(stageDir, { recursive: true });
  runChecked(
    "pnpm",
    ["deploy", "--filter", "@pwrgit/desktop", "--prod", "--legacy", stageDir],
    { cwd: repoRoot },
  );

  // 4. Copy the build output, notices, changelog, and electron-builder inputs into the
  //    stage so electron-builder finds them at well-known paths. pnpm deploy
  //    copies the package source tree (including out/ if it exists) into the
  //    stage; remove stale copies before our controlled cp to avoid nesting.
  step("seed stage with build output + builder inputs");
  for (const dir of ["out", "build", "resources"]) {
    const target = join(stageDir, dir);
    if (existsSync(target)) {
      rmSync(target, { recursive: true, force: true });
    }
    cpSync(join(desktopRoot, dir), target, { recursive: true });
  }
  copyFileSync(
    join(desktopRoot, "electron-builder.yml"),
    join(stageDir, "electron-builder.yml"),
  );
  for (const file of ["LICENSE", "THIRD_PARTY_LICENSES", "CHANGELOG.md"]) {
    copyFileSync(join(repoRoot, file), join(stageDir, file));
  }

  if (prepareOnly) {
    step("prepared release-stage");
    console.log(`  stage: ${stageDir}`);
    process.exit(0);
  }
} else if (!existsSync(stageDir)) {
  throw new Error(`release-stage is missing at ${stageDir}`);
}

// 5. electron-builder.
const builderArgs = [];
if (win) {
  step(
    `electron-builder --win nsis --x64 (${
      winPublish ? "publish" : winUnsignedRelease ? "unsigned release, no publish" : "no publish"
    })`,
  );
  builderArgs.push("--win", "nsis", "--x64");
  builderArgs.push(winPublish ? "--publish" : "--publish=never", winPublish ? "always" : "");
} else {
  step(`electron-builder --mac --universal (${publish ? "publish" : "no publish"}, ${dryrun ? "ad-hoc signed" : "signed"})`);
  maybeDecodeAppleApiKey();
  builderArgs.push("--mac", "--universal");
  if (dryrun) {
    // Use ad-hoc signing (identity=-) instead of no signing (identity=null).
    // electron-builder modifies the Electron binary to set fuses, which
    // invalidates its original code signature. Without re-signing, macOS
    // kills the app with SIGKILL (Code Signature Invalid) on launch.
    // Hardened-runtime library validation rejects an ad-hoc signed Electron
    // Framework because neither it nor the main executable has a Developer ID
    // Team ID. Disable hardened runtime only for this disposable dry-run app;
    // signed release builds retain the electron-builder.yml setting.
    builderArgs.push(
      "--config.mac.identity=-",
      "--config.mac.notarize=false",
      "--config.mac.hardenedRuntime=false",
    );
  }
  builderArgs.push(publish ? "--publish" : "--publish=never", publish ? "always" : "");
}
const cleanedArgs = builderArgs.filter((arg) => arg !== "");
runChecked("node", [electronBuilderCli(), ...cleanedArgs], { cwd: stageDir });

// 6. Post-build checks — fail loudly if forbidden files leaked into the asar
//    or a native payload came out single-arch.
const dist = join(stageDir, "dist");

if (win) {
  const builtApp = findWindowsUnpackedDir(dist);

  step("verify packaged asar contents");
  runChecked("node", [join(desktopRoot, "scripts", "verify-asar-contents.mjs"), builtApp]);

  step("verify embedded Git runtime notices");
  runChecked("node", [join(desktopRoot, "scripts", "verify-embedded-git-notices.mjs"), builtApp]);

  step("verify installer artifact + write checksums");
  const checksumPath = writeWindowsChecksums(dist);
  console.log(`  checksum: ${checksumPath}`);

  step("done");
  console.log(`  artifacts: ${dist}`);
  process.exit(0);
}

const builtApp = join(dist, "mac-universal", "PwrGit.app");

step("verify universal binary slices");
const universalMachO = [
  join(builtApp, "Contents", "MacOS", "PwrGit"),
  join(
    builtApp,
    "Contents",
    "Resources",
    "app.asar.unpacked",
    "node_modules",
    "better-sqlite3",
    "build",
    "Release",
    "better_sqlite3.node",
  ),
  // dugite's embedded git must be universal or Intel Macs get an arm64 git
  // (or vice versa). Produced by the beforePack per-arch download + the
  // @electron/universal lipo merge, shipped via extraResources (see
  // electron-builder.yml).
  join(builtApp, "Contents", "Resources", "git", "bin", "git"),
];
for (const binary of universalMachO) {
  runChecked("lipo", [binary, "-verify_arch", "x86_64", "arm64"]);
}

step("verify packaged asar contents");
runChecked("node", [join(desktopRoot, "scripts", "verify-asar-contents.mjs"), builtApp]);

step("verify embedded Git runtime notices");
runChecked("node", [join(desktopRoot, "scripts", "verify-embedded-git-notices.mjs"), builtApp]);

step("done");
console.log(`  artifacts: ${dist}`);
