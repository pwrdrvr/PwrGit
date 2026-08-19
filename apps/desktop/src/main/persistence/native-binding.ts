import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

let resolved: string | undefined;

/**
 * Path to the Electron-ABI better-sqlite3 binary, or `undefined` to let
 * better-sqlite3 load its default `build/Release` one.
 *
 * In a dev tree those two are different builds on purpose: `build/Release`
 * stays compiled for the developer's Node so `vitest` can open a database,
 * and `scripts/rebuild-native-for-electron.mjs` puts the Electron build in
 * `electron-native/` for the app. Packaged builds ship only `build/Release`
 * (already Electron's ABI, rebuilt per arch by electron-builder), so this
 * returns `undefined` there.
 */
export function getNativeBinding(): string | undefined {
  if (resolved !== undefined) {
    return resolved || undefined;
  }

  if (!("electron" in process.versions)) {
    resolved = "";
    return undefined;
  }

  const require = createRequire(import.meta.url);
  const packageJsonPath = require.resolve("better-sqlite3/package.json");
  const moduleDir = dirname(packageJsonPath);
  const sidecar = join(moduleDir, "electron-native", "better_sqlite3.node");
  const metadata = join(moduleDir, "electron-native", "metadata.json");

  if (existsSync(sidecar) && isCurrent(metadata, require(packageJsonPath).version)) {
    resolved = sidecar;
    return sidecar;
  }

  resolved = "";
  return undefined;
}

/**
 * A sidecar left over from another Electron version, better-sqlite3 version,
 * or architecture is worse than no sidecar — loading it fails at `new
 * Database()` with an ABI error, while ignoring it falls back to a binary that
 * may well be right.
 */
function isCurrent(metadataPath: string, betterSqlite3Version: string): boolean {
  if (!existsSync(metadataPath)) {
    return false;
  }

  try {
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    return (
      metadata.arch === process.arch &&
      metadata.betterSqlite3Version === betterSqlite3Version &&
      metadata.electronVersion === process.versions.electron
    );
  } catch {
    return false;
  }
}
