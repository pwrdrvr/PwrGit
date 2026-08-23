import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

let resolved: string | undefined;

/**
 * Path to the runtime-specific better-sqlite3 binary, or `undefined` when an
 * install has no local source build to select.
 *
 * In a dev tree those two are different builds on purpose: `build/Release`
 * stays compiled for the developer's Node so `vitest` can open a database,
 * and `scripts/rebuild-native-for-electron.mjs` puts the Electron build in
 * `electron-native/` for the app. Packaged builds ship only `build/Release`
 * (already Electron-compatible), which is also the safe fallback now that
 * better-sqlite3 uses Node-API rather than a runtime-specific V8 ABI.
 */
export function getNativeBinding(): string | undefined {
  if (resolved !== undefined) {
    return resolved || undefined;
  }

  const require = createRequire(import.meta.url);
  const packageJsonPath = require.resolve("better-sqlite3/package.json");
  const moduleDir = dirname(packageJsonPath);
  const sourceBuild = join(moduleDir, "build", "Release", "better_sqlite3.node");

  if (!("electron" in process.versions)) {
    resolved = existsSync(sourceBuild) ? sourceBuild : "";
    return resolved || undefined;
  }

  const sidecar = join(moduleDir, "electron-native", "better_sqlite3.node");
  const metadata = join(moduleDir, "electron-native", "metadata.json");

  if (existsSync(sidecar) && isCurrent(metadata, require(packageJsonPath).version)) {
    resolved = sidecar;
    return sidecar;
  }

  resolved = existsSync(sourceBuild) ? sourceBuild : "";
  return resolved || undefined;
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
