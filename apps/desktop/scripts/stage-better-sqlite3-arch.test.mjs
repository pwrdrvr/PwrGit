import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stageBetterSqlite3 } from "./stage-better-sqlite3-arch.mjs";

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("better-sqlite3 package architecture staging", () => {
  it("replaces build/Release with each requested Node-API prebuild", () => {
    const appDir = createApp();
    const stale = join(sqliteDir(appDir), "build", "Release", ".forge-meta");
    write(stale, "stale electron-rebuild marker");

    stageBetterSqlite3({ appDir, platform: "darwin", arch: "x64" });
    expect(readStagedBinary(appDir)).toBe("darwin-x64");
    expect(existsSync(stale)).toBe(false);

    stageBetterSqlite3({ appDir, platform: "darwin", arch: "arm64" });
    expect(readStagedBinary(appDir)).toBe("darwin-arm64");
    expect(
      existsSync(join(sqliteDir(appDir), "prebuilds", "darwin-x64.node")),
    ).toBe(true);
  });

  it("stages the Windows x64 prebuild used by the release runner", () => {
    const appDir = createApp();

    stageBetterSqlite3({ appDir, platform: "win32", arch: "x64" });

    expect(readStagedBinary(appDir)).toBe("win32-x64");
  });

  it("fails when the target architecture has no packaged binary", () => {
    const appDir = createApp();

    expect(() =>
      stageBetterSqlite3({ appDir, platform: "linux", arch: "x64" }),
    ).toThrow("better-sqlite3 has no packaged Node-API binary for linux-x64");
  });
});

function createApp() {
  const appDir = mkdtempSync(join(tmpdir(), "pwrgit-sqlite-package-"));
  roots.push(appDir);
  const sqlite = sqliteDir(appDir);
  write(
    join(sqlite, "package.json"),
    `${JSON.stringify({ version: "13.0.3", gypfile: false })}\n`,
  );
  for (const arch of ["x64", "arm64"]) {
    write(join(sqlite, "prebuilds", `darwin-${arch}.node`), `darwin-${arch}`);
  }
  write(join(sqlite, "prebuilds", "win32-x64.node"), "win32-x64");
  return appDir;
}

function readStagedBinary(appDir) {
  return readFileSync(
    join(sqliteDir(appDir), "build", "Release", "better_sqlite3.node"),
    "utf8",
  );
}

function sqliteDir(appDir) {
  return join(appDir, "node_modules", "better-sqlite3");
}

function write(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}
