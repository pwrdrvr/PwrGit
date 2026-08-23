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
 *                       package/sign an already prepared release-stage without
 *                       reinstalling dependencies or rerunning tests. Defaults
 *                       to macOS; combine with --win for Windows NSIS.
 *       --win         : build/package a Windows x64 NSIS installer (unsigned
 *                       unless Azure signing env is present; no publish). Run
 *                       on a Windows host/runner.
 *       --win --publish:
 *                       Azure-signed installer, published via electron-builder.
 *       --require-signing:
 *                       fail unless the complete Azure signing configuration is
 *                       present. Release CI always passes this flag.
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
 *
 * better-sqlite3: v13 ships platform/arch Node-API prebuilds and does not let
 * electron-rebuild populate build/Release. The beforePack hook copies the
 * target slice to that common runtime path and excludes the multi-arch source
 * directory; @electron/universal then lipo-merges the two Darwin slices. The
 * same universal-binary verification below covers the result.
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
const explicitPublish = args.includes("--publish");
const winPublish = win && explicitPublish;
const requireSigning = args.includes("--require-signing") || winPublish;

if (prepareOnly && signStageOnly) {
  throw new Error("--prepare-only and --sign-stage-only cannot be combined");
}
if (explicitPublish && !win) {
  throw new Error("--publish is a Windows sub-mode; add --win");
}
if (args.includes("--unsigned-release")) {
  throw new Error("--unsigned-release was removed; signed releases must fail closed");
}
if (requireSigning && !win) {
  throw new Error("--require-signing is a Windows sub-mode; add --win");
}
if (winPublish && noPublish) {
  throw new Error("--publish and --no-publish cannot be combined");
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
    // Only pnpm is a .cmd shim on Windows. Keep node shell-free so Azure
    // signing arguments containing spaces (publisherName=PwrDrvr LLC) remain
    // one argument instead of being split by cmd.exe.
    shell: process.platform === "win32" && file === "pnpm",
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
  // Windows signing receives a self-contained, hoisted release-stage archive
  // instead of the workspace's pnpm symlink graph. Its signing job must not
  // install dependencies, so use the staged electron-builder toolchain there.
  const cli = signStageOnly && win
    ? join(stageDir, "node_modules", "electron-builder", "cli.js")
    : join(desktopRoot, "node_modules", "electron-builder", "cli.js");
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

function assertWindowsReleaseInputs() {
  if (process.platform !== "win32") {
    throw new Error("Windows release packaging must run on Windows so native packaging is exercised.");
  }

  if (winPublish && !process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
    throw new Error("--publish requires GH_TOKEN or GITHUB_TOKEN so electron-builder can upload artifacts.");
  }
}

// Azure Artifact Signing was originally named Trusted Signing. All four
// WIN_AZURE_SIGN_* values and all three AZURE_* service-principal credentials
// are required together. None means an intentional unsigned local build; any
// partial configuration is always an error.
function resolveWindowsAzureSigning() {
  const config = {
    WIN_AZURE_SIGN_PUBLISHER_NAME:
      process.env.WIN_AZURE_SIGN_PUBLISHER_NAME?.trim(),
    WIN_AZURE_SIGN_ENDPOINT: process.env.WIN_AZURE_SIGN_ENDPOINT?.trim(),
    WIN_AZURE_SIGN_ACCOUNT: process.env.WIN_AZURE_SIGN_ACCOUNT?.trim(),
    WIN_AZURE_SIGN_PROFILE: process.env.WIN_AZURE_SIGN_PROFILE?.trim(),
  };
  const missingConfig = Object.entries(config)
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missingConfig.length === Object.keys(config).length) {
    return undefined;
  }
  if (missingConfig.length > 0) {
    throw new Error(
      `Windows signing is partially configured — missing: ${missingConfig.join(", ")}. ` +
        "Set all WIN_AZURE_SIGN_* values or none to build unsigned.",
    );
  }

  const missingCredentials = Object.entries({
    AZURE_TENANT_ID: process.env.AZURE_TENANT_ID?.trim(),
    AZURE_CLIENT_ID: process.env.AZURE_CLIENT_ID?.trim(),
    AZURE_CLIENT_SECRET: process.env.AZURE_CLIENT_SECRET?.trim(),
  })
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missingCredentials.length > 0) {
    throw new Error(
      `Windows signing is configured but service-principal credentials are missing: ${missingCredentials.join(", ")}. ` +
        "Unset WIN_AZURE_SIGN_* to build unsigned instead.",
    );
  }

  return {
    publisherName: config.WIN_AZURE_SIGN_PUBLISHER_NAME,
    endpoint: config.WIN_AZURE_SIGN_ENDPOINT,
    accountName: config.WIN_AZURE_SIGN_ACCOUNT,
    profileName: config.WIN_AZURE_SIGN_PROFILE,
  };
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

if (!signStageOnly) {
  // 1. Check license notices before doing expensive release work.
  step("license notices check");
  runChecked("pnpm", ["licenses:check"], { cwd: repoRoot });

  // 2. Build (electron-vite -> apps/desktop/out/).
  step("electron-vite build");
  runChecked("pnpm", ["--filter", "@pwrgit/desktop", "build"], { cwd: repoRoot });

  // 3. Materialize the release stage. Windows must include electron-builder in
  // the staged tree: its protected signing job receives only this tree, and
  // Windows tar follows pnpm's workspace junctions when workspace node_modules
  // are archived. A hoisted deploy avoids that junction graph while leaving
  // package-manager work outside the credential boundary.
  const deployArgs = [
    "deploy",
    "--filter",
    "@pwrgit/desktop",
    "--legacy",
  ];
  if (win) {
    deployArgs.push("--config.node-linker=hoisted");
  } else {
    deployArgs.push("--prod");
  }
  deployArgs.push(stageDir);
  step(`pnpm ${win ? "deploy (hoisted)" : "deploy --prod"} -> release-stage`);
  if (existsSync(stageDir)) {
    rmSync(stageDir, { recursive: true, force: true });
  }
  mkdirSync(stageDir, { recursive: true });
  runChecked("pnpm", deployArgs, { cwd: repoRoot });

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
  assertWindowsReleaseInputs();
  const azureSign = resolveWindowsAzureSigning();
  // The partial-config guard cannot catch a job that never joined the
  // windows-signing environment: every value is empty, indistinguishable from
  // an intentional unsigned local build. Release CI passes --require-signing
  // so that case fails instead of quietly publishing an unsigned installer.
  if (requireSigning && !azureSign) {
    throw new Error(
      "--require-signing was passed but no Windows signing configuration is present. " +
        "Check that the job declares `environment: windows-signing`.",
    );
  }
  step(
    `electron-builder --win nsis --x64 (${
      azureSign ? "Azure Artifact Signing" : "UNSIGNED"
    }, ${
      winPublish ? "publish" : "no publish"
    })`,
  );
  builderArgs.push("--win", "nsis", "--x64");
  builderArgs.push(winPublish ? "--publish" : "--publish=never", winPublish ? "always" : "");
  if (azureSign) {
    builderArgs.push(
      `--config.win.azureSignOptions.publisherName=${azureSign.publisherName}`,
      `--config.win.azureSignOptions.endpoint=${azureSign.endpoint}`,
      `--config.win.azureSignOptions.codeSigningAccountName=${azureSign.accountName}`,
      `--config.win.azureSignOptions.certificateProfileName=${azureSign.profileName}`,
    );
  }
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
  runChecked(
    "node",
    [join(desktopRoot, "scripts", "verify-asar-contents.mjs"), builtApp],
    { env: { PWRGIT_ASAR_MODULE_ROOT: stageDir } },
  );

  step("verify embedded Git runtime notices");
  runChecked(
    "node",
    [join(desktopRoot, "scripts", "verify-embedded-git-notices.mjs"), builtApp],
    { env: { PWRGIT_NOTICE_SOURCE_ROOT: stageDir } },
  );

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
