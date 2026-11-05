// Test-only: a synthetic runtime payload in the published shape (sealed
// `runtime-files.json`, `pwrgit-build.json`, internal symlinks), and a release
// that serves it, for the managed-runtime tests.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { PlatformKey } from "./catalog";
import type { RuntimePin } from "./verify-runtime";

export const sha256 = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex");

export const FIXTURE_REVISION = "97dd200ae74c18d4afe94deb03bc79f29b9d774d";

export const FIXTURE_CA_BUNDLE = "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n";

/** A gzipped ustar archive written byte by byte, so a test can name members
 *  (`../x`, `/x`) that no well-behaved `tar` would write. */
export function rawTarGz(entries: Array<{ name: string; body: string }>): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const body = Buffer.from(entry.body);
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, "utf8");
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("00000000000\0", 136);
    header.write("        ", 148);
    header.write("0", 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

/** Write a payload and seal it. Returns its pin. */
export function writePayload(
  root: string,
  options: { version: string; key: PlatformKey; revision?: string }
): RuntimePin {
  const revision = options.revision ?? FIXTURE_REVISION;
  mkdirSync(join(root, "bin"), { recursive: true });
  mkdirSync(join(root, "libexec", "git-core"), { recursive: true });
  mkdirSync(join(root, "share", "git-core", "templates", "hooks"), { recursive: true });
  mkdirSync(join(root, "etc"), { recursive: true });
  writeFileSync(join(root, "bin", "git"), `#!/bin/sh\necho git ${options.version}\n`);
  chmodSync(join(root, "bin", "git"), 0o755);
  writeFileSync(join(root, "bin", "git-lfs"), "#!/bin/sh\necho git-lfs/3.7.1 fixture\n");
  chmodSync(join(root, "bin", "git-lfs"), 0o755);
  symlinkSync("../../bin/git", join(root, "libexec", "git-core", "git"));
  writeFileSync(join(root, "libexec", "git-core", "git-remote-https"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(root, "libexec", "git-core", "git-remote-https"), 0o755);
  writeFileSync(join(root, "share", "git-core", "templates", "hooks", "README"), "hooks\n");
  writeFileSync(join(root, "etc", "gitconfig"), "[include]\n\tpath = /etc/gitconfig\n");
  if (options.key !== "darwin-universal") {
    mkdirSync(join(root, "ssl"), { recursive: true });
    writeFileSync(join(root, "ssl", "cacert.pem"), FIXTURE_CA_BUNDLE);
  }
  writeFileSync(
    join(root, "pwrgit-build.json"),
    JSON.stringify({
      schema: 1,
      version: options.version,
      source_revision: revision,
      primary_sha1: "SHA1_DC",
      architecture: options.key === "darwin-universal" ? "universal" : options.key.slice("linux-".length),
      lfs_version: "3.7.1",
      notarized: options.key === "darwin-universal",
      signing: options.key === "darwin-universal" ? "Developer ID Application: PwrDrvr LLC (T44CNHC4UH)" : "unsigned"
    })
  );
  return seal(root, { version: options.version, key: options.key, revision });
}

/** (Re)write `runtime-files.json` from what is on disk; the pin follows. */
export function seal(root: string, options: { version: string; key: PlatformKey; revision?: string }): RuntimePin {
  const inventory: Record<string, { sha256?: string; mode?: number; link?: string }> = {};
  const visit = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const rel = relative(root, path).split(sep).join("/");
      if (rel === "runtime-files.json") continue;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) inventory[rel] = { link: readlinkSync(path) };
      else if (stat.isDirectory()) visit(path);
      else inventory[rel] = { sha256: sha256(readFileSync(path)), mode: stat.mode & 0o7777 };
    }
  };
  visit(root);
  writeFileSync(join(root, "runtime-files.json"), JSON.stringify(inventory));
  const inventorySha = sha256(readFileSync(join(root, "runtime-files.json")));
  return {
    version: options.version,
    sourceRevision: options.revision ?? FIXTURE_REVISION,
    key: options.key,
    asset: { sha256: "", inventory_sha256: inventorySha, url: "" }
  };
}

/** `tar -czf` of a payload's contents, as the release archives are. */
export function archive(root: string, target: string): Buffer {
  execFileSync("tar", ["-czf", target, "-C", root, "."]);
  return readFileSync(target);
}

export type FixtureRelease = {
  tag: string;
  version: string;
  archiveName: string;
  archive: Buffer;
  catalog: Buffer;
  sums: string;
  release: Record<string, unknown>;
};

/** A complete release for one platform: catalog, SHA256SUMS, archive, and
 *  the GitHub API record that lists them. */
export function fixtureRelease(input: {
  version: string;
  key: PlatformKey;
  archive: Buffer;
  inventorySha256: string;
  consumerSha256: string;
  revision?: string;
  prerelease?: boolean;
  draft?: boolean;
  caBundleSha256?: string;
}): FixtureRelease {
  const revision = input.revision ?? FIXTURE_REVISION;
  const tag = `v${input.version}`;
  const archiveName = `pwrgit-${input.version}-${revision.slice(0, 7)}-${input.key}.tar.gz`;
  const base = `https://github.com/huntharo/git/releases/download/${tag}/`;
  const archiveSha = sha256(input.archive);
  const catalog = Buffer.from(
    JSON.stringify({
      schema: 1,
      version: input.version,
      source_revision: revision,
      consumer_sha256: input.consumerSha256,
      assets: {
        [input.key]: {
          sha256: archiveSha,
          inventory_sha256: input.inventorySha256,
          url: base + archiveName,
          ...(input.key === "darwin-universal"
            ? { team_id: "T44CNHC4UH", notarized: true, signing: "Developer ID Application: PwrDrvr LLC (T44CNHC4UH)" }
            : {
                signing: "unsigned",
                notarized: false,
                ca_bundle: { path: "ssl/cacert.pem", sha256: input.caBundleSha256 ?? sha256(FIXTURE_CA_BUNDLE) }
              })
        }
      }
    })
  );
  const sums = `${archiveSha}  ${archiveName}\n${sha256(catalog)}  runtime-manifest.json\n`;
  const asset = (name: string, bytes: Buffer | string) => ({
    name,
    browser_download_url: base + name,
    digest: `sha256:${sha256(bytes)}`,
    size: Buffer.byteLength(bytes)
  });
  return {
    tag,
    version: input.version,
    archiveName,
    archive: input.archive,
    catalog,
    sums,
    release: {
      tag_name: tag,
      draft: input.draft ?? false,
      // Promoted unless a test says otherwise: the Latest track (the default)
      // offers only promoted releases. huntharo/git publishes as prerelease.
      prerelease: input.prerelease ?? false,
      published_at: "2026-11-07T12:00:00Z",
      assets: [asset(archiveName, input.archive), asset("runtime-manifest.json", catalog), asset("SHA256SUMS", sums)]
    }
  };
}
