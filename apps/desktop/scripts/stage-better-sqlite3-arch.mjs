/**
 * Stage one better-sqlite3 v13 Node-API binary at the package's conventional
 * build/Release path before electron-builder collects production files.
 *
 * v13 ships every supported platform/arch prebuild in the package and opts
 * out of electron-rebuild's implicit source build. Packaging that directory
 * unchanged breaks @electron/universal because both temporary macOS apps
 * contain the same foreign-arch native files. For each real architecture
 * pass, copy only its prebuild to the common path that PwrGit selects at
 * runtime. electron-builder.yml excludes the original prebuilds directory,
 * and @electron/universal lipo-merges the two Darwin slices at the common path.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";

const SUPPORTED_ARCHES = new Set(["x64", "arm64"]);

export function stageBetterSqlite3({ appDir, platform, arch }) {
  const sqliteDir = join(appDir, "node_modules", "better-sqlite3");
  const { packageJson, prebuild } = resolveBetterSqlite3Prebuild({
    sqliteDir,
    platform,
    arch,
  });

  const buildDir = join(sqliteDir, "build");
  const releaseDir = join(buildDir, "Release");
  const target = join(releaseDir, "better_sqlite3.node");
  rmSync(buildDir, { recursive: true, force: true });
  mkdirSync(releaseDir, { recursive: true });
  copyFileSync(prebuild, target);

  console.log(
    `  beforePack: staged better-sqlite3 ${packageJson.version} prebuild for ${platform}-${arch}`,
  );
  return target;
}

export function resolveBetterSqlite3Prebuild({ sqliteDir, platform, arch }) {
  const packagePath = join(sqliteDir, "package.json");
  if (!existsSync(packagePath)) {
    throw new Error(`better-sqlite3 package is missing at ${sqliteDir}`);
  }

  const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
  if (packageJson.gypfile !== false) {
    throw new Error(
      `better-sqlite3 ${packageJson.version} does not expose the v13 Node-API prebuild layout`,
    );
  }
  if (!SUPPORTED_ARCHES.has(arch)) {
    throw new Error(`Unsupported better-sqlite3 package architecture: ${arch}`);
  }

  const prebuild = join(sqliteDir, "prebuilds", `${platform}-${arch}.node`);
  if (!existsSync(prebuild)) {
    throw new Error(
      `better-sqlite3 has no packaged Node-API binary for ${platform}-${arch}`,
    );
  }
  return { packageJson, prebuild };
}
