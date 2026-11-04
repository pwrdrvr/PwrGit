// Properties of the four update slots (Stable/Beta × Latest/Prerelease).
//
// Feeds are generated from the release runbook's tag scheme only: `vX.Y.Z`,
// `-prerelease.N`, `-beta.N` and `-alpha.N`. A suffix-free final may be staged
// as a GitHub Pre-release, and any release may be a draft. Every suffixed tag
// is a GitHub Pre-release, as the release workflow publishes them.
//
// Each property is a rule from `selectChannelReleases`' comment, not from its
// current output. Against the code before each fix:
//   - P1 fails at #90 (4ebdb1f) on run 2, with the one-release feed `[v0.0.0]`,
//     and before #280, where Beta followers were stuck below Stable Latest.
//   - P2 fails before #417, where Beta · Prerelease trailed a staged final.
import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import type { GitHubRelease } from "./update-release-state";

vi.mock("electron", () => ({ app: { isPackaged: true, getPath: vi.fn(), quit: vi.fn() } }));
vi.mock("electron-updater", () => ({ default: { autoUpdater: {} } }));
vi.mock("./ipc", () => ({ emitEvent: vi.fn() }));
vi.mock("./logs", () => ({ logMain: vi.fn() }));

const { selectChannelReleases } = await import("./auto-updater");

type Kind = "final" | "prerelease" | "beta" | "alpha";
type Tag = { core: [number, number, number]; kind: Kind; n: number };

function tagName(tag: Tag): string {
  const core = tag.core.join(".");
  return tag.kind === "final" ? `v${core}` : `v${core}-${tag.kind}.${tag.n}`;
}

function parseTag(name: string | undefined): Tag {
  const match = /^v(\d+)\.(\d+)\.(\d+)(?:-(prerelease|beta|alpha)\.(\d+))?$/.exec(name ?? "");
  if (!match) throw new Error(`not a generated tag: ${name}`);
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    kind: (match[4] as Kind | undefined) ?? "final",
    n: Number(match[5] ?? 0)
  };
}

function compareCore(a: Tag, b: Tag): number {
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) return a.core[i]! - b.core[i]!;
  }
  return 0;
}

/** Semver precedence, written out for this scheme only, so the oracle does
 *  not share code with the module it judges. A final outranks its own
 *  prereleases; `alpha` < `beta` < `prerelease` is also their ASCII order. */
function compareTags(a: string | undefined, b: string | undefined): number {
  const x = parseTag(a);
  const y = parseTag(b);
  const core = compareCore(x, y);
  if (core !== 0) return core;
  if (x.kind === y.kind) return x.n - y.n;
  if (x.kind === "final") return 1;
  if (y.kind === "final") return -1;
  return x.kind < y.kind ? -1 : 1;
}

const tagArb: fc.Arbitrary<Tag> = fc.record({
  // Small ranges, so cores collide and an alpha and a beta share one.
  core: fc.tuple(fc.nat(2), fc.nat(2), fc.nat(2)),
  kind: fc.constantFrom<Kind>("final", "prerelease", "beta", "alpha"),
  n: fc.integer({ min: 1, max: 3 })
});

const releaseArb: fc.Arbitrary<GitHubRelease> = fc
  .record({
    tag: tagArb,
    stagedAsPrerelease: fc.boolean(),
    draft: fc.nat(4).map((n) => n === 0)
  })
  .map(({ tag, stagedAsPrerelease, draft }) => ({
    tag_name: tagName(tag),
    prerelease: tag.kind !== "final" || stagedAsPrerelease,
    draft
  }));

const feedArb = fc.uniqueArray(releaseArb, {
  maxLength: 8,
  selector: (release) => release.tag_name
});

const published = (feed: GitHubRelease[]) => feed.filter((r) => r.draft !== true);

/** The highest release GitHub marks Latest: published, not a Pre-release. */
function oracleStableLatest(feed: GitHubRelease[]): string | undefined {
  return published(feed)
    .filter((r) => r.prerelease !== true)
    .map((r) => r.tag_name)
    .sort(compareTags)
    .at(-1);
}

const tagOf = (release: GitHubRelease | undefined) => release?.tag_name;

/** `lower` ≤ `upper`, where a missing `lower` bounds nothing and a missing
 *  `upper` is below any release. */
function atMost(lower: GitHubRelease | undefined, upper: GitHubRelease | undefined): boolean {
  if (lower === undefined) return true;
  return upper !== undefined && compareTags(lower.tag_name, upper.tag_name) <= 0;
}

describe("selectChannelReleases", () => {
  it("P0: every slot is a published release, and Stable Latest is the highest GitHub Latest", () => {
    fc.assert(
      fc.property(feedArb, (feed) => {
        const slots = selectChannelReleases(feed);
        const publishedTags = new Set(published(feed).map((r) => r.tag_name));
        for (const slot of Object.values(slots)) {
          if (slot) expect(publishedTags).toContain(slot.tag_name);
        }
        expect(tagOf(slots.stableLatest)).toBe(oracleStableLatest(feed));
      })
    );
  });

  it("P1: with a Stable Latest, every slot is set and none is below it", () => {
    fc.assert(
      fc.property(feedArb, (feed) => {
        fc.pre(oracleStableLatest(feed) !== undefined);
        const { stableLatest, stablePrerelease, betaLatest, betaPrerelease } =
          selectChannelReleases(feed);
        expect(stableLatest).toBeDefined();
        for (const slot of [stablePrerelease, betaLatest, betaPrerelease]) {
          expect(slot).toBeDefined();
          expect(compareTags(tagOf(slot), tagOf(stableLatest))).toBeGreaterThanOrEqual(0);
        }
      })
    );
  });

  it("P2: Prerelease never trails Latest, and Beta never trails Stable", () => {
    fc.assert(
      fc.property(feedArb, (feed) => {
        // Outside the runbook's scheme: a `-beta.N` line with no same-core
        // alpha and no Stable Latest is the pre-1.0 world, whose betas were
        // Stable prereleases. Stable · Prerelease offers it and Beta ·
        // Prerelease does not, on purpose (#417's "outside the runbook's tag
        // scheme"). Every other feed must keep the lattice.
        fc.pre(!hasLegacyBetaLineWithoutLatest(feed));
        const s = selectChannelReleases(feed);
        expect(atMost(s.stableLatest, s.stablePrerelease)).toBe(true);
        expect(atMost(s.stablePrerelease, s.betaPrerelease)).toBe(true);
        expect(atMost(s.stableLatest, s.betaLatest)).toBe(true);
        expect(atMost(s.betaLatest, s.betaPrerelease)).toBe(true);
      })
    );
  });

  it("P3: the order releases were published in does not change any slot", () => {
    const feedAndShuffleArb = feedArb.chain((feed) =>
      fc.tuple(
        fc.constant(feed),
        fc.shuffledSubarray(feed, { minLength: feed.length, maxLength: feed.length })
      )
    );
    fc.assert(
      fc.property(feedAndShuffleArb, ([feed, shuffled]) => {
        const a = selectChannelReleases(feed);
        const b = selectChannelReleases(shuffled);
        for (const key of Object.keys(a) as Array<keyof typeof a>) {
          expect(tagOf(b[key])).toBe(tagOf(a[key]));
        }
      })
    );
  });
});

function hasLegacyBetaLineWithoutLatest(feed: GitHubRelease[]): boolean {
  if (oracleStableLatest(feed) !== undefined) return false;
  const tags = published(feed).map((r) => parseTag(r.tag_name));
  return tags.some(
    (beta) =>
      beta.kind === "beta" &&
      !tags.some((alpha) => alpha.kind === "alpha" && compareCore(alpha, beta) === 0)
  );
}
