// Which huntharo/git releases a managed install may use, and whether a
// release's catalog may be trusted. Pure: no network, no disk.
//
// Every custom Git release is a GitHub *prerelease*, so `/releases/latest`
// (stable only) never returns one; the list endpoint is read and ordered here
// by version precedence, not publish order. The catalog obeys the same rules
// `stage-runtime.mjs` (`readRuntimeManifest`) applies to the bundled pin, and
// the three places a digest appears (SHA256SUMS, GitHub's asset digest, the
// catalog) must agree.
import { createHash } from "node:crypto";
import {
  compareManagedGitVersions,
  parseManagedGitVersion,
  type ManagedGitVersion
} from "@pwrgit/shared";
import type { RuntimePin } from "./verify-runtime";
import { PWRDRVR_SIGNING, PWRDRVR_TEAM_ID } from "./verify-runtime";

export const MANAGED_GIT_REPOSITORY = "huntharo/git";
export const MANAGED_GIT_RELEASES_URL = `https://api.github.com/repos/${MANAGED_GIT_REPOSITORY}/releases?per_page=30`;
export const CATALOG_ASSET = "runtime-manifest.json";
export const CHECKSUMS_ASSET = "SHA256SUMS";
/** Largest archive accepted; published archives are 26–39 MB. */
export const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
/** Catalog and SHA256SUMS are a few KB. */
export const MAX_METADATA_BYTES = 1024 * 1024;

export type PlatformKey = RuntimePin["key"];

/** The build key for this machine, or null where none is published. Windows
 *  keeps Dugite's Git; PwrGit offers no Windows build. */
export function managedPlatformKey(platform: NodeJS.Platform, arch: string): PlatformKey | null {
  if (platform === "darwin" && (arch === "arm64" || arch === "x64")) return "darwin-universal";
  if (platform === "linux" && arch === "x64") return "linux-x64";
  if (platform === "linux" && arch === "arm64") return "linux-arm64";
  return null;
}

/** The fields of a GitHub release this code reads. Everything is `unknown`
 *  until checked: it is a network response. */
export type GitHubRelease = {
  tag_name?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  published_at?: unknown;
  assets?: unknown;
};

export type ReleaseAsset = { name: string; url: string; digest: string | null; size: number | null };

export type ReleaseCandidate = {
  tag: string;
  version: string;
  parsed: ManagedGitVersion;
  publishedAt: string | null;
  catalog: ReleaseAsset;
  checksums: ReleaseAsset;
  archive: ReleaseAsset;
};

const HEX64 = /^[0-9a-f]{64}$/;

function downloadPrefix(tag: string): string {
  return `https://github.com/${MANAGED_GIT_REPOSITORY}/releases/download/${tag}/`;
}

function readAsset(value: unknown, tag: string): ReleaseAsset | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const name = record["name"];
  const url = record["browser_download_url"];
  if (typeof name !== "string" || typeof url !== "string") return null;
  // The asset must live under this release's own download path, by name: a
  // release cannot point an asset at another tag, repository or host.
  if (name.includes("/") || name.includes("\\") || url !== downloadPrefix(tag) + name) return null;
  const digest = record["digest"];
  const size = record["size"];
  return {
    name,
    url,
    digest:
      typeof digest === "string" && /^sha256:[0-9a-fA-F]{64}$/.test(digest)
        ? digest.slice("sha256:".length).toLowerCase()
        : null,
    size: typeof size === "number" && Number.isSafeInteger(size) && size >= 0 ? size : null
  };
}

/**
 * Releases a managed install could use on `key`, newest first. A release
 * counts only when it is not a draft, its tag is `v<version>` in the runtime's
 * version shape, the version is newer than the bundled build (the bundle
 * already covers anything older), and it carries the catalog, SHA256SUMS and
 * exactly one archive for this platform. Whether GitHub calls it a
 * prerelease does not matter: every custom release is one.
 */
export function eligibleReleases(
  releases: unknown,
  key: PlatformKey,
  bundledVersion: string
): ReleaseCandidate[] {
  if (!Array.isArray(releases)) return [];
  const bundled = parseManagedGitVersion(bundledVersion);
  const found = new Map<string, ReleaseCandidate>();
  const conflicted = new Set<string>();
  for (const release of releases as GitHubRelease[]) {
    if (typeof release !== "object" || release === null || release.draft !== false) continue;
    const tag = release.tag_name;
    if (typeof tag !== "string" || !tag.startsWith("v")) continue;
    const version = tag.slice(1);
    const parsed = parseManagedGitVersion(version);
    if (parsed === null) continue;
    if (bundled !== null && compareManagedGitVersions(parsed, bundled) <= 0) continue;
    if (!Array.isArray(release.assets)) continue;
    const assets = release.assets.map((asset) => readAsset(asset, tag)).filter((asset) => asset !== null);
    const catalog = assets.find((asset) => asset.name === CATALOG_ASSET);
    const checksums = assets.find((asset) => asset.name === CHECKSUMS_ASSET);
    const archivePattern = new RegExp(`^pwrgit-${version.replace(/\./g, "\\.")}-[0-9a-f]{7}-${key}\\.tar\\.gz$`);
    const archives = assets.filter((asset) => archivePattern.test(asset.name));
    if (catalog === undefined || checksums === undefined || archives.length !== 1) continue;
    // Two releases claiming one version: neither is trusted.
    if (conflicted.has(version)) continue;
    if (found.has(version)) {
      found.delete(version);
      conflicted.add(version);
      continue;
    }
    found.set(version, {
      tag,
      version,
      parsed,
      publishedAt: typeof release.published_at === "string" ? release.published_at : null,
      catalog,
      checksums,
      archive: archives[0] as ReleaseAsset
    });
  }
  return [...found.values()].sort((a, b) => compareManagedGitVersions(b.parsed, a.parsed));
}

/** `SHA256SUMS` lines: `<hex>  <name>` (or `*<name>`). A name listed twice
 *  with different sums makes the file unusable. */
export function parseChecksums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "") continue;
    const match = /^([0-9a-fA-F]{64})\s+\*?(\S.*)$/.exec(line);
    if (match === null) continue;
    const sum = (match[1] as string).toLowerCase();
    const name = match[2] as string;
    const prior = sums.get(name);
    if (prior !== undefined && prior !== sum) throw new CatalogError(`SHA256SUMS lists ${name} twice with different sums`);
    sums.set(name, sum);
  }
  return sums;
}

export class CatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogError";
  }
}

/** The release is fine but this app cannot verify it: its catalog was made
 *  for a different shared stager than the one this app shipped. */
export class NeedsAppUpdateError extends Error {
  constructor(readonly version: string) {
    super(`${version} needs a newer PwrGit to verify it.`);
    this.name = "NeedsAppUpdateError";
  }
}

/** One digest from up to three sources. Missing GitHub digests are
 *  tolerated; any present value that disagrees is not. */
function agree(name: string, expected: string, ...others: Array<string | null | undefined>): void {
  for (const other of others) {
    if (other !== null && other !== undefined && other !== expected) {
      throw new CatalogError(`${name}: the release’s checksums disagree (expected ${expected.slice(0, 12)}…, found ${other.slice(0, 12)}…)`);
    }
  }
}

export type AcceptedCatalog = {
  pin: RuntimePin;
  catalogSha256: string;
  archiveSha256: string;
  archiveName: string;
  archiveUrl: string;
  archiveSize: number | null;
};

/**
 * Accept a downloaded catalog for `key`, or throw. `consumerSha256` is the
 * stager pin this app shipped (its own `custom-git-runtime.json`): a catalog
 * built for another stager is `NeedsAppUpdateError`, never installed.
 */
export function acceptCatalog(input: {
  candidate: ReleaseCandidate;
  catalogBytes: Buffer;
  checksumsText: string;
  key: PlatformKey;
  consumerSha256: string;
}): AcceptedCatalog {
  const { candidate, key } = input;
  const catalogSha256 = createHash("sha256").update(input.catalogBytes).digest("hex");
  const sums = parseChecksums(input.checksumsText);
  const listed = sums.get(CATALOG_ASSET);
  if (listed === undefined) throw new CatalogError("SHA256SUMS does not list runtime-manifest.json");
  agree(CATALOG_ASSET, catalogSha256, listed, candidate.catalog.digest);
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(input.catalogBytes.toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new CatalogError("runtime-manifest.json is not JSON");
  }
  const sourceRevision = manifest["source_revision"];
  const assets = manifest["assets"] as Record<string, Record<string, unknown>> | undefined;
  const asset = typeof assets === "object" && assets !== null ? assets[key] : undefined;
  if (
    manifest["schema"] !== 1 ||
    manifest["version"] !== candidate.version ||
    typeof sourceRevision !== "string" ||
    !/^[0-9a-f]{40}$/.test(sourceRevision) ||
    typeof asset !== "object" ||
    asset === null ||
    typeof asset["sha256"] !== "string" ||
    !HEX64.test(asset["sha256"]) ||
    typeof asset["inventory_sha256"] !== "string" ||
    !HEX64.test(asset["inventory_sha256"]) ||
    typeof asset["url"] !== "string"
  ) {
    throw new CatalogError(`Unsupported or incomplete custom Git manifest for ${key}`);
  }
  const url = asset["url"];
  if (/[?#]/.test(url) || url !== candidate.archive.url || !candidate.archive.name.includes(`-${sourceRevision.slice(0, 7)}-`)) {
    throw new CatalogError("Custom Git archive must use its immutable versioned release URL");
  }
  if (key === "darwin-universal" && (asset["team_id"] !== PWRDRVR_TEAM_ID || asset["notarized"] !== true || asset["signing"] !== PWRDRVR_SIGNING)) {
    throw new CatalogError("Custom macOS Git requires the approved notarized PwrDrvr payload");
  }
  // A Linux build's HTTPS trusts the CA bundle it carries; the catalog names it.
  const caBundle = asset["ca_bundle"] as Record<string, unknown> | undefined;
  if (
    key !== "darwin-universal" &&
    (typeof caBundle !== "object" ||
      caBundle === null ||
      caBundle["path"] !== "ssl/cacert.pem" ||
      typeof caBundle["sha256"] !== "string" ||
      !HEX64.test(caBundle["sha256"]))
  ) {
    throw new CatalogError("Custom Linux Git requires its CA bundle at ssl/cacert.pem");
  }
  const archiveSha256 = asset["sha256"];
  const archiveListed = sums.get(candidate.archive.name);
  if (archiveListed === undefined) throw new CatalogError(`SHA256SUMS does not list ${candidate.archive.name}`);
  agree(candidate.archive.name, archiveSha256, archiveListed, candidate.archive.digest);
  if (manifest["consumer_sha256"] !== input.consumerSha256) throw new NeedsAppUpdateError(candidate.version);
  return {
    pin: {
      version: candidate.version,
      sourceRevision,
      key,
      asset: {
        sha256: archiveSha256,
        inventory_sha256: asset["inventory_sha256"],
        url,
        ...(typeof asset["team_id"] === "string" ? { team_id: asset["team_id"] } : {}),
        ...(typeof asset["notarized"] === "boolean" ? { notarized: asset["notarized"] } : {}),
        ...(typeof asset["signing"] === "string" ? { signing: asset["signing"] } : {}),
        ...(key !== "darwin-universal" && caBundle !== undefined ? { ca_bundle_sha256: caBundle["sha256"] as string } : {})
      }
    },
    catalogSha256,
    archiveSha256,
    archiveName: candidate.archive.name,
    archiveUrl: url,
    archiveSize: candidate.archive.size
  };
}

/** `<version>-<rev7>`: a build's id and directory name. */
export function buildId(version: string, sourceRevision: string): string {
  return `${version}-${sourceRevision.slice(0, 7)}`;
}

export function isBuildId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(.+)-([0-9a-f]{7})$/.exec(value);
  return match !== null && parseManagedGitVersion(match[1]) !== null;
}
