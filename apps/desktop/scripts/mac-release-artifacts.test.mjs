import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { MAC_ARCHITECTURES, writeMacReleaseArtifacts } from "./mac-release-artifacts.mjs";

const require = createRequire(import.meta.url);
const { MacUpdater } = require("electron-updater/out/MacUpdater");
const { resolveFiles, findFile } = require("electron-updater/out/providers/Provider");
const directories = [];
const version = "1.2.3-beta.4";

function fixture() {
  const dist = mkdtempSync(join(tmpdir(), "pwrgit-mac-artifacts-"));
  directories.push(dist);
  for (const arch of MAC_ARCHITECTURES) {
    for (const suffix of [".dmg", "-mac.zip", "-mac.zip.blockmap"]) {
      writeFileSync(join(dist, `PwrGit-${version}-${arch}${suffix}`), `${arch}${suffix}`);
    }
  }
  return dist;
}

afterEach(() => directories.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe("macOS release assets", () => {
  test("uses final ZIP hashes and retains universal legacy and DMG aliases", () => {
    const dist = fixture();
    const info = writeMacReleaseArtifacts(dist, version);
    expect(JSON.parse(readFileSync(join(dist, "latest-mac.yml"), "utf8"))).toEqual(info);
    expect(info.path).toBe(`PwrGit-${version}-universal-mac.zip`);
    expect(info.sha512).toBe(info.files[0].sha512);
    for (const file of info.files) {
      const bytes = readFileSync(join(dist, file.url));
      expect(file.sha512).toBe(createHash("sha512").update(bytes).digest("base64"));
      expect(file.size).toBe(bytes.length);
    }
    expect(readFileSync(join(dist, "PwrGit.dmg"), "utf8")).toBe("universal.dmg");
    expect(readFileSync(join(dist, "PwrGit-arm64.dmg"), "utf8")).toBe("arm64.dmg");
  });

  test.each(["universal-mac.zip", "arm64-mac.zip", "arm64-mac.zip.blockmap", "universal.dmg"])(
    "rejects a partial release missing %s before replacing the manifest", (suffix) => {
      const dist = fixture();
      writeFileSync(join(dist, "latest-mac.yml"), "previous");
      rmSync(join(dist, `PwrGit-${version}-${suffix}`));
      expect(() => writeMacReleaseArtifacts(dist, version)).toThrow();
      expect(readFileSync(join(dist, "latest-mac.yml"), "utf8")).toBe("previous");
    },
  );

  test("rejects empty output and a tag that would confuse updater architecture detection", () => {
    const dist = fixture();
    writeFileSync(join(dist, `PwrGit-${version}-arm64-mac.zip`), "");
    expect(() => writeMacReleaseArtifacts(dist, version)).toThrow("empty");
    expect(() => writeMacReleaseArtifacts(dist, "1.2.3-arm64")).toThrow("Invalid");
  });

  test.each([false, true])("pinned updater selects the correct ZIP with isArm64Mac=%s", (isArm64Mac) => {
    const info = writeMacReleaseArtifacts(fixture(), version);
    const resolved = resolveFiles(info, new URL("https://example.test/releases/download/v1.2.3/"));
    // MacUpdater passes true for native arm64 AND an x64 process under Rosetta.
    const file = findFile(MacUpdater.filterFilesForArch(resolved, isArm64Mac), "zip", ["pkg", "dmg"]);
    expect(file.info.url).toBe(`PwrGit-${version}-${isArm64Mac ? "arm64" : "universal"}-mac.zip`);
    const fallback = MacUpdater.filterFilesForArch(resolved.slice(0, 1), isArm64Mac);
    expect(findFile(fallback, "zip").info.url).toBe(info.path);
  });
});
