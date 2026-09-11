import { createHash } from "node:crypto";
import { copyFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MAC_ARCHITECTURES = ["universal", "arm64"];

// Keep one channel file for existing clients. JSON is valid YAML and avoids
// depending on electron-builder's private YAML parser from the release stage.
// Compute descriptors from final ZIP bytes, after signing and notarization.
export function writeMacReleaseArtifacts(dist, version) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) || version.includes("arm64")) {
    throw new Error(`Invalid macOS release version: ${version}`);
  }
  const files = MAC_ARCHITECTURES.map((arch) => {
    const url = `PwrGit-${version}-${arch}-mac.zip`;
    for (const name of [url, `${url}.blockmap`, `PwrGit-${version}-${arch}.dmg`]) {
      const stat = statSync(join(dist, name));
      if (!stat.isFile() || stat.size === 0) throw new Error(`Missing or empty macOS artifact: ${name}`);
    }
    const bytes = readFileSync(join(dist, url));
    return { url, sha512: createHash("sha512").update(bytes).digest("base64"), size: bytes.length };
  });
  const manifest = {
    version,
    files,
    path: files[0].url,
    sha512: files[0].sha512,
    releaseDate: new Date().toISOString(),
  };
  // Do not change PwrGit.dmg: existing links must continue to work on Intel.
  copyFileSync(join(dist, `PwrGit-${version}-universal.dmg`), join(dist, "PwrGit.dmg"));
  copyFileSync(join(dist, `PwrGit-${version}-arm64.dmg`), join(dist, "PwrGit-arm64.dmg"));
  writeFileSync(join(dist, "latest-mac.yml"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
