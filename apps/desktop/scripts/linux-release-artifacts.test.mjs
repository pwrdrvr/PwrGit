import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { LINUX_FORMATS, linuxArtifactName, linuxAliasName, linuxManifestName, writeLinuxReleaseArtifacts } from "./linux-release-artifacts.mjs";
import { verifyLinuxElf } from "./package-linux.mjs";

const require = createRequire(import.meta.url);
const { getArtifactArchName, Arch } = require("builder-util");
const { resolveFiles, findFile, parseUpdateInfo } = require("electron-updater/out/providers/Provider");

test.each(["x64", "arm64"])("%s metadata hashes final bytes and the pinned updater resolves the native formats", arch => {
  const root = mkdtempSync(join(tmpdir(), "pwrgit-linux-artifacts-"));
  try {
    for (const format of LINUX_FORMATS) {
      expect(linuxArtifactName("1.2.3", arch, format)).toBe(`PwrGit-1.2.3-linux-${getArtifactArchName(Arch[arch], format)}.${format}`);
      writeFileSync(join(root, linuxArtifactName("1.2.3", arch, format)), `package ${arch}/${format}`);
    }
    writeLinuxReleaseArtifacts(root, "1.2.3", arch);
    const manifest = parseUpdateInfo(readFileSync(join(root, linuxManifestName(arch)), "utf8"), "fixture", new URL("https://example.test/"));
    const files = resolveFiles(manifest, new URL("https://example.test/"));
    expect(files).toHaveLength(3);
    for (const format of LINUX_FORMATS) {
      const original = readFileSync(join(root, linuxArtifactName("1.2.3", arch, format)));
      expect(readFileSync(join(root, linuxAliasName(arch, format)))).toEqual(original);
      const sha256 = createHash("sha256").update(original).digest("hex");
      expect(readFileSync(join(root, `PwrGit-linux-${arch}-SHA256SUMS`), "utf8")).toContain(`${sha256}  ${linuxAliasName(arch, format)}`);
      if (format !== "tar.gz") {
        const selected = findFile(files, format);
        expect(selected.url.pathname).toBe(`/${linuxArtifactName("1.2.3", arch, format)}`);
        expect(selected.info.sha512).toBe(createHash("sha512").update(original).digest("base64"));
      }
    }
    writeFileSync(join(root, linuxArtifactName("1.2.3", arch, "deb")), "");
    expect(() => writeLinuxReleaseArtifacts(root, "1.2.3", arch)).toThrow("Missing or empty");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("ELF validation rejects foreign native slices and non-ELF payloads", () => {
  const root = mkdtempSync(join(tmpdir(), "pwrgit-elf-"));
  const path = join(root, "binary");
  try {
    const bytes = Buffer.alloc(24);
    bytes.write("\x7fELF"); bytes[4] = 2; bytes[5] = 1; bytes.writeUInt16LE(62, 18);
    writeFileSync(path, bytes);
    verifyLinuxElf(path, "x64");
    expect(() => verifyLinuxElf(path, "arm64")).toThrow("Expected a arm64 ELF");
    writeFileSync(path, "wrong binary");
    expect(() => verifyLinuxElf(path, "x64")).toThrow("Expected a x64 ELF");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
