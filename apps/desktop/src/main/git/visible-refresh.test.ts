import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorktreeState } from "@pwrgit/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type DB } from "../persistence/db";
import {
  checkoutGitDir,
  refsFingerprint,
  UNFOCUSED_STALE_FACTOR,
  VISIBLE_BATCH,
  VISIBLE_STALE_MS,
  VisibleWorktreeRefresher
} from "./visible-refresh";

function state(id: string, behind: number, updatedAt: number): WorktreeState {
  return {
    worktreeId: id,
    branch: "main",
    head: "abc",
    hasUpstream: true,
    ahead: 0,
    behind,
    dirty: 0,
    behindDefault: 0,
    defaultBranch: "main",
    mergedIntoDefault: false,
    divergedFromDefault: false,
    isDefaultBranch: true,
    updatedAt: new Date(updatedAt).toISOString()
  };
}

describe("VisibleWorktreeRefresher", () => {
  let db: DB;
  let clock: number;
  let focused: boolean;
  let stamps: Map<string, string>;
  let cache: Map<string, WorktreeState>;
  let behindNext: Map<string, number>;
  let computed: string[];
  let emitted: string[];
  let refresher: VisibleWorktreeRefresher;

  const addRepo = (profile: string, repo: string, worktrees: string[]): void => {
    db.prepare(
      "INSERT OR IGNORE INTO profiles (id, name, email) VALUES (?, ?, 'p@example.com')"
    ).run(profile, profile);
    db.prepare(
      "INSERT INTO repos (id, profile_id, name, path) VALUES (?, ?, ?, ?)"
    ).run(repo, profile, repo, `/r/${repo}`);
    for (const id of worktrees) {
      db.prepare(
        "INSERT INTO worktrees (id, repo_id, branch, path) VALUES (?, ?, 'main', ?)"
      ).run(id, repo, `/r/${repo}/${id}`);
      cache.set(id, state(id, 0, clock));
    }
  };

  beforeEach(() => {
    db = openDatabase(":memory:");
    clock = 1_000_000;
    focused = true;
    stamps = new Map();
    cache = new Map();
    behindNext = new Map();
    computed = [];
    emitted = [];
    refresher = new VisibleWorktreeRefresher({
      db,
      state: {
        getCached: (id) => cache.get(id) ?? null,
        compute: (id) => {
          computed.push(id);
          const fresh = state(id, behindNext.get(id) ?? 0, clock);
          cache.set(id, fresh);
          return Promise.resolve(fresh);
        }
      },
      emit: {
        worktreeChanged: (id) => emitted.push(`wt:${id}`),
        graphChanged: (id) => emitted.push(`graph:${id}`),
        repoChanged: (id) => emitted.push(`repo:${id}`)
      },
      isFocused: () => focused,
      now: () => clock,
      fingerprint: (repoPath) => stamps.get(repoPath) ?? "0"
    });
  });

  it("re-reads nothing that is fresh, and a visible row once it is stale", async () => {
    addRepo("p", "a", ["a1"]);
    refresher.report(1, ["a1"]);

    await refresher.tick();
    expect(computed).toEqual([]);

    clock += VISIBLE_STALE_MS;
    await refresher.tick();
    expect(computed).toEqual(["a1"]);
  });

  // The selected worktree's own poll re-reads it too; that fresh snapshot
  // must count, or the row is read twice per stale window.
  it("counts a snapshot another refresher just took", async () => {
    addRepo("p", "a", ["a1"]);
    refresher.report(1, ["a1"]);
    clock += VISIBLE_STALE_MS;
    await refresher.tick();
    expect(computed).toEqual(["a1"]);

    clock += VISIBLE_STALE_MS - 1_000;
    cache.set("a1", state("a1", 0, clock));
    clock += 1_000;
    await refresher.tick();
    expect(computed).toEqual(["a1"]);
  });

  it("waits longer while no PwrGit window is focused", async () => {
    addRepo("p", "a", ["a1"]);
    refresher.report(1, ["a1"]);
    focused = false;

    clock += VISIBLE_STALE_MS;
    await refresher.tick();
    expect(computed).toEqual([]);

    clock += VISIBLE_STALE_MS * (UNFOCUSED_STALE_FACTOR - 1);
    await refresher.tick();
    expect(computed).toEqual(["a1"]);
  });

  // An agent's fetch rewrites FETCH_HEAD; that repository is due at once,
  // not at the end of its stale window.
  it("re-reads a repository at once when its refs fingerprint moves", async () => {
    addRepo("p", "a", ["a1"]);
    addRepo("p", "b", ["b1"]);
    refresher.report(1, ["a1", "b1"]);
    await refresher.tick();

    stamps.set("/r/a", "fetched");
    clock += 1_000;
    await refresher.tick();
    expect(computed).toEqual(["a1"]);
  });

  it("reads no rows nobody is showing, and forgets a closed window's", async () => {
    addRepo("p", "a", ["a1", "a2"]);
    refresher.report(1, ["a1"]);
    clock += VISIBLE_STALE_MS;
    await refresher.tick();
    expect(computed).toEqual(["a1"]);

    refresher.releaseWebContents(1);
    clock += VISIBLE_STALE_MS;
    await refresher.tick();
    expect(computed).toEqual(["a1"]);
  });

  it("caps a round at one batch, oldest first, and converges over rounds", async () => {
    const ids = Array.from({ length: VISIBLE_BATCH + 3 }, (_, i) => `w${i}`);
    addRepo("p", "a", ids);
    // The last three were read longest ago.
    for (const [i, id] of ids.entries()) {
      cache.set(id, state(id, 0, clock - i * 10));
    }
    refresher.report(1, ids);
    clock += VISIBLE_STALE_MS;

    await refresher.tick();
    expect(computed).toHaveLength(VISIBLE_BATCH);
    expect(computed.slice(0, 3)).toEqual(ids.slice(-3).reverse());

    await refresher.tick();
    expect(new Set(computed)).toEqual(new Set(ids));
  });

  // A batch of eight changed rows is one sidebar reload per profile and one
  // graph invalidation per repository, not eight of each.
  it("emits once per repository and per profile for a whole round", async () => {
    addRepo("p", "a", ["a1", "a2"]);
    addRepo("q", "b", ["b1"]);
    refresher.report(1, ["a1", "a2"]);
    refresher.report(2, ["b1"]);
    behindNext.set("a1", 3);
    behindNext.set("a2", 1);
    behindNext.set("b1", 7);
    clock += VISIBLE_STALE_MS;

    await refresher.tick();
    expect(emitted.filter((e) => e.startsWith("wt:")).sort()).toEqual([
      "wt:a1",
      "wt:a2",
      "wt:b1"
    ]);
    expect(emitted.filter((e) => e.startsWith("graph:")).sort()).toEqual([
      "graph:a",
      "graph:b"
    ]);
    expect(emitted.filter((e) => e.startsWith("repo:")).sort()).toEqual([
      "repo:p",
      "repo:q"
    ]);
  });

  it("emits nothing when a re-read finds nothing new", async () => {
    addRepo("p", "a", ["a1"]);
    refresher.report(1, ["a1"]);
    clock += VISIBLE_STALE_MS;
    await refresher.tick();
    expect(computed).toEqual(["a1"]);
    expect(emitted).toEqual([]);
  });

  it("never overlaps rounds", async () => {
    addRepo("p", "a", ["a1"]);
    refresher.report(1, ["a1"]);
    clock += VISIBLE_STALE_MS;
    const first = refresher.tick();
    expect(refresher.tick()).toBe(first);
    await first;
    expect(computed).toEqual(["a1"]);
  });
});

describe("refsFingerprint", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pwrgit-refsfp-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("moves when a fetch rewrites FETCH_HEAD, and reads a linked worktree's gitdir", () => {
    const repo = join(root, "repo");
    const gitDir = join(repo, ".git");
    mkdirSync(join(gitDir, "logs"), { recursive: true });
    writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/main\n");

    const linked = join(root, "linked");
    const linkedGitDir = join(gitDir, "worktrees", "linked");
    mkdirSync(linked, { recursive: true });
    mkdirSync(linkedGitDir, { recursive: true });
    writeFileSync(join(linked, ".git"), `gitdir: ${linkedGitDir}\n`);
    writeFileSync(join(linkedGitDir, "commondir"), "../..\n");
    writeFileSync(join(linkedGitDir, "HEAD"), "ref: refs/heads/feat\n");
    expect(checkoutGitDir(linked)).toBe(linkedGitDir);

    const before = refsFingerprint(repo, [repo, linked]);
    expect(refsFingerprint(repo, [repo, linked])).toBe(before);

    writeFileSync(join(gitDir, "FETCH_HEAD"), "abc\t\tbranch 'main'\n");
    const fetched = refsFingerprint(repo, [repo, linked]);
    expect(fetched).not.toBe(before);

    writeFileSync(join(linkedGitDir, "HEAD"), "ref: refs/heads/other-branch\n");
    expect(refsFingerprint(repo, [repo, linked])).not.toBe(fetched);
  });
});
