import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type {
  BulkSyncForkMode,
  ForkSyncPush,
  RemoteForgeIdentity,
  RepoIdentity
} from "@pwrgit/shared";
import {
  bulkSyncRepositories,
  type BulkSyncForkConfig,
  type BulkSyncRepoInput
} from "./bulk-sync";
import { summarizeBulkForkSyncResult } from "./bulk-sync-fork";
import type { GitExec } from "./dugite";
import { createSystemGit } from "./test-support/system-git";

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "Never",
  GIT_AUTHOR_NAME: "PwrGit Test",
  GIT_AUTHOR_EMAIL: "test@pwrgit.dev",
  GIT_COMMITTER_NAME: "PwrGit Test",
  GIT_COMMITTER_EMAIL: "test@pwrgit.dev"
};

const baseSystemGit: GitExec = createSystemGit({ env: GIT_ENV });

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    env: GIT_ENV,
    encoding: "utf8"
  }).trim();
}

function isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  return (
    spawnSync("git", ["-C", cwd, "merge-base", "--is-ancestor", ancestor, descendant], {
      env: GIT_ENV,
      encoding: "utf8"
    }).status === 0
  );
}

function commitTo(cwd: string, file: string, content: string, message: string): string {
  writeFileSync(join(cwd, file), content);
  git(cwd, "add", file);
  git(cwd, "commit", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

function advanceBareFast(bare: string, message: string): string {
  const parent = git(bare, "rev-parse", "refs/heads/main");
  const tree = git(bare, "rev-parse", `${parent}^{tree}`);
  const commit = git(bare, "commit-tree", tree, "-p", parent, "-m", message);
  git(bare, "update-ref", "refs/heads/main", commit);
  return commit;
}

function createRewritingGit(rewrites: ReadonlyArray<readonly [string, string]>): GitExec {
  return async (args, cwd, options) => {
    const sub = args.find((arg) => !arg.startsWith("-"));
    if ((sub === "fetch" || sub === "push") && rewrites.length > 0) {
      const prefix = rewrites.flatMap(([localPath, forgeUrl]) => [
        "-c",
        `url.${localPath}.insteadOf=${forgeUrl}`
      ]);
      return baseSystemGit([...prefix, ...args], cwd, options);
    }
    return baseSystemGit(args, cwd, options);
  };
}

let seq = 0;

type MultiForkWorld = {
  dir: string;
  checkout: string;
  upstreamBare: string;
  originBare: string;
  personalBare: string;
  coworkerBare: string;
  upstreamWork: string;
  base: string;
  gitExec: GitExec;
  identity: RepoIdentity;
  remoteIdentities: RemoteForgeIdentity[];
  makeRepo: (overrides?: Partial<BulkSyncForkConfig>) => BulkSyncRepoInput;
  reset: () => void;
};

function createMultiForkWorld(parentDir: string, name = "t3code"): MultiForkWorld {
  const dir = join(parentDir, `${name}-${seq++}`);
  const upstreamBare = join(dir, "upstream.git");
  const originBare = join(dir, "origin.git");
  const personalBare = join(dir, "personal.git");
  const coworkerBare = join(dir, "coworker.git");
  const upstreamWork = join(dir, "upstream-work");
  const checkout = join(dir, "checkout");

  git(parentDir, "init", "--bare", "--initial-branch=main", upstreamBare);
  git(dir, "clone", upstreamBare, upstreamWork);
  git(upstreamWork, "config", "core.autocrlf", "false");
  const base = commitTo(upstreamWork, "README.md", "v1\n", "initial");
  git(upstreamWork, "push", "-u", "origin", "main");

  git(dir, "clone", "--bare", upstreamBare, originBare);
  git(dir, "clone", "--bare", upstreamBare, personalBare);
  git(dir, "clone", "--bare", upstreamBare, coworkerBare);

  git(dir, "clone", originBare, checkout);
  git(checkout, "config", "core.autocrlf", "false");
  git(checkout, "remote", "add", "upstream", upstreamBare);
  git(checkout, "remote", "add", "huntharo", personalBare);
  git(checkout, "remote", "add", "coworker", coworkerBare);
  git(checkout, "fetch", "--all");

  // Keep authentic GitHub SSH URLs on the checkout remotes while redirecting
  // fetch/push transport to the local bare repositories.
  const rewrites: ReadonlyArray<readonly [string, string]> = [
    [upstreamBare, "git@github.com:pingdotgg/t3code.git"],
    [originBare, "git@github.com:pwrdrvr/t3code.git"],
    [personalBare, "git@github.com:huntharo/t3code.git"],
    [coworkerBare, "git@github.com:coworker/t3code.git"]
  ];
  git(checkout, "remote", "set-url", "upstream", "git@github.com:pingdotgg/t3code.git");
  git(checkout, "remote", "set-url", "origin", "git@github.com:pwrdrvr/t3code.git");
  git(checkout, "remote", "set-url", "huntharo", "git@github.com:huntharo/t3code.git");
  git(checkout, "remote", "set-url", "coworker", "git@github.com:coworker/t3code.git");

  const identity: RepoIdentity = {
    host: "github",
    hostname: "github.com",
    owner: "pwrdrvr",
    name: "t3code",
    nameWithOwner: "pwrdrvr/t3code",
    visibility: "public",
    viewerCanPush: true,
    parent: {
      nameWithOwner: "pingdotgg/t3code",
      url: "https://github.com/pingdotgg/t3code"
    }
  };
  const remoteIdentities: RemoteForgeIdentity[] = [
    {
      hostname: "github.com",
      nameWithOwner: "huntharo/t3code",
      viewerCanPush: true,
      parent: "pingdotgg/t3code"
    },
    {
      hostname: "github.com",
      nameWithOwner: "coworker/t3code",
      viewerCanPush: false,
      parent: "pingdotgg/t3code"
    }
  ];
  const gitExec = createRewritingGit(rewrites);

  const makeRepo = (overrides: Partial<BulkSyncForkConfig> = {}): BulkSyncRepoInput => ({
    id: `repo-${seq}`,
    name,
    path: checkout,
    worktrees: [{ id: `wt-${seq}`, branch: "main", path: checkout }],
    forkSync: {
      mode: "sync",
      parent: { hostname: "github.com", nameWithOwner: "pingdotgg/t3code" },
      identity,
      remoteIdentities,
      forkSyncPrefs: new Map(),
      hosts: {},
      ...overrides
    }
  });

          const reset = (): void => {
            for (const bare of [upstreamBare, originBare, personalBare, coworkerBare]) {
              git(bare, "update-ref", "refs/heads/main", base);
            }
            git(checkout, "reset", "--hard", base);
            git(checkout, "clean", "-fd");
            for (const remote of ["origin", "upstream", "huntharo", "coworker"]) {
              git(checkout, "update-ref", `refs/remotes/${remote}/main`, base);
            }
          };

  return {
    dir,
    checkout,
    upstreamBare,
    originBare,
    personalBare,
    coworkerBare,
    upstreamWork,
    base,
    gitExec,
    identity,
    remoteIdentities,
    makeRepo,
    reset
  };
}

describe("summarizeBulkForkSyncResult properties", () => {
  const pushArb: fc.Arbitrary<ForkSyncPush> = fc.oneof(
    fc.record({
      outcome: fc.constant("pushed" as const),
      remote: fc.constantFrom("origin", "huntharo"),
      branch: fc.constant("main")
    }),
    fc.record({
      outcome: fc.constant("up_to_date" as const),
      remote: fc.constantFrom("origin", "huntharo"),
      branch: fc.constant("main")
    }),
    fc.record({
      outcome: fc.constant("skipped" as const),
      remote: fc.constantFrom("origin", "huntharo"),
      branch: fc.constant("main")
    }),
    fc.record({
      outcome: fc.constant("diverged" as const),
      remote: fc.constantFrom("origin", "huntharo"),
      branch: fc.constant("main"),
      overwrites: fc.integer({ min: 1, max: 5 })
    }),
    fc.record({
      outcome: fc.constant("failed" as const),
      remote: fc.constantFrom("origin", "huntharo"),
      branch: fc.constant("main"),
      message: fc.constantFrom("Push rejected", "Authentication failed")
    }),
    fc.record({
      outcome: fc.constant("fetch_failed" as const),
      remote: fc.constantFrom("origin", "huntharo"),
      branch: fc.constant("main"),
      message: fc.constant("Fetch failed")
    }),
    fc.record({
      outcome: fc.constant("stopped" as const),
      remote: fc.constantFrom("origin", "huntharo"),
      branch: fc.constant("main")
    })
  );

  it("classifies worktree outcome monotonically across all push combinations", () => {
    const worktree = { id: "wt-1", branch: "main", path: "/repos/t3code" };
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.array(pushArb, { maxLength: 5 }),
        (headMoved, pushes) => {
          const res = summarizeBulkForkSyncResult({
            worktree,
            branch: "main",
            beforeHead: "a".repeat(40),
            afterHead: headMoved ? "b".repeat(40) : "a".repeat(40),
            headMoved,
            sourceLabel: "upstream/main",
            pushes
          });

          const hasStopped = pushes.some((p) => p.outcome === "stopped");
          const hasFailed = pushes.some(
            (p) => p.outcome === "failed" || p.outcome === "fetch_failed"
          );
          const hasPushed = pushes.some((p) => p.outcome === "pushed");
          const hasDiverged = pushes.some((p) => p.outcome === "diverged");

          if (hasStopped) {
            expect(res.outcome).toBe("cancelled");
          } else if (hasFailed) {
            expect(res.outcome).toBe("failed");
            expect(["authentication", "fork_push_failed"]).toContain(res.reason);
          } else if (headMoved || hasPushed) {
            expect(res.outcome).toBe("updated");
          } else if (hasDiverged) {
            expect(res.outcome).toBe("skipped");
            expect(res.reason).toBe("diverged");
          } else {
            expect(res.outcome).toBe("up_to_date");
          }
        }
      ),
      { numRuns: 200 }
    );
  });
});

describe("bulk soft-pull fork sync (real-git property & oracle tests)", () => {
  let propRoot: string;
  let world: MultiForkWorld;

  beforeAll(() => {
    propRoot = mkdtempSync(join(tmpdir(), "pwrgit-bulk-fork-prop-"));
    world = createMultiForkWorld(propRoot, "prop");
  });

  afterAll(() => {
    rmSync(propRoot, { recursive: true, force: true });
  });

  it("never force-overwrites any branch, respects mode/dirty/prefs, and syncs clean fast-forwardable forks", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          mode: fc.constantFrom<BulkSyncForkMode>("sync", "source", "tracked"),
          dirty: fc.boolean(),
          upstreamCommits: fc.integer({ min: 0, max: 2 }),
          originState: fc.constantFrom("base", "diverged", "ahead_of_upstream"),
          personalState: fc.constantFrom("base", "diverged"),
          personalEnabled: fc.boolean(),
          localDiverged: fc.boolean()
        }),
        async (scenario) => {
          world.reset();
          const runId = seq++;

          // Advance upstream/main by 0..2 commits via fast commit-tree plumbing.
          let upstreamTip = world.base;
          for (let i = 0; i < scenario.upstreamCommits; i += 1) {
            upstreamTip = advanceBareFast(
              world.upstreamBare,
              `upstream ${runId}-${i}`
            );
          }

          // Shape origin/main.
          if (scenario.originState === "diverged") {
            advanceBareFast(world.originBare, `origin ${runId}`);
          } else if (scenario.originState === "ahead_of_upstream" && scenario.upstreamCommits === 0) {
            advanceBareFast(world.originBare, `moved ${runId}`);
          }

          // Shape huntharo/main.
          if (scenario.personalState === "diverged") {
            advanceBareFast(world.personalBare, `personal ${runId}`);
          }

          // Optionally diverge local main.
          if (scenario.localDiverged) {
            const tree = git(world.checkout, "rev-parse", "HEAD^{tree}");
            const localTip = git(
              world.checkout,
              "commit-tree",
              tree,
              "-p",
              world.base,
              "-m",
              `local ${runId}`
            );
            git(world.checkout, "update-ref", "refs/heads/main", localTip);
          }
          if (scenario.dirty) {
            writeFileSync(join(world.checkout, "dirty.txt"), "untracked\n");
          }

          const beforeLocal = git(world.checkout, "rev-parse", "HEAD");
          const beforeOrigin = git(world.originBare, "rev-parse", "refs/heads/main");
          const beforePersonal = git(world.personalBare, "rev-parse", "refs/heads/main");
          const beforeCoworker = git(world.coworkerBare, "rev-parse", "refs/heads/main");
          const beforeUpstream = git(world.upstreamBare, "rev-parse", "refs/heads/main");

          const prefs = new Map<string, boolean>();
          if (!scenario.personalEnabled) prefs.set("huntharo", false);

          const summary = await bulkSyncRepositories(
            world.gitExec,
            [world.makeRepo({ mode: scenario.mode, forkSyncPrefs: prefs })],
            { operationId: `prop-${runId}`, mode: "soft-pull" }
          );
          expect(summary.results).toHaveLength(1);

          const afterLocal = git(world.checkout, "rev-parse", "HEAD");
          const afterOrigin = git(world.originBare, "rev-parse", "refs/heads/main");
          const afterPersonal = git(world.personalBare, "rev-parse", "refs/heads/main");
          const afterCoworker = git(world.coworkerBare, "rev-parse", "refs/heads/main");
          const afterUpstream = git(world.upstreamBare, "rev-parse", "refs/heads/main");

          // Universal Rule 1: Read-only remote and upstream source are NEVER written.
          expect(afterCoworker).toBe(beforeCoworker);
          expect(afterUpstream).toBe(beforeUpstream);

          // Universal Rule 2: No local or remote branch is EVER force-overwritten.
          expect(isAncestor(world.checkout, beforeLocal, afterLocal)).toBe(true);
          expect(isAncestor(world.originBare, beforeOrigin, afterOrigin)).toBe(true);
          expect(isAncestor(world.personalBare, beforePersonal, afterPersonal)).toBe(true);

          // Universal Rule 3: Dirty checkout NEVER moves HEAD.
          if (scenario.dirty) {
            expect(afterLocal).toBe(beforeLocal);
          }

          // Universal Rule 4: Non-sync modes NEVER push to any fork remote.
          if (scenario.mode !== "sync") {
            expect(afterOrigin).toBe(beforeOrigin);
            expect(afterPersonal).toBe(beforePersonal);
          }

          // Universal Rule 5: Disabled sibling fork is NEVER pushed.
          if (!scenario.personalEnabled) {
            expect(afterPersonal).toBe(beforePersonal);
          }

          // Universal Rule 6: Clean fast-forwardable sync updates local and
          // every enabled fast-forwardable fork remote to upstreamTip.
          const originMovedOn =
            scenario.upstreamCommits === 0 &&
            (scenario.originState === "diverged" || scenario.originState === "ahead_of_upstream");
          const localCanReachUpstream =
            !scenario.localDiverged && !originMovedOn && !scenario.dirty;
          if (scenario.mode === "sync" && localCanReachUpstream) {
            expect(afterLocal).toBe(upstreamTip);
            if (scenario.originState === "base" || (scenario.originState === "ahead_of_upstream" && scenario.upstreamCommits > 0)) {
              expect(afterOrigin).toBe(upstreamTip);
            } else {
              // Diverged origin must NOT be overwritten.
              expect(afterOrigin).toBe(beforeOrigin);
            }
            if (scenario.personalEnabled && scenario.personalState === "base") {
              expect(afterPersonal).toBe(upstreamTip);
              // URL-based sibling push refreshes the local tracking ref too.
              expect(git(world.checkout, "rev-parse", "refs/remotes/huntharo/main")).toBe(upstreamTip);
            } else {
              expect(afterPersonal).toBe(beforePersonal);
            }
          }
        }
      ),
      { numRuns: 6 }
    );
  });
});

describe("bulk soft-pull fork sync examples", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pwrgit-bulk-fork-ex-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("t3code scenario: fast-forwards main from upstream/main and pushes to both origin and huntharo forks", async () => {
    const world = createMultiForkWorld(root, "t3code");
    const upstreamTip = commitTo(world.upstreamWork, "feature.ts", "export const x = 1;\n", "upstream commit");
    git(world.upstreamWork, "push", "origin", "main");

    const summary = await bulkSyncRepositories(
      world.gitExec,
      [world.makeRepo()],
      { operationId: "t3code-1", mode: "soft-pull" }
    );

    const wt = summary.results[0]!.worktrees[0]!;
    expect(summary.results[0]!.outcome).toBe("success");
    expect(wt.outcome).toBe("updated");
    expect(wt.beforeHead).toBe(world.base);
    expect(wt.afterHead).toBe(upstreamTip);
    expect(wt.forkSource).toBe("upstream/main");
    expect(wt.forkPushes).toEqual([
      { outcome: "pushed", remote: "origin", branch: "main" },
      { outcome: "pushed", remote: "huntharo", branch: "main" }
    ]);
    expect(git(world.checkout, "rev-parse", "HEAD")).toBe(upstreamTip);
    expect(git(world.originBare, "rev-parse", "refs/heads/main")).toBe(upstreamTip);
    expect(git(world.personalBare, "rev-parse", "refs/heads/main")).toBe(upstreamTip);
    expect(git(world.checkout, "rev-parse", "refs/remotes/huntharo/main")).toBe(upstreamTip);
    // Read-only sibling fork is never pushed.
    expect(git(world.coworkerBare, "rev-parse", "refs/heads/main")).toBe(world.base);
  });

  it("pushes a lagging sibling fork even when local main and origin/main are already at upstream/main", async () => {
    const world = createMultiForkWorld(root, "lagging-sibling");
    const upstreamTip = commitTo(world.upstreamWork, "new.ts", "1\n", "upstream commit");
    git(world.upstreamWork, "push", "origin", "main");
    // Advance local main and origin/main to upstreamTip, leaving huntharo behind.
    await world.gitExec(["fetch", "upstream"], world.checkout);
    git(world.checkout, "merge", "--ff-only", upstreamTip);
    await world.gitExec(["push", "origin", `${upstreamTip}:refs/heads/main`], world.checkout);

    const summary = await bulkSyncRepositories(
      world.gitExec,
      [world.makeRepo()],
      { operationId: "lagging-1", mode: "soft-pull" }
    );

    const wt = summary.results[0]!.worktrees[0]!;
    expect(wt.outcome).toBe("updated");
    expect(wt.beforeHead).toBe(upstreamTip);
    expect(wt.afterHead).toBe(upstreamTip);
    expect(wt.forkPushes).toEqual([
      { outcome: "up_to_date", remote: "origin", branch: "main" },
      { outcome: "pushed", remote: "huntharo", branch: "main" }
    ]);
    expect(git(world.personalBare, "rev-parse", "refs/heads/main")).toBe(upstreamTip);
  });

  it("falls back to tracked origin/main when the fork has moved on from upstream/main", async () => {
    const world = createMultiForkWorld(root, "moved-on");
    const originTip = advanceBareFast(world.originBare, "fork moved on");

    const summary = await bulkSyncRepositories(
      world.gitExec,
      [world.makeRepo()],
      { operationId: "moved-on-1", mode: "soft-pull" }
    );

    const wt = summary.results[0]!.worktrees[0]!;
    expect(wt.outcome).toBe("updated");
    expect(wt.afterHead).toBe(originTip);
    expect(git(world.checkout, "rev-parse", "HEAD")).toBe(originTip);
    // Neither upstream nor sibling fork was pushed.
    expect(git(world.personalBare, "rev-parse", "refs/heads/main")).toBe(world.base);
    expect(git(world.upstreamBare, "rev-parse", "refs/heads/main")).toBe(world.base);
  });

  it("refuses a sibling fork whose pushurl was redirected to an unconfirmed repository while still pushing origin", async () => {
    const world = createMultiForkWorld(root, "bad-pushurl");
    const upstreamTip = commitTo(world.upstreamWork, "up.ts", "1\n", "upstream");
    git(world.upstreamWork, "push", "origin", "main");
    git(
      world.checkout,
      "remote",
      "set-url",
      "--add",
      "--push",
      "huntharo",
      "git@github.com:someone-else/evil.git"
    );

    const summary = await bulkSyncRepositories(
      world.gitExec,
      [world.makeRepo()],
      { operationId: "bad-url-1", mode: "soft-pull" }
    );

    const wt = summary.results[0]!.worktrees[0]!;
    expect(wt.afterHead).toBe(upstreamTip);
    expect(git(world.originBare, "rev-parse", "refs/heads/main")).toBe(upstreamTip);
    expect(git(world.personalBare, "rev-parse", "refs/heads/main")).toBe(world.base);
    // Sibling remote failed allPushUrlsMatch so it was excluded as an eligible
    // sibling target before pushing, leaving origin cleanly synced.
    expect(wt.outcome).toBe("updated");
  });

  it("keeps feature-branch worktrees on their tracked upstream while syncing main from fork source", async () => {
    const world = createMultiForkWorld(root, "feature-wt");
    const featureDir = join(root, `feature-wt-${seq++}`);
    git(world.checkout, "worktree", "add", "-b", "feat/demo", featureDir, "main");
    await world.gitExec(["push", "-u", "origin", "feat/demo"], featureDir);

    const upstreamTip = commitTo(world.upstreamWork, "up.ts", "1\n", "upstream");
    git(world.upstreamWork, "push", "origin", "main");

    const repo = world.makeRepo();
    repo.worktrees.push({ id: "wt-feat", branch: "feat/demo", path: featureDir });

    const summary = await bulkSyncRepositories(world.gitExec, [repo], {
      operationId: "feat-wt-1",
      mode: "soft-pull"
    });

    const mainRes = summary.results[0]!.worktrees.find((w) => w.branch === "main")!;
    const featRes = summary.results[0]!.worktrees.find((w) => w.branch === "feat/demo")!;
    expect(mainRes.outcome).toBe("updated");
    expect(mainRes.afterHead).toBe(upstreamTip);
    expect(featRes.outcome).toBe("up_to_date");
    expect(git(featureDir, "rev-parse", "HEAD")).toBe(world.base);
  });
});
