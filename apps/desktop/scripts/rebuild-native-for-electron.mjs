/**
 * Keep better-sqlite3's Node and Electron binaries side by side.
 *
 *   build/Release/better_sqlite3.node   → this machine's Node ABI (vitest, scripts)
 *   electron-native/better_sqlite3.node → Electron's ABI (what the app loads,
 *                                         via src/main/persistence/native-binding.ts)
 *
 * The Electron rebuild overwrites build/Release, so this script brackets it:
 * stash the Node binary, rebuild for Electron, copy the result into
 * electron-native/, put the Node binary back. Without that, the two runtimes
 * take turns invalidating each other's build and a single install cannot
 * serve both `pnpm test` and `pnpm dev`.
 *
 * Dev/test only. Packaged builds never load the sidecar: electron-builder
 * rebuilds build/Release itself, once per arch, and electron-builder.yml
 * excludes electron-native/ from the asar.
 */

import { execFileSync, execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const electronVersion = resolveElectronVersion();
if (!electronVersion) {
  // A production dependency tree (`pnpm deploy --prod`) has no Electron and no
  // use for the sidecar. Skipping beats failing an install that is only ever
  // fed to electron-builder.
  console.log("electron is not installed here; skipping the better-sqlite3 Electron sidecar.");
  process.exit(0);
}

const packageJsonPath = require.resolve("better-sqlite3/package.json", { paths: [desktopRoot] });
const moduleDir = dirname(packageJsonPath);
const betterSqlite3Package = require(packageJsonPath);
const betterSqlite3Version = betterSqlite3Package.version;

const releaseDir = join(moduleDir, "build", "Release");
const nodeBinary = join(releaseDir, "better_sqlite3.node");
// electron-rebuild's "already built for this ABI" marker. It describes
// build/Release, which we hand back to Node below, so it must not survive.
const forgeMeta = join(releaseDir, ".forge-meta");
// Keep the stash outside build/: better-sqlite3 13's build-release script
// starts with node-gyp clean, which removes the whole directory.
const stashedNodeBinary = join(moduleDir, ".pwrgit-node-abi.node");

const sidecarDir = join(moduleDir, "electron-native");
const sidecarBinary = join(sidecarDir, "better_sqlite3.node");
const sidecarMetadata = join(sidecarDir, "metadata.json");
const expectedMetadata = { arch: process.arch, betterSqlite3Version, electronVersion };

ensureNodeBinary();

if (sidecarIsCurrent()) {
  console.log(`better-sqlite3 Electron sidecar is current (Electron ${electronVersion}).`);
  process.exit(0);
}

console.log(`Rebuilding better-sqlite3 for Electron ${electronVersion} (${process.arch})...`);
copyFileSync(nodeBinary, stashedNodeBinary);

try {
  if (betterSqlite3Package.gypfile === false) {
    // v13 opts out of implicit node-gyp rebuilds because it ships N-API
    // prebuilds. Its explicit script forces a source build; target it at
    // Electron so the sidecar remains a separately verified runtime build.
    runBuildScript("build-release", {
      npm_config_runtime: "electron",
      npm_config_target: electronVersion,
      npm_config_dist_url: "https://electronjs.org/headers",
      npm_config_arch: process.arch,
      npm_config_target_arch: process.arch
    });
  } else {
    const { rebuild } = await import("@electron/rebuild");
    await rebuild({
      buildPath: desktopRoot,
      electronVersion,
      arch: process.arch,
      onlyModules: ["better-sqlite3"],
      force: true
    });
  }
  rmSync(sidecarDir, { force: true, recursive: true });
  mkdirSync(sidecarDir, { recursive: true });
  copyFileSync(nodeBinary, sidecarBinary);
  writeFileSync(sidecarMetadata, `${JSON.stringify(expectedMetadata, null, 2)}\n`);
} finally {
  copyFileSync(stashedNodeBinary, nodeBinary);
  rmSync(stashedNodeBinary, { force: true });
  rmSync(forgeMeta, { force: true });
}

console.log(`Electron better-sqlite3 binary placed at ${sidecarBinary}`);

function sidecarIsCurrent() {
  if (!existsSync(sidecarBinary) || !existsSync(sidecarMetadata)) {
    return false;
  }

  try {
    const metadata = JSON.parse(readFileSync(sidecarMetadata, "utf8"));
    return (
      metadata.arch === expectedMetadata.arch &&
      metadata.betterSqlite3Version === expectedMetadata.betterSqlite3Version &&
      metadata.electronVersion === expectedMetadata.electronVersion
    );
  } catch {
    return false;
  }
}

/**
 * build/Release must hold a binary this Node can load — it is both the input
 * we stash and what the unit tests import. A worktree whose last rebuild
 * targeted Electron (or another Node major) starts out with the wrong one.
 */
function ensureNodeBinary() {
  if (nodeBinaryIsUsable()) {
    return;
  }

  console.log("better-sqlite3's build/Release binary does not load under this Node; rebuilding it...");
  const buildScript = betterSqlite3Package.scripts?.["build-release"]
    ? "build-release"
    : "install";
  runBuildScript(buildScript, {
    npm_config_arch: process.arch,
    npm_config_runtime: "node",
    npm_config_target: process.versions.node,
    npm_config_target_arch: process.arch
  });

  if (!nodeBinaryIsUsable()) {
    throw new Error("better-sqlite3's build/Release binary is still unusable under this Node");
  }
}

function nodeBinaryIsUsable() {
  if (!existsSync(nodeBinary)) {
    return false;
  }

  try {
    execFileSync(
      process.execPath,
      [
        "-e",
        "const Database = require(process.argv[1]); new Database(':memory:', { nativeBinding: process.argv[2] }).close();",
        moduleDir,
        nodeBinary
      ],
      { stdio: "ignore" }
    );
    return true;
  } catch {
    return false;
  }
}

function runBuildScript(script, env) {
  execSync(`npm run ${script}`, {
    cwd: moduleDir,
    stdio: "inherit",
    env: { ...process.env, ...env }
  });
}

function resolveElectronVersion() {
  try {
    return require(require.resolve("electron/package.json", { paths: [desktopRoot] })).version;
  } catch {
    return undefined;
  }
}
