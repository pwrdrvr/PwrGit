#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { isCliEntrypoint } from "../../../scripts/lib/cli-entrypoint.mjs";
import { LINUX_FORMATS, linuxArtifactName } from "./linux-release-artifacts.mjs";
import { verifyLinuxElf } from "./package-linux.mjs";

export function verifyLinuxDesktopIcons(root, desktop) {
  assert.match(desktop, /^Icon=pwrgit$/m);
  for (const size of [16, 24, 32, 48, 64, 128, 256, 512]) {
    const icon = readFileSync(join(root, "usr", "share", "icons", "hicolor", `${size}x${size}`, "apps", "pwrgit.png"));
    assert.equal(icon.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "Launcher icon must be a PNG");
    assert.equal(icon.readUInt32BE(16), size, "Launcher icon width must match its theme directory");
    assert.equal(icon.readUInt32BE(20), size, "Launcher icon height must match its theme directory");
  }
}

// The pinned ArchiveTarget wraps portable tar files in the artifact basename.
export function verifyExtractedLinuxPayload({ root, format, asset, arch }) {
  const appRoot = format === "tar.gz" ? join(root, basename(asset, ".tar.gz")) : join(root, "opt", "PwrGit");
  const resources = join(appRoot, "resources");
  const marker = join(resources, "package-type");
  if (format === "tar.gz") assert.throws(() => statSync(marker), /ENOENT/);
  else {
    assert.equal(readFileSync(marker, "utf8").trim(), format);
    assert.match(readFileSync(join(resources, "app-update.yml"), "utf8"), /repo: PwrGit/);
    const desktop = readFileSync(join(root, "usr", "share", "applications", "pwrgit.desktop"), "utf8");
    assert.match(desktop, /StartupWMClass=PwrGit/);
    assert.match(desktop, /Exec=.*\/opt\/PwrGit\/pwrgit/);
    verifyLinuxDesktopIcons(root, desktop);
  }
  verifyLinuxElf(join(appRoot, "pwrgit"), arch);
  verifyLinuxElf(join(resources, "git", "bin", "git"), arch);
  verifyLinuxElf(join(resources, "git", "libexec", "git-core", "git-lfs"), arch);
  verifyLinuxElf(join(resources, "app.asar.unpacked", "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node"), arch);
  for (const file of ["LICENSE", "THIRD_PARTY_LICENSES", "CHANGELOG.md", "git/COPYING", "git/LICENSE.git-lfs"]) {
    assert.ok(statSync(join(resources, file)).size > 0, `Missing notice: ${file}`);
  }
}

function runCli() {
  if (process.platform !== "linux") throw new Error("Linux package validation requires Linux tools");
  const [dist, version] = process.argv.slice(2);
  if (!dist || !version) throw new Error("Usage: verify-linux-packages.mjs <dist> <version>");
  const arch = process.arch;
  for (const format of LINUX_FORMATS) {
    const asset = join(dist, linuxArtifactName(version, arch, format));
    const root = mkdtempSync(join(tmpdir(), "pwrgit-package-check-"));
    try {
      if (format === "deb") {
        const fields = execFileSync("dpkg-deb", ["-f", asset, "Package", "Architecture", "Version"], { encoding: "utf8" });
        assert.match(fields, /Package: pwrgit\n/);
        assert.match(fields, new RegExp(`Architecture: ${arch === "x64" ? "amd64" : "arm64"}\\n`));
        execFileSync("dpkg-deb", ["-x", asset, root]);
      } else if (format === "rpm") {
        const fields = execFileSync("rpm", ["-qp", "--queryformat", "%{NAME} %{ARCH}", asset], { encoding: "utf8" });
        assert.equal(fields, `pwrgit ${arch === "x64" ? "x86_64" : "aarch64"}`);
        execFileSync("bsdtar", ["-xf", asset, "-C", root]);
      } else {
        execFileSync("tar", ["-xf", asset, "-C", root]);
        if (format === "pacman") {
          const info = readFileSync(join(root, ".PKGINFO"), "utf8");
          assert.match(info, /^pkgname = pwrgit$/m);
          assert.match(info, new RegExp(`^arch = ${arch === "x64" ? "x86_64" : "aarch64"}$`, "m"));
        }
      }
      verifyExtractedLinuxPayload({ root, format, asset, arch });
      console.log(`Verified ${format}/${arch} package metadata, payload, notices and updater identity`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
}

if (isCliEntrypoint(import.meta.url)) runCli();
