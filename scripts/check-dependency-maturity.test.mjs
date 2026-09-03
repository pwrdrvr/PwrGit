import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  auditDependencyMaturity,
  findExclusion,
  matcherCovers,
  parseExclusions,
  parseLockedPackages,
  parseMaturityPolicy,
} from "./check-dependency-maturity.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const WINDOW_MINUTES = 10_080;
const NOW = Date.parse("2026-09-03T12:00:00.000Z");
const DAY = 86_400_000;

function isoDaysAgo(days) {
  return new Date(NOW - days * DAY).toISOString();
}

function audit({ packages, published = {}, exclusions = [] }) {
  const { matchers, unsupported } = parseExclusions(exclusions);
  expect(unsupported).toEqual([]);
  return auditDependencyMaturity({
    packages,
    publishedAt: new Map(Object.entries(published)),
    matchers,
    minimumReleaseAgeMinutes: WINDOW_MINUTES,
    now: NOW,
  });
}

describe("parseMaturityPolicy", () => {
  it("reads the cooldown and its exclusion list past interleaved comments", () => {
    const policy = parseMaturityPolicy(
      [
        "packages:",
        "  - apps/*",
        "",
        "# Supply-chain cooldown.",
        "minimumReleaseAge: 10080",
        "",
        "minimumReleaseAgeExclude:",
        "  # ours, pinned, published moments ago",
        '  - "@pwrdrvr/agent-core"',
        "  - 'zod@4.5.1'",
        "",
        "onlyBuiltDependencies:",
        "  - electron",
      ].join("\n"),
    );

    expect(policy.minimumReleaseAgeMinutes).toBe(10_080);
    expect(policy.exclusions).toEqual(["@pwrdrvr/agent-core", "zod@4.5.1"]);
  });

  it("reports an absent cooldown even when exclusions are listed", () => {
    // The exact drift that shipped: an exclusion list under no gate, so the
    // only cooldown in force was whatever each developer's pnpm config set.
    const policy = parseMaturityPolicy(
      ["minimumReleaseAgeExclude:", '  - "@pwrdrvr/agent-core"'].join("\n"),
    );

    expect(policy.minimumReleaseAgeMinutes).toBeUndefined();
    expect(policy.exclusions).toEqual(["@pwrdrvr/agent-core"]);
  });

  it("does not mistake a nested key for the top-level cooldown", () => {
    const policy = parseMaturityPolicy(
      ["someTool:", "  minimumReleaseAge: 5", "packages:", "  - apps/*"].join("\n"),
    );

    expect(policy.minimumReleaseAgeMinutes).toBeUndefined();
  });
});

// The parsers are hand-rolled against two files this repo owns and reformats
// by hand. Fragments prove the grammar; these prove it still fits the real
// thing, which is where a flow-style list or a quoted scalar would otherwise
// degrade the check to "no policy" or "no exclusions" without failing a test.
describe("against the repository's own files", () => {
  it("finds the declared cooldown and every exclusion in pnpm-workspace.yaml", () => {
    const policy = parseMaturityPolicy(
      readFileSync(join(repoRoot, "pnpm-workspace.yaml"), "utf8"),
    );

    expect(policy.minimumReleaseAgeMinutes).toBe(10_080);
    expect(policy.exclusions).toContain("@pwrdrvr/agent-core");
    expect(policy.exclusions.every((entry) => entry.length > 0)).toBe(true);
    expect(parseExclusions(policy.exclusions).unsupported).toEqual([]);
  });

  it("reads the lockfile's registry releases and nothing else", () => {
    const packages = parseLockedPackages(readFileSync(join(repoRoot, "pnpm-lock.yaml"), "utf8"));

    // A parser that silently stopped matching would return zero or a handful.
    expect(packages.length).toBeGreaterThan(400);
    expect(packages).toContainEqual({ name: "zod", version: "4.5.1" });
    // link:/file: workspace entries carry no registry publish time.
    expect(packages.every(({ version }) => /^\d+\.\d+\.\d+/.test(version))).toBe(true);
    // `snapshots:` keys carry peer suffixes; none may leak through.
    expect(packages.every(({ version }) => !version.includes("("))).toBe(true);
  });
});

describe("parseLockedPackages", () => {
  const lockfile = [
    "lockfileVersion: '9.0'",
    "",
    "importers:",
    "",
    "  .:",
    "    devDependencies:",
    "      zod:",
    "        specifier: ^4.5.1",
    "        version: 4.5.1",
    "",
    "packages:",
    "",
    "  '@rollup/rollup-darwin-arm64@4.62.2':",
    "    resolution: {integrity: sha512-aaa}",
    "    cpu: [arm64]",
    "",
    "  zod@4.5.1:",
    "    resolution: {integrity: sha512-bbb}",
    "",
    "  '@pwrgit/shared@link:packages/shared':",
    "    resolution: {directory: packages/shared, type: directory}",
    "",
    "snapshots:",
    "",
    "  'zod-to-json-schema@3.25.2(zod@4.5.1)':",
    "    dependencies:",
    "      zod: 4.5.1",
  ].join("\n");

  it("reads registry releases out of the packages block", () => {
    expect(parseLockedPackages(lockfile)).toEqual([
      { name: "@rollup/rollup-darwin-arm64", version: "4.62.2" },
      { name: "zod", version: "4.5.1" },
    ]);
  });

  it("stops at snapshots so peer-suffixed keys are not counted twice", () => {
    const names = parseLockedPackages(lockfile).map(({ name }) => name);
    expect(names).not.toContain("zod-to-json-schema");
  });
});

describe("parseExclusions", () => {
  it("rejects semver ranges rather than guessing what they cover", () => {
    const { matchers, unsupported } = parseExclusions(["zod@^4.5.0", "vite@~7.0.0", "esbuild@*"]);

    expect(matchers).toEqual([]);
    expect(unsupported).toEqual(["zod@^4.5.0", "vite@~7.0.0", "esbuild@*"]);
  });

  it("accepts bare names, scope wildcards, exact pins and disjunctions", () => {
    const { matchers, unsupported } = parseExclusions([
      "@pwrdrvr/agent-core",
      "@pwrdrvr/*",
      "zod@4.5.1",
      "ws@8.21.0 || 8.21.1",
    ]);

    expect(unsupported).toEqual([]);
    expect(matchers.map((matcher) => matcher.versions)).toEqual([
      undefined,
      undefined,
      ["4.5.1"],
      ["8.21.0", "8.21.1"],
    ]);
  });
});

describe("matcherCovers", () => {
  const [pin] = parseExclusions(["zod@4.5.1"]).matchers;

  it("is the single predicate findExclusion is built from", () => {
    expect(matcherCovers(pin, "zod", "4.5.1")).toBe(true);
    expect(matcherCovers(pin, "zod", "4.5.4")).toBe(false);
    expect(matcherCovers(pin, "zod-to-json-schema", "4.5.1")).toBe(false);
  });
});

describe("findExclusion", () => {
  const { matchers } = parseExclusions(["@pwrdrvr/*", "zod@4.5.1", "ws@8.21.0 || 8.21.1"]);

  it("matches a scope wildcard at any version", () => {
    expect(findExclusion("@pwrdrvr/agent-core", "9.9.9", matchers)?.entry).toBe("@pwrdrvr/*");
  });

  it("matches a pin only at the pinned version", () => {
    expect(findExclusion("zod", "4.5.1", matchers)?.entry).toBe("zod@4.5.1");
    expect(findExclusion("zod", "4.5.4", matchers)).toBeUndefined();
  });

  it("matches either side of a disjunction", () => {
    expect(findExclusion("ws", "8.21.1", matchers)?.entry).toBe("ws@8.21.0 || 8.21.1");
    expect(findExclusion("ws", "8.20.0", matchers)).toBeUndefined();
  });

  it("does not let a scope wildcard leak across scopes", () => {
    expect(findExclusion("@other/agent-core", "1.0.0", matchers)).toBeUndefined();
  });
});

describe("auditDependencyMaturity", () => {
  it("passes a lockfile whose releases have all aged out", () => {
    const result = audit({
      packages: [
        { name: "zod", version: "4.4.3" },
        { name: "vite", version: "7.0.0" },
      ],
      published: { "zod@4.4.3": isoDaysAgo(120), "vite@7.0.0": isoDaysAgo(8) },
    });

    expect(result.immature).toEqual([]);
    expect(result.unverifiable).toEqual([]);
    expect(result.stale).toEqual([]);
  });

  it("flags a release inside the window and says when it matures", () => {
    const result = audit({
      packages: [{ name: "zod", version: "4.5.1" }],
      published: { "zod@4.5.1": isoDaysAgo(6) },
    });

    expect(result.immature).toHaveLength(1);
    expect(result.immature[0]).toMatchObject({ name: "zod", version: "4.5.1" });
    expect(new Date(result.immature[0].maturesAt).toISOString()).toBe(
      new Date(NOW + DAY).toISOString(),
    );
  });

  it("treats a release exactly at the window as mature", () => {
    const result = audit({
      packages: [{ name: "zod", version: "4.5.1" }],
      published: { "zod@4.5.1": isoDaysAgo(7) },
    });

    expect(result.immature).toEqual([]);
  });

  it("lets an excluded release through and counts it", () => {
    const result = audit({
      packages: [{ name: "zod", version: "4.5.1" }],
      published: { "zod@4.5.1": isoDaysAgo(1) },
      exclusions: ["zod@4.5.1"],
    });

    expect(result.immature).toEqual([]);
    expect(result.excludedCount).toBe(1);
  });

  it("still flags a neighbouring version of an excluded pin", () => {
    // The whole point of preferring the pinned form: exempting 4.5.1 must not
    // wave through whatever Dependabot picks up next.
    const result = audit({
      packages: [
        { name: "zod", version: "4.5.1" },
        { name: "zod", version: "4.5.4" },
      ],
      published: { "zod@4.5.1": isoDaysAgo(6), "zod@4.5.4": isoDaysAgo(5) },
      exclusions: ["zod@4.5.1"],
    });

    expect(result.immature.map(({ version }) => version)).toEqual(["4.5.4"]);
  });

  it("reports a pin whose release has aged out as prunable, without failing", () => {
    const result = audit({
      packages: [{ name: "zod", version: "4.5.1" }],
      published: { "zod@4.5.1": isoDaysAgo(30) },
      exclusions: ["zod@4.5.1"],
    });

    expect(result.immature).toEqual([]);
    expect(result.stale).toEqual([
      { entry: "zod@4.5.1", reason: "zod@4.5.1 has matured past the window" },
    ]);
  });

  it("reports a pin nothing resolves any more as prunable", () => {
    const result = audit({
      packages: [{ name: "zod", version: "4.5.4" }],
      published: { "zod@4.5.4": isoDaysAgo(30) },
      exclusions: ["zod@4.5.1"],
    });

    expect(result.stale).toEqual([
      { entry: "zod@4.5.1", reason: "nothing in the lockfile resolves it" },
    ]);
  });

  it("keeps a scope wildcard pinned to a live version off the prunable list", () => {
    const result = audit({
      packages: [{ name: "@pwrdrvr/agent-core", version: "0.2.0" }],
      published: { "@pwrdrvr/agent-core@0.2.0": isoDaysAgo(1) },
      exclusions: ["@pwrdrvr/*@0.2.0"],
    });

    expect(result.immature).toEqual([]);
    expect(result.stale).toEqual([]);
  });

  it("never reports a bare name as prunable", () => {
    // `@pwrdrvr/*` and friends are standing policy, not a one-release waiver.
    const result = audit({
      packages: [{ name: "@pwrdrvr/agent-core", version: "0.2.0" }],
      published: { "@pwrdrvr/agent-core@0.2.0": isoDaysAgo(30) },
      exclusions: ["@pwrdrvr/agent-core"],
    });

    expect(result.stale).toEqual([]);
  });

  it("reports a release with no known publish time as unverifiable", () => {
    const result = audit({ packages: [{ name: "zod", version: "4.5.1" }] });

    expect(result.unverifiable).toEqual(["zod@4.5.1"]);
    expect(result.immature).toEqual([]);
  });

  it("does not call an excluded release unverifiable", () => {
    const result = audit({
      packages: [{ name: "zod", version: "4.5.1" }],
      exclusions: ["zod@4.5.1"],
    });

    expect(result.unverifiable).toEqual([]);
    expect(result.excludedCount).toBe(1);
  });
});
