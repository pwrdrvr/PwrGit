import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { compareManagedGitVersions, parseManagedGitVersion } from "@pwrgit/shared";
import {
  CatalogError,
  NeedsAppUpdateError,
  acceptCatalog,
  eligibleReleases,
  parseChecksums,
  type PlatformKey,
  type ReleaseCandidate
} from "./catalog";

const fixtures = join(__dirname, "fixtures");
const RELEASE = JSON.parse(readFileSync(join(fixtures, "v2.56.0-dev-pwrgit.4.release.json"), "utf8")) as Record<string, unknown>;
const CATALOG = readFileSync(join(fixtures, "v2.56.0-dev-pwrgit.4.runtime-manifest.json"));
const SUMS = readFileSync(join(fixtures, "v2.56.0-dev-pwrgit.4.SHA256SUMS"), "utf8");
const PIN = JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "..", "custom-git-runtime.json"), "utf8")) as { consumer_sha256: string };
const KEYS: PlatformKey[] = ["darwin-universal", "linux-x64", "linux-arm64"];

function candidate(key: PlatformKey, release: unknown = RELEASE): ReleaseCandidate {
  const [found] = eligibleReleases([release], key, "2.56.0-dev-pwrgit.3");
  if (found === undefined) throw new Error("fixture release not eligible");
  return found;
}

describe("the published .4 release", () => {
  test("is a GitHub prerelease, and still the release a .3 install moves to", () => {
    expect(RELEASE["prerelease"]).toBe(true);
    for (const key of KEYS) expect(candidate(key).version).toBe("2.56.0-dev-pwrgit.4");
  });

  test("is not offered over a bundle that already is .4", () => {
    for (const key of KEYS) expect(eligibleReleases([RELEASE], key, "2.56.0-dev-pwrgit.4")).toEqual([]);
  });

  test.each(KEYS)("its catalog is accepted for %s with this app's stager pin", (key) => {
    const accepted = acceptCatalog({ candidate: candidate(key), catalogBytes: CATALOG, checksumsText: SUMS, key, consumerSha256: PIN.consumer_sha256 });
    expect(accepted.catalogSha256).toBe("1f65def5b71046b3201ecdb2e7b5d8c1816c9f839d8acdc8261acd7f93203b15");
    expect(accepted.pin.sourceRevision).toBe("97dd200ae74c18d4afe94deb03bc79f29b9d774d");
    expect(accepted.archiveName).toBe(`pwrgit-2.56.0-dev-pwrgit.4-97dd200-${key}.tar.gz`);
  });

  test("a catalog for another stager needs an app update, never an install", () => {
    expect(() =>
      acceptCatalog({ candidate: candidate("linux-x64"), catalogBytes: CATALOG, checksumsText: SUMS, key: "linux-x64", consumerSha256: "0".repeat(64) })
    ).toThrow(NeedsAppUpdateError);
  });

  test("one changed catalog byte is refused by SHA256SUMS", () => {
    const changed = Buffer.from(CATALOG);
    changed[10] = (changed[10] ?? 0) ^ 1;
    expect(() =>
      acceptCatalog({ candidate: candidate("linux-x64"), catalogBytes: changed, checksumsText: SUMS, key: "linux-x64", consumerSha256: PIN.consumer_sha256 })
    ).toThrow(CatalogError);
  });

  test("a GitHub digest that disagrees is refused; a missing one is tolerated", () => {
    const withDigest = (digest: string | undefined) => {
      const release = structuredClone(RELEASE) as { assets: Array<Record<string, unknown>> };
      for (const asset of release.assets) {
        if (asset["name"] === "runtime-manifest.json") {
          if (digest === undefined) delete asset["digest"];
          else asset["digest"] = digest;
        }
      }
      return candidate("linux-x64", release);
    };
    const accept = (c: ReleaseCandidate) =>
      acceptCatalog({ candidate: c, catalogBytes: CATALOG, checksumsText: SUMS, key: "linux-x64", consumerSha256: PIN.consumer_sha256 });
    expect(() => accept(withDigest(`sha256:${"a".repeat(64)}`))).toThrow(/disagree/);
    expect(accept(withDigest(undefined)).catalogSha256).toMatch(/^1f65def5/);
  });

  test("SHA256SUMS without the archive's line is refused", () => {
    const sums = SUMS.split("\n").filter((line) => !line.includes("linux-x64.tar.gz")).join("\n");
    expect(() =>
      acceptCatalog({ candidate: candidate("linux-x64"), catalogBytes: CATALOG, checksumsText: sums, key: "linux-x64", consumerSha256: PIN.consumer_sha256 })
    ).toThrow(/does not list/);
  });

  test("assets under another repository or tag never count", () => {
    for (const host of ["https://github.com/desktop/dugite-native/releases/download/v2.56.0-dev-pwrgit.4/", "https://github.com/huntharo/git/releases/download/v2.56.0-dev-pwrgit.3/"]) {
      const release = structuredClone(RELEASE) as { assets: Array<Record<string, unknown>> };
      for (const asset of release.assets) asset["browser_download_url"] = host + String(asset["name"]);
      expect(eligibleReleases([release], "linux-x64", "2.56.0-dev-pwrgit.3")).toEqual([]);
    }
  });

  test("a Linux catalog that doesn't name its CA bundle at ssl/cacert.pem is refused", () => {
    for (const change of [(bundle: Record<string, unknown>) => delete bundle["path"], (bundle: Record<string, unknown>) => (bundle["path"] = "etc/ssl/cert.pem")]) {
      const manifest = JSON.parse(CATALOG.toString("utf8")) as { assets: Record<string, { ca_bundle: Record<string, unknown> }> };
      change(manifest.assets["linux-x64"]!.ca_bundle);
      const bytes = Buffer.from(JSON.stringify(manifest));
      const sums = SUMS.replace(/^[0-9a-f]{64}(?=  runtime-manifest\.json$)/m, createHash("sha256").update(bytes).digest("hex"));
      const release = structuredClone(RELEASE) as { assets: Array<Record<string, unknown>> };
      for (const asset of release.assets) if (asset["name"] === "runtime-manifest.json") delete asset["digest"];
      expect(() =>
        acceptCatalog({ candidate: candidate("linux-x64", release), catalogBytes: bytes, checksumsText: sums, key: "linux-x64", consumerSha256: PIN.consumer_sha256 })
      ).toThrow(/CA bundle at ssl\/cacert\.pem/);
    }
    // The real one passes, and carries the bundle's checksum to the verifier.
    const accepted = acceptCatalog({ candidate: candidate("linux-x64"), catalogBytes: CATALOG, checksumsText: SUMS, key: "linux-x64", consumerSha256: PIN.consumer_sha256 });
    expect(accepted.pin.asset.ca_bundle_sha256).toBe("796f1389bfea13c0ed78f663b765baaff54a508e5483786bd6ece73c5e3e3cbe");
  });

  test("SHA256SUMS that names one file twice with two sums is unusable", () => {
    expect(() => parseChecksums(`${"a".repeat(64)}  x\n${"b".repeat(64)}  x\n`)).toThrow(CatalogError);
  });
});

// ---------- property: release choice ----------

type GenRelease = {
  major: number;
  build: number;
  draft: boolean | "missing";
  prerelease: boolean;
  tag: "v" | "bare" | "junk";
  assets: { catalog: boolean; sums: boolean; archives: number; host: "right" | "other-repo" | "other-tag" };
};

const genRelease: fc.Arbitrary<GenRelease> = fc.record({
  major: fc.integer({ min: 2, max: 3 }),
  build: fc.integer({ min: 0, max: 8 }),
  draft: fc.constantFrom<GenRelease["draft"]>(false, false, false, true, "missing"),
  prerelease: fc.boolean(),
  tag: fc.constantFrom<GenRelease["tag"]>("v", "v", "v", "bare", "junk"),
  assets: fc.record({
    catalog: fc.constantFrom(true, true, true, false),
    sums: fc.constantFrom(true, true, true, false),
    archives: fc.constantFrom(1, 1, 1, 0, 2),
    host: fc.constantFrom<GenRelease["assets"]["host"]>("right", "right", "right", "other-repo", "other-tag")
  })
});

const versionOf = (r: GenRelease) => `${r.major}.56.0-dev-pwrgit.${r.build}`;

function render(r: GenRelease, key: PlatformKey): Record<string, unknown> {
  const version = versionOf(r);
  const tag = r.tag === "v" ? `v${version}` : r.tag === "bare" ? version : `pwragent-v${version}`;
  const base =
    r.assets.host === "right"
      ? `https://github.com/huntharo/git/releases/download/${tag}/`
      : r.assets.host === "other-repo"
        ? `https://github.com/someone/git/releases/download/${tag}/`
        : `https://github.com/huntharo/git/releases/download/v0.0.0-dev-pwrgit.0/`;
  const names = [
    ...(r.assets.catalog ? ["runtime-manifest.json"] : []),
    ...(r.assets.sums ? ["SHA256SUMS"] : []),
    ...Array.from({ length: r.assets.archives }, (_, i) => `pwrgit-${version}-${i === 0 ? "97dd200" : "1234567"}-${key}.tar.gz`)
  ];
  return {
    tag_name: tag,
    ...(r.draft === "missing" ? {} : { draft: r.draft }),
    prerelease: r.prerelease,
    assets: names.map((name) => ({ name, browser_download_url: base + name }))
  };
}

/** The rule, written plainly: the oracle the selection is held to. */
function reference(releases: GenRelease[], bundled: string): string[] {
  const floor = parseManagedGitVersion(bundled);
  const ok = releases.filter(
    (r) =>
      r.draft === false &&
      r.tag === "v" &&
      r.assets.catalog &&
      r.assets.sums &&
      r.assets.archives === 1 &&
      r.assets.host === "right" &&
      (floor === null || compareManagedGitVersions(parseManagedGitVersion(versionOf(r)) as never, floor) > 0)
  );
  const counts = new Map<string, number>();
  for (const r of ok) counts.set(versionOf(r), (counts.get(versionOf(r)) ?? 0) + 1);
  return [...counts.entries()]
    .filter(([, count]) => count === 1)
    .map(([version]) => version)
    .sort((a, b) => compareManagedGitVersions(parseManagedGitVersion(b) as never, parseManagedGitVersion(a) as never));
}

describe("eligibleReleases", () => {
  test("offers exactly the complete, published, newer releases, newest first", () => {
    fc.assert(
      fc.property(
        fc.array(genRelease, { maxLength: 12 }),
        fc.constantFrom<PlatformKey>(...KEYS),
        fc.integer({ min: 0, max: 8 }),
        (releases, key, floor) => {
          const bundled = `2.56.0-dev-pwrgit.${floor}`;
          const got = eligibleReleases(releases.map((r) => render(r, key)), key, bundled).map((c) => c.version);
          expect(got).toEqual(reference(releases, bundled));
        }
      ),
      { numRuns: 400 }
    );
  });

  test("GitHub's prerelease flag never changes the answer", () => {
    fc.assert(
      fc.property(fc.array(genRelease, { maxLength: 8 }), fc.constantFrom<PlatformKey>(...KEYS), (releases, key) => {
        const flipped = releases.map((r) => ({ ...r, prerelease: !r.prerelease }));
        const answer = (list: GenRelease[]) => eligibleReleases(list.map((r) => render(r, key)), key, "2.56.0-dev-pwrgit.0").map((c) => c.version);
        expect(answer(flipped)).toEqual(answer(releases));
      })
    );
  });

  test("an archive for another platform is no archive for this one", () => {
    const release = render({ major: 2, build: 5, draft: false, prerelease: true, tag: "v", assets: { catalog: true, sums: true, archives: 1, host: "right" } }, "linux-arm64");
    expect(eligibleReleases([release], "linux-x64", "2.56.0-dev-pwrgit.4")).toEqual([]);
    expect(eligibleReleases([release], "linux-arm64", "2.56.0-dev-pwrgit.4").map((c) => c.version)).toEqual(["2.56.0-dev-pwrgit.5"]);
  });
});
