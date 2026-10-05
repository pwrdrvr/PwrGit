import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { expect, test, vi } from "vitest";
import { linuxArtifactName } from "./linux-release-artifacts.mjs";
import { verifyExtractedLinuxPayload } from "./verify-linux-packages.mjs";

const require = createRequire(import.meta.url);
const electronBuilderRequire = createRequire(require.resolve("electron-builder"));
const builderRequire = createRequire(electronBuilderRequire.resolve("app-builder-lib"));
const { tar } = builderRequire("./targets/archive");
const tarPackage = builderRequire("tar");

test.each(["x64", "arm64"])("validates the %s portable layout produced by the pinned archive builder", async arch => {
  const root = mkdtempSync(join(tmpdir(), "pwrgit-portable-check-"));
  try {
    const app = join(root, "linux-unpacked");
    const resources = join(app, "resources");
    const binary = Buffer.alloc(24);
    binary.write("\x7fELF"); binary[4] = 2; binary[5] = 1;
    binary.writeUInt16LE(arch === "x64" ? 62 : 183, 18);
    for (const file of [
      "pwrgit", "resources/git/bin/git", "resources/git/libexec/git-core/git-lfs",
      "resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
    ]) {
      mkdirSync(dirname(join(app, file)), { recursive: true });
      writeFileSync(join(app, file), binary);
    }
    for (const file of ["LICENSE", "THIRD_PARTY_LICENSES", "CHANGELOG.md", "git/COPYING", "git/LICENSE.git-lfs"]) {
      writeFileSync(join(resources, file), "fixture notice");
    }
    // Exercise the actual builder's tar creation. Substitute only its external
    // 7zip compression process to keep this regression offline on every OS.
    vi.spyOn(builderRequire("./toolsets/7zip"), "getPath7za").mockResolvedValue("fixture-compressor");
    vi.spyOn(builderRequire("builder-util"), "exec").mockImplementation(async (_executable, args) => {
      writeFileSync(args.at(-2), gzipSync(readFileSync(args.at(-1))));
    });
    const asset = join(root, linuxArtifactName("1.2.3", arch, "tar.gz"));
    await tar({ compression: "normal", format: "tar.gz", outFile: asset, dirToArchive: app, isMacApp: false,
      tempDirManager: { getTempFile: async () => join(root, "intermediate.tar") } });
    const extracted = join(root, "extracted");
    mkdirSync(extracted);
    await tarPackage.extract({ file: asset, cwd: extracted });
    verifyExtractedLinuxPayload({ root: extracted, format: "tar.gz", asset, arch });
    expect(() => verifyExtractedLinuxPayload({ root: extracted, format: "tar.gz", asset, arch: arch === "x64" ? "arm64" : "x64" })).toThrow("ELF");
  } finally {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  }
});
