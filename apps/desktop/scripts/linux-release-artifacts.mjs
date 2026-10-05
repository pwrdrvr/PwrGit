import { createHash } from "node:crypto";
import { copyFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const LINUX_ARCHITECTURES = ["x64", "arm64"];
export const LINUX_FORMATS = ["deb", "rpm", "pacman", "tar.gz"];

export function linuxArtifactName(version, arch, format) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) || !LINUX_ARCHITECTURES.includes(arch) || !LINUX_FORMATS.includes(format)) {
    throw new Error(`Unsupported Linux release: ${version}/${arch}/${format}`);
  }
  const packageArch = arch === "x64" ? (format === "deb" ? "amd64" : format === "rpm" ? "x86_64" : arch)
    : (format === "rpm" || format === "pacman" ? "aarch64" : arch);
  return `PwrGit-${version}-linux-${packageArch}.${format}`;
}

export function linuxAliasName(arch, format) {
  return `PwrGit-linux-${arch}.${format}`;
}

export function linuxManifestName(arch) {
  return arch === "x64" ? "latest-linux.yml" : `latest-linux-${arch}.yml`;
}

export function linuxReleaseAssetNames(version, arch) {
  return [
    ...LINUX_FORMATS.flatMap(format => [linuxArtifactName(version, arch, format), linuxAliasName(arch, format)]),
    linuxManifestName(arch), `PwrGit-linux-${arch}-SHA256SUMS`
  ];
}

// Hash final bytes. Each architecture gets its own manifest; the pinned native
// backend chooses its extension, and never sees a package for another CPU.
export function writeLinuxReleaseArtifacts(dist, version, arch) {
  const checksums = [];
  const files = LINUX_FORMATS.map(format => {
    const url = linuxArtifactName(version, arch, format);
    const path = join(dist, url);
    const stat = statSync(path);
    if (!stat.isFile() || stat.size === 0) throw new Error(`Missing or empty Linux artifact: ${url}`);
    const bytes = readFileSync(path);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const alias = linuxAliasName(arch, format);
    copyFileSync(path, join(dist, alias));
    checksums.push(`${sha256}  ${url}`, `${sha256}  ${alias}`);
    return { url, size: bytes.length, sha512: createHash("sha512").update(bytes).digest("base64") };
  });
  // Portable archives cannot self-update; keep them out of the updater feed.
  const nativeFiles = files.slice(0, 3);
  const manifest = { version, files: nativeFiles, path: nativeFiles[0].url, sha512: nativeFiles[0].sha512, releaseDate: new Date().toISOString() };
  writeFileSync(join(dist, linuxManifestName(arch)), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(dist, `PwrGit-linux-${arch}-SHA256SUMS`), `${checksums.join("\n")}\n`);
  return manifest;
}
