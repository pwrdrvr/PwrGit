import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { LaneGraph } from "@pwrgit/shared";
import { CommandBus } from "../command-bus";
import type { DB } from "../persistence/db";
import { registerGraphHandlers } from "./graph-handlers";
import type { WorktreeStateService } from "./worktree-state";

// The handler reaches for the real git binary via `execGit`; point that at the
// system git so these run against actual repositories. The rest of ./dugite
// (requireExit0, NO_OPTIONAL_LOCKS) must stay real — git-service imports it at
// runtime, not just as types.
vi.mock("./dugite", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./dugite")>();
  const { spawn } = await import("node:child_process");
  const { ok, err } = await import("@pwrgit/shared");
  return {
    ...actual,
    execGit: (args: string[], cwd: string) =>
      new Promise((resolve) => {
        const proc = spawn("git", args, { cwd });
        let stdout = "";
        let stderr = "";
        proc.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
        proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
        proc.on("close", (code) =>
          resolve(ok({ stdout, stderr, exitCode: code ?? 0 }))
        );
        proc.on("error", (e: Error) =>
          resolve(err({ kind: "git", code: "spawn_failed", message: e.message }))
        );
      })
  };
});

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "Tester",
  GIT_AUTHOR_EMAIL: "t@t.com",
  GIT_COMMITTER_NAME: "Tester",
  GIT_COMMITTER_EMAIL: "t@t.com"
};

function git(dir: string, ...args: string[]): string {
  // stderr is dropped: push/checkout narrate progress there, and dozens of
  // those lines bury the actual test output.
  return execFileSync("git", args, {
    cwd: dir,
    env: GIT_ENV,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
}

function commit(dir: string, file: string, message: string): void {
  writeFileSync(join(dir, file), `${message}\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "-m", message);
}

type WorktreeRow = { id: string; branch: string; path: string };

type Fixture = {
  repo: string;
  release: string;
  /** Unique per fixture: `laneCache` is module-level and keyed on the repo id,
   *  so sharing one would let a test read the previous test's graph. */
  repoId: string;
  worktrees: WorktreeRow[];
};

let repoSeq = 0;

/**
 * A repo whose `releases/1.0` worktree has diverged from its upstream: one
 * commit of ours that is not pushed, one of theirs that we fetched but never
 * applied. The shape a release branch takes mid-backport.
 */
function makeDivergedRelease(): Fixture {
  repoSeq += 1;
  const repoId = `repo-${repoSeq}`;
  const root = mkdtempSync(join(tmpdir(), "pwrgit-lanes-"));
  const repo = join(root, "repo");
  const remote = join(root, "remote.git");
  mkdirSync(repo, { recursive: true });
  git(root, "init", "--bare", "remote.git");
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "t@t.com");
  git(repo, "config", "user.name", "Tester");
  git(repo, "config", "core.autocrlf", "false");
  git(repo, "remote", "add", "origin", remote);
  commit(repo, "base.txt", "main: base");
  git(repo, "push", "-u", "origin", "main");

  // The release branch lives in its own linked worktree, as it does in the app.
  const release = join(root, "wt-releases-1.0");
  git(repo, "worktree", "add", "-b", "releases/1.0", release);
  commit(release, "backport.txt", "rel: shared backport");
  git(release, "push", "-u", "origin", "releases/1.0");

  // Someone else lands a fix on the release branch and pushes it.
  git(repo, "checkout", "-q", "-b", "their-push", "origin/releases/1.0");
  commit(repo, "their-fix.txt", "rel: upstream fix nobody has locally");
  git(repo, "push", "origin", "their-push:releases/1.0");
  git(repo, "checkout", "-q", "main");
  git(repo, "branch", "-D", "their-push");

  // Meanwhile we commit locally without pushing.
  commit(release, "prepare.txt", "rel: prepare v1.0.3");

  // Main moves on, so the trunk is more than a single commit.
  commit(repo, "main-1.txt", "main: later work");
  git(repo, "push", "origin", "main");
  git(repo, "fetch", "origin");

  return {
    repo,
    release,
    repoId,
    worktrees: [
      { id: "wt-main", branch: "main", path: repo },
      { id: "wt-rel", branch: "releases/1.0", path: release }
    ]
  };
}

/** Commit onto `branch` without checking it out — cheap enough to build the
 *  dozens of branches the active-cap case needs. Dates are strictly increasing
 *  because git's 1-second resolution would otherwise tie the sort, and are
 *  offset from the repo's OWN newest commit rather than a fixed epoch: an
 *  absolute date stops being "newer than the fixture" the day the clock
 *  passes it. */
function commitOnto(repo: string, branch: string, message: string, step: number): void {
  const tree = git(repo, "rev-parse", "main^{tree}").trim();
  const parent = git(repo, "rev-parse", "main").trim();
  const newest = Number(git(repo, "log", "-1", "--format=%ct", "main").trim());
  const when = `${newest + 60 * (step + 1)} +0000`;
  const sha = execFileSync(
    "git",
    ["commit-tree", tree, "-p", parent, "-m", message],
    {
      cwd: repo,
      env: { ...GIT_ENV, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when },
      encoding: "utf8"
    }
  ).trim();
  git(repo, "update-ref", `refs/heads/${branch}`, sha);
}

/** A db that answers each of graph:lanes' statements from in-memory rows. */
function fakeDb(repoId: string, worktrees: WorktreeRow[]): DB {
  return {
    prepare: (sql: string) => ({
      get: (id: string) => {
        const row = worktrees.find((w) => w.id === id);
        if (row === undefined) return undefined;
        return {
          path: row.path,
          repo_id: repoId,
          branch: row.branch,
          email: "t@t.com"
        };
      },
      all: () => {
        if (sql.includes("FROM branch_pr")) return [];
        if (sql.includes("SELECT id, branch, path FROM worktrees")) return worktrees;
        return worktrees.map((w) => ({ branch: w.branch }));
      }
    })
  } as unknown as DB;
}

function harness(fixture: Fixture, extra: WorktreeRow[] = []): CommandBus {
  const bus = new CommandBus();
  const state = {
    resolveDefaultBranch: async () => ({ name: "main", ref: "origin/main" })
  } as unknown as WorktreeStateService;
  registerGraphHandlers(
    bus,
    fakeDb(fixture.repoId, [...fixture.worktrees, ...extra]),
    state
  );
  return bus;
}

async function lanes(
  bus: CommandBus,
  scope: "active" | "all",
  worktreeId = "wt-rel"
): Promise<LaneGraph> {
  const res = await bus.dispatch("graph:lanes", {
    worktreeId,
    scope,
    force: true
  });
  if (!res.ok) throw new Error(`graph:lanes failed: ${res.error.message}`);
  return res.value;
}

const subjects = (graph: LaneGraph): string[] =>
  graph.commits.map((c) => c.subject);

describe("graph:lanes — unapplied upstream work on non-default branches", () => {
  it.each(["active", "all"] as const)(
    "draws the upstream's unapplied commits for a diverged release branch (%s scope)",
    async (scope) => {
      const fixture = makeDivergedRelease();
      const graph = await lanes(harness(fixture), scope);

      // The commit only origin/releases/1.0 reaches must be in the window —
      // the point of "you are 1 behind" is being able to see what it is.
      expect(subjects(graph)).toContain("rel: upstream fix nobody has locally");
      // ...and its ref has to be drawn, or the row renders with no chip and
      // without the dashed "fetched but not applied" lineage.
      expect(graph.upstreamRefs).toContain("origin/releases/1.0");
    }
  );

  it("keeps the local-only commit too, so the divergence reads as a fork", async () => {
    const fixture = makeDivergedRelease();
    const graph = await lanes(harness(fixture), "active");

    expect(subjects(graph)).toEqual(
      expect.arrayContaining([
        "rel: prepare v1.0.3",
        "rel: upstream fix nobody has locally",
        "rel: shared backport"
      ])
    );
  });

  it("walks both legs of a rewritten divergence, down to the merge base", async () => {
    const fixture = makeDivergedRelease();
    // The same two changes on each side with different SHAs — what a rebase or
    // a cherry-pick onto another base leaves behind. Subjects match; nothing
    // else does. Git sees a genuine fork, so both legs have to be walked or
    // the graph silently claims their work is ours.
    git(fixture.repo, "checkout", "-q", "-b", "their-rewrite", "origin/releases/1.0");
    commit(fixture.repo, "fix-x.txt", "rel: fix X");
    commit(fixture.repo, "fix-y.txt", "rel: fix Y");
    git(fixture.repo, "push", "origin", "their-rewrite:releases/1.0");
    const theirs = git(fixture.repo, "rev-list", "-n", "2", "origin/releases/1.0")
      .trim()
      .split("\n");
    git(fixture.repo, "checkout", "-q", "main");
    git(fixture.repo, "branch", "-D", "their-rewrite");

    // Our versions of the same two changes, with different bytes.
    writeFileSync(join(fixture.release, "fix-x.txt"), "x, resolved differently\n");
    git(fixture.release, "add", "-A");
    git(fixture.release, "commit", "-m", "rel: fix X");
    writeFileSync(join(fixture.release, "fix-y.txt"), "y, resolved differently\n");
    git(fixture.release, "add", "-A");
    git(fixture.release, "commit", "-m", "rel: fix Y");
    git(fixture.repo, "fetch", "origin");

    const graph = await lanes(harness(fixture), "active");
    const hashes = new Set(graph.commits.map((c) => c.hash));

    // Both of THEIR rewritten commits, by SHA — matching subjects would pass
    // against our own copies and prove nothing.
    for (const hash of theirs) expect(hashes).toContain(hash);
    // Our leg survives alongside them, and the fork commit anchors both.
    expect(subjects(graph)).toEqual(
      expect.arrayContaining(["rel: prepare v1.0.3", "rel: shared backport"])
    );
    expect(subjects(graph).filter((s) => s === "rel: fix X")).toHaveLength(2);
  });

  it(
    "covers the focused worktree's branch even when the active cap hides it",
    async () => {
      const fixture = makeDivergedRelease();
      // 31 branches newer than releases/1.0 push it past ACTIVE_DRAW_CAP (30).
      // The branch the user is actually looking at must survive that cull.
      const extra: WorktreeRow[] = [];
      for (let i = 0; i < 31; i += 1) {
        const branch = `feature/${i}`;
        commitOnto(fixture.repo, branch, `feature ${i}`, i);
        extra.push({ id: `wt-f${i}`, branch, path: fixture.repo });
      }

      const graph = await lanes(harness(fixture, extra), "active");
      expect(graph.shownBranches).not.toContain("releases/1.0");
      expect(subjects(graph)).toContain("rel: upstream fix nobody has locally");
      expect(graph.upstreamRefs).toContain("origin/releases/1.0");
    },
    60_000
  );

  it("never re-adds the trunk's own ref via a branch that tracks it", async () => {
    const fixture = makeDivergedRelease();
    // Branches cut from main and never pushed keep origin/main as upstream, so
    // most of them read as behind. Handing origin/main to a feature branch's
    // lane would let it claim the spine — the trunk walk already draws it.
    git(fixture.repo, "checkout", "-q", "-b", "tracks-main", "origin/main~1");
    git(fixture.repo, "branch", "--set-upstream-to=origin/main", "tracks-main");
    commit(fixture.repo, "side.txt", "side: unpushed work");
    git(fixture.repo, "checkout", "-q", "main");

    const graph = await lanes(
      harness(fixture, [
        { id: "wt-tracks", branch: "tracks-main", path: fixture.repo }
      ]),
      "active"
    );

    expect(graph.shownBranches).toContain("tracks-main");
    expect(graph.upstreamRefs).not.toContain("origin/main");
    expect(graph.shownBranches).not.toContain("origin/main");
  });

  it("draws a ref once when it is already shown as a branch of its own", async () => {
    const fixture = makeDivergedRelease();
    // Merge the release branch into main and push: the local branch now fails
    // `--no-merged`, so "all" scope never sees it and keeps the *remote* as a
    // branch in its own right. The focused worktree still tracks that remote
    // and is still behind it, so the per-worktree step must not add it again.
    git(fixture.repo, "merge", "--no-ff", "-m", "merge release", "releases/1.0");
    git(fixture.repo, "push", "origin", "main");
    git(fixture.repo, "fetch", "origin");

    const graph = await lanes(harness(fixture), "all");

    expect(graph.shownBranches).toContain("origin/releases/1.0");
    const drawn = [...graph.shownBranches, ...graph.upstreamRefs];
    expect(drawn.filter((r) => r === "origin/releases/1.0")).toHaveLength(1);
  });

  it("keeps upstream refs out of the branch count the toolbar reports", async () => {
    const fixture = makeDivergedRelease();
    const graph = await lanes(harness(fixture), "active");

    // "N of M active branches" reads shownBranches.length. An upstream ref is
    // not an active branch, so folding it in there would inflate the count.
    expect(graph.upstreamRefs).toContain("origin/releases/1.0");
    expect(graph.shownBranches).toEqual(["releases/1.0"]);
  });

  it("does not pull in upstream refs for branches that are not behind", async () => {
    const fixture = makeDivergedRelease();
    // A branch level with its upstream has nothing unapplied to show; drawing
    // its remote ref would double the lane for no information.
    git(fixture.repo, "checkout", "-q", "-b", "in-sync", "main");
    commit(fixture.repo, "sync.txt", "sync: work");
    git(fixture.repo, "push", "-q", "-u", "origin", "in-sync");
    git(fixture.repo, "checkout", "-q", "main");

    const graph = await lanes(
      harness(fixture, [
        { id: "wt-sync", branch: "in-sync", path: fixture.repo }
      ]),
      "active"
    );

    expect(graph.shownBranches).toContain("in-sync");
    expect(graph.upstreamRefs).not.toContain("origin/in-sync");
  });
});
