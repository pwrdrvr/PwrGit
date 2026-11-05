// Settings › Git's PwrGit’s Git card and its nav child, over any status main
// can send. The oracle is the rule written plainly, not the code's branches:
//
// - The card offers news (accent) exactly when a newer build than the one in
//   use is published, nothing is installing, nothing failed, and the chosen
//   build passed its launch check.
// - "Up to date" is never said while a newer build exists and is not in use.
// - Every nav dot that is not green carries a word and a spoken sentence
//   (settings/AGENTS.md: colour is never the only channel).
// - The nav child and the card chip are the same answer.
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
  MANAGED_GIT_INSTALL_PHASES,
  type GitRuntimeStatus,
  type ManagedGitBuild,
  type ManagedGitProgress,
  type ManagedGitStatus
} from "@pwrgit/shared";
import { gitNavChildren, managedCardState, phaseSentence } from "./git-settings-view";

const VERSIONS = ["2.56.0-dev-pwrgit.5", "2.56.0-dev-pwrgit.6", "2.57.0-dev-pwrgit.1"];

const build = (version: string): ManagedGitBuild => ({
  id: `${version}-97dd200`,
  version,
  sourceRevision: "97dd200ae74c18d4afe94deb03bc79f29b9d774d",
  path: `/fixture/git-runtimes/versions/${version}-97dd200/darwin-universal/bin/git`,
  trust: "signed",
  lfsVersion: "3.7.1",
  installedAt: 1,
  publishedAt: null
});

const progress: fc.Arbitrary<ManagedGitProgress | null> = fc.oneof(
  fc.constant(null),
  fc.record({
    phase: fc.constantFrom<ManagedGitProgress["phase"]>("idle", "checking", ...MANAGED_GIT_INSTALL_PHASES, "ready", "failed"),
    version: fc.constantFrom(...VERSIONS),
    receivedBytes: fc.nat({ max: 50_000_000 }),
    totalBytes: fc.nat({ max: 50_000_000 }),
    updatedAt: fc.constant(1)
  })
);

const status: fc.Arbitrary<ManagedGitStatus> = fc
  .record({
    supported: fc.boolean(),
    latest: fc.option(fc.constantFrom(...VERSIONS), { nil: null }),
    downloaded: fc.subarray(VERSIONS),
    selectedIndex: fc.option(fc.nat({ max: 2 }), { nil: null }),
    installedOverride: fc.boolean(),
    checkedAt: fc.option(fc.constant(1_000), { nil: null }),
    checkError: fc.option(fc.constant("getaddrinfo ENOTFOUND api.github.com"), { nil: null }),
    selectedError: fc.option(fc.constant("bin/git changed"), { nil: null }),
    progress
  })
  .map((input) => {
    const builds = input.downloaded.map(build);
    const selected = input.selectedIndex === null ? null : (builds[input.selectedIndex]?.id ?? null);
    return {
      supported: input.supported,
      bundledVersion: "2.56.0-dev-pwrgit.4",
      latest:
        input.latest === null ? null : { version: input.latest, tag: `v${input.latest}`, publishedAt: null, size: null },
      needsAppUpdate: null,
      checkedAt: input.checkedAt,
      checkError: input.checkError,
      builds,
      selected,
      previous: null,
      inUse: selected !== null && !input.installedOverride && input.selectedError === null,
      selectedError: selected === null ? null : input.selectedError,
      progress: input.progress
    };
  });

/** Whether a newer build than the one in use is published: the rule. */
function newerNotInUse(managed: ManagedGitStatus): boolean {
  if (managed.latest === null) return false;
  const running = managed.inUse ? managed.builds.find((b) => b.id === managed.selected) : undefined;
  return running?.version !== managed.latest.version;
}

const busy = (managed: ManagedGitStatus): boolean =>
  managed.progress !== null && !["idle", "ready", "failed"].includes(managed.progress.phase);

describe("PwrGit’s Git: card chip and nav child", () => {
  test("news exactly when a newer build is waiting and nothing is wrong or running", () => {
    fc.assert(
      fc.property(status, (managed) => {
        const state = managedCardState(managed);
        const expectNews =
          managed.supported &&
          newerNotInUse(managed) &&
          !busy(managed) &&
          managed.progress?.phase !== "failed" &&
          managed.selectedError === null;
        expect(state.dot === "accent" && !busy(managed)).toBe(expectNews);
      }),
      { numRuns: 1000 }
    );
  });

  test("never “Up to date” while a newer build is published and not in use", () => {
    fc.assert(
      fc.property(status, (managed) => {
        const state = managedCardState(managed);
        if (state.chip?.label === "Up to date") {
          expect(newerNotInUse(managed)).toBe(false);
          expect(busy(managed)).toBe(false);
          expect(managed.selectedError).toBeNull();
        }
      }),
      { numRuns: 1000 }
    );
  });

  test("an install in flight always shows, and a failure always reads red", () => {
    fc.assert(
      fc.property(status, (managed) => {
        if (!managed.supported) return;
        const state = managedCardState(managed);
        if (busy(managed)) expect(state.kind).toBe("installing");
        if (managed.progress?.phase === "failed") expect(state.chip?.tone).toBe("err");
      })
    );
  });

  test("every dot that isn’t green has a word and a sentence, and matches the card", () => {
    fc.assert(
      fc.property(status, fc.boolean(), (managed, runtimeFailed) => {
        const runtime: GitRuntimeStatus | null = runtimeFailed
          ? null
          : { active: "bundled", path: "/b/git", keychainHelper: null, candidates: [] };
        const children = gitNavChildren(runtime, runtimeFailed, managed);
        expect(children.map((child) => child.sectionId)).toEqual(["runtime", "managed", "installs"]);
        for (const child of children) {
          if (child.dot !== undefined && child.dot !== "ok") {
            expect(child.chip ?? "").not.toBe("");
            expect(child.stateLabel ?? "").toMatch(new RegExp(`^${child.label}: `));
          }
        }
        const own = children[1]!;
        const state = managedCardState(managed);
        expect(own.dot).toBe(state.dot);
        // No dot, no card chip that claims to know something.
        if (own.dot === undefined) expect(state.chip === undefined || state.kind === "unsupported").toBe(true);
      }),
      { numRuns: 500 }
    );
  });

  test("the live region changes with the phase, never with the byte count", () => {
    fc.assert(
      fc.property(status, fc.nat({ max: 50_000_000 }), (managed, bytes) => {
        if (managed.progress === null) return;
        const moved = { ...managed, progress: { ...managed.progress, receivedBytes: bytes, updatedAt: 2 } };
        expect(phaseSentence(moved)).toBe(phaseSentence(managed));
      })
    );
  });
});
