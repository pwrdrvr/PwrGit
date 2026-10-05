import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import beforePack from "./beforepack-dugite-arch.mjs";

test.each([[1, "x64"], [3, "arm64"]])("Linux %s packaging selects SQLite and prunes unused GCM without a Darwin download", async (archEnum, arch) => {
  const root = mkdtempSync(join(tmpdir(), "pwrgit-linux-hook-"));
  try {
    const sqlite = join(root, "node_modules", "better-sqlite3");
    mkdirSync(join(sqlite, "prebuilds"), { recursive: true });
    writeFileSync(join(sqlite, "package.json"), JSON.stringify({ version: "13.0.3", gypfile: false }));
    writeFileSync(join(sqlite, "prebuilds", `linux-${arch}.node`), arch);
    const core = join(root, "node_modules", "dugite", "git", "libexec", "git-core");
    mkdirSync(join(core, "mergetools"), { recursive: true });
    for (const name of ["git", "git-lfs", "scalar", "git-credential-manager", "libSkiaSharp.so", "libHarfBuzzSharp.so", "System.Runtime.dll"]) writeFileSync(join(core, name), name);
    symlinkSync("git", join(core, "git-checkout"));
    await beforePack({ arch: archEnum, electronPlatformName: "linux", packager: { info: { appDir: root } } });
    expect(readFileSync(join(sqlite, "build", "Release", "better_sqlite3.node"), "utf8")).toBe(arch);
    expect(readdirSync(core).sort()).toEqual(["git", "git-checkout", "git-lfs", "mergetools", "scalar"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
