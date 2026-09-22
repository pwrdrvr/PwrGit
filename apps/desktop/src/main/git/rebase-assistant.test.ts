import { execFileSync } from "node:child_process";
import { timedGitSync } from "./test-support/git-tripwire";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type RebaseCommitRef } from "@pwrgit/shared";
import type { GitExec } from "./dugite";
import {
  applyRebase,
  dryRunRebase,
  planRebase,
  validateSelection
} from "./rebase-assistant";
import { createSystemGit } from "./test-support/system-git";

const systemGit = createSystemGit();

function git(dir: string, args: string[]): void {
  timedGitSync(args, dir, () => execFileSync("git", args, { cwd: dir, stdio: "ignore" }));
}
function gitOut(dir: string, args: string[]): string {
  return timedGitSync(args, dir, () => execFileSync("git", args, { cwd: dir, encoding: "utf8" })).trim();
}

/** Repo with four commits c0..c3, each touching a distinct file. */
function makeRepo(): string {
  const dir = join(mkdtempSync(join(tmpdir(), "pwrgit-rebase-")), "repo");
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "orig@x.com"]);
  git(dir, ["config", "user.name", "Orig"]);
  for (const f of ["c0", "c1", "c2", "c3"]) {
    writeFileSync(join(dir, `${f}.txt`), `${f}\n`);
    git(dir, ["add", "."]);
    git(dir, ["commit", "-m", f]);
  }
  return dir;
}

/** Sequential edits that conflict when their two commits are reversed. */
function makeConflictingRepo(): string {
  const dir = join(mkdtempSync(join(tmpdir(), "pwrgit-rebase-conflict-")), "repo");
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "orig@x.com"]);
  git(dir, ["config", "user.name", "Orig"]);
  for (const [subject, contents] of [
    ["base", "alpha\n"],
    ["middle", "bravo\n"],
    ["top", "charlie\n"]
  ]) {
    writeFileSync(join(dir, "shared.txt"), contents);
    git(dir, ["add", "shared.txt"]);
    git(dir, ["commit", "-m", subject]);
  }
  return dir;
}

/**
 * The selected commits reorder cleanly under a normal text merge. A local
 * merge-driver override exists only in the source checkout, so an isolated
 * check can approve the plan while Apply fails after starting cherry-pick.
 */
function makeApplyOnlyConflictRepo(): string {
  const dir = join(
    mkdtempSync(join(tmpdir(), "pwrgit-rebase-apply-conflict-")),
    "repo"
  );
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "core.autocrlf", "false"]);
  git(dir, ["config", "user.email", "orig@x.com"]);
  git(dir, ["config", "user.name", "Orig"]);
  writeFileSync(join(dir, ".gitattributes"), "shared.txt merge=reject\n");
  writeFileSync(
    join(dir, "shared.txt"),
    "header\nfirst: baseline\nkeep a\nkeep b\nkeep c\nkeep d\nkeep e\nkeep f\nsecond: baseline\nfooter\n"
  );
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "base"]);
  writeFileSync(
    join(dir, "shared.txt"),
    "header\nfirst: local one\nkeep a\nkeep b\nkeep c\nkeep d\nkeep e\nkeep f\nsecond: baseline\nfooter\n"
  );
  git(dir, ["add", "shared.txt"]);
  git(dir, ["commit", "-m", "change first setting"]);
  writeFileSync(
    join(dir, "shared.txt"),
    "header\nfirst: local one\nkeep a\nkeep b\nkeep c\nkeep d\nkeep e\nkeep f\nsecond: local two\nfooter\n"
  );
  git(dir, ["add", "shared.txt"]);
  git(dir, ["commit", "-m", "change second setting"]);
  git(dir, ["config", "merge.reject.driver", "false"]);
  return dir;
}

/**
 * Like makeConflictingRepo, but `merge=union` resolves every conflict by
 * keeping both sides. Reversing the top two commits then replays "cleanly"
 * and lands on different content — the case the tree check exists for.
 */
function makeUnionRepo(): string {
  const dir = join(mkdtempSync(join(tmpdir(), "pwrgit-rebase-union-")), "repo");
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "core.autocrlf", "false"]);
  git(dir, ["config", "user.email", "orig@x.com"]);
  git(dir, ["config", "user.name", "Orig"]);
  writeFileSync(join(dir, ".gitattributes"), "shared.txt merge=union\n");
  for (const [subject, contents] of [
    ["base", "alpha\n"],
    ["middle", "bravo\n"],
    ["top", "charlie\n"]
  ]) {
    writeFileSync(join(dir, "shared.txt"), contents);
    git(dir, ["add", "."]);
    git(dir, ["commit", "-m", subject]);
  }
  return dir;
}

function topCommits(repo: string, n: number): RebaseCommitRef[] {
  return gitOut(repo, ["log", "-n", String(n), "--format=%H%x1f%s"])
    .split("\n")
    .filter((l) => l.length > 0)
    .map((line) => {
      const [hash = "", subject = ""] = line.split("\x1f");
      return { hash, subject };
    });
}

function sourceSnapshot(repo: string): {
  head: string;
  status: string;
  refs: string;
  files: Record<string, string>;
} {
  return {
    head: gitOut(repo, ["rev-parse", "HEAD"]),
    status: gitOut(repo, ["status", "--porcelain"]),
    refs: gitOut(repo, ["show-ref"]),
    files: Object.fromEntries(
      readdirSync(repo)
        .filter((name) => name.endsWith(".txt"))
        .map((name) => [name, readFileSync(join(repo, name), "utf8")])
    )
  };
}

describe("planRebase", () => {
  const commits: RebaseCommitRef[] = [
    { hash: "cccccccc", subject: "third" },
    { hash: "bbbbbbbb", subject: "second" },
    { hash: "aaaaaaaa", subject: "first" }
  ];

  it("squash: pick oldest, squash the rest", () => {
    const plan = planRebase(commits, "squash");
    expect(plan.valid).toBe(true);
    expect(plan.steps.map((s) => s.action)).toEqual(["pick", "squash", "squash"]);
    expect(plan.steps[0]?.subject).toBe("first");
  });

  it("reorder: all picks in the exact newest-first execution order", () => {
    const plan = planRebase(commits, "reorder");
    expect(plan.steps.map((s) => s.subject)).toEqual([
      "third",
      "second",
      "first"
    ]);
  });

  it("needs at least two commits", () => {
    expect(planRebase([commits[0] as RebaseCommitRef], "squash").valid).toBe(
      false
    );
  });
});

describe("applyRebase (system git)", () => {
  it("squash reduces the top run to one commit under the identity", async () => {
    const repo = makeRepo();
    const commits = topCommits(repo, 3); // c3, c2, c1 (excludes initial c0)
    const r = await applyRebase(systemGit, repo, commits, "squash", {
      email: "me@acme.io",
      name: "Me"
    });
    expect(r.ok).toBe(true);
    expect(gitOut(repo, ["rev-list", "--count", "HEAD"])).toBe("2");
    const msg = gitOut(repo, ["log", "-1", "--format=%B"]);
    expect(msg).toContain("c1");
    expect(msg).toContain("c3");
    expect(gitOut(repo, ["log", "-1", "--format=%ae"])).toBe("me@acme.io");
  });

  it("squash writes the message the program carries", async () => {
    const repo = makeRepo();
    const commits = topCommits(repo, 3);
    const r = await applyRebase(
      systemGit,
      repo,
      commits,
      "squash",
      { email: "me@acme.io", name: "Me" },
      undefined,
      {
        commits: [
          {
            members: [...commits].reverse().map((c) => c.hash),
            message: "feat: one change\r\n\nWhy it matters.\n\n"
          }
        ]
      }
    );
    expect(r.ok).toBe(true);
    expect(gitOut(repo, ["log", "-1", "--format=%B"])).toBe(
      "feat: one change\n\nWhy it matters."
    );
  });

  it("tidy regroups, keeps a replayed commit's author, and leaves the tree alone", async () => {
    const repo = makeRepo();
    const tree = gitOut(repo, ["rev-parse", "HEAD^{tree}"]);
    const [c3, c2, c1] = topCommits(repo, 3);
    const r = await applyRebase(
      systemGit,
      repo,
      [c3!, c2!, c1!],
      "tidy",
      { email: "me@acme.io", name: "Me" },
      undefined,
      {
        commits: [
          { members: [c1!.hash, c3!.hash], message: "feat: c1 and c3" },
          { members: [c2!.hash], message: null }
        ]
      }
    );
    expect(r.ok).toBe(true);
    expect(gitOut(repo, ["log", "-3", "--format=%s|%ae"]).split("\n")).toEqual([
      "c2|orig@x.com",
      "feat: c1 and c3|me@acme.io",
      "c0|orig@x.com"
    ]);
    expect(gitOut(repo, ["rev-parse", "HEAD^{tree}"])).toBe(tree);
  });

  it("tidy refuses a program that drops a selected commit, before touching Git", async () => {
    const repo = makeRepo();
    const before = sourceSnapshot(repo);
    const [c3, c2, c1] = topCommits(repo, 3);
    const r = await applyRebase(
      systemGit,
      repo,
      [c3!, c2!, c1!],
      "tidy",
      { email: "me@acme.io" },
      undefined,
      { commits: [{ members: [c1!.hash, c2!.hash], message: "lost c3" }] }
    );
    expect(!r.ok && r.error.code).toBe("missing_commit");
    expect(sourceSnapshot(repo)).toEqual(before);
  });

  it("reorder reverses the top run without losing commits", async () => {
    const repo = makeRepo();
    expect(gitOut(repo, ["log", "-1", "--format=%s"])).toBe("c3");
    const commits = topCommits(repo, 3);
    const r = await applyRebase(systemGit, repo, commits, "reorder", {
      email: "me@acme.io"
    });
    expect(r.ok).toBe(true);
    expect(gitOut(repo, ["log", "-1", "--format=%s"])).toBe("c1");
    expect(gitOut(repo, ["rev-list", "--count", "HEAD"])).toBe("4");
  });

  it("aborts a started cherry-pick and restores every visible source outcome", async () => {
    const repo = makeApplyOnlyConflictRepo();
    const globalConfigDir = mkdtempSync(
      join(tmpdir(), "pwrgit-rebase-global-config-")
    );
    const globalConfig = join(globalConfigDir, "gitconfig");
    writeFileSync(
      globalConfig,
      '[merge "reject"]\n\tname = Normal text merge in isolated copies\n\tdriver = git merge-file %A %O %B\n'
    );
    const configuredGit = createSystemGit({
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: globalConfig,
        GIT_CONFIG_SYSTEM: "/dev/null"
      }
    });
    const commits = topCommits(repo, 2);
    const before = sourceSnapshot(repo);

    const checked = await dryRunRebase(
      configuredGit,
      repo,
      commits,
      "reorder",
      { email: "me@acme.io", name: "Me" }
    );
    expect(checked.ok).toBe(true);
    expect(sourceSnapshot(repo)).toEqual(before);
    if (!checked.ok) return;

    const applied = await applyRebase(
      configuredGit,
      repo,
      commits,
      "reorder",
      { email: "me@acme.io", name: "Me" },
      {
        head: checked.value.sourceHead,
        headRef: checked.value.sourceRef
      }
    );

    expect(applied.ok).toBe(false);
    if (!applied.ok) {
      expect(applied.error.code).toBe("conflict");
      expect(applied.error.message).toContain("restored unchanged");
    }
    expect(sourceSnapshot(repo)).toEqual(before);
    expect(existsSync(join(repo, ".git", "CHERRY_PICK_HEAD"))).toBe(false);
  });

  it("refuses when the worktree is dirty", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "dirty.txt"), "x\n");
    const r = await applyRebase(systemGit, repo, topCommits(repo, 3), "squash", {
      email: "me@acme.io"
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("dirty");
  });

  it("validateSelection rejects a non-top selection", async () => {
    const repo = makeRepo();
    const all = topCommits(repo, 4); // c3, c2, c1, c0
    const notTop = [all[1], all[2]] as RebaseCommitRef[]; // c2, c1 (excludes HEAD)
    const v = await validateSelection(systemGit, repo, notTop);
    expect(v.ok).toBe(false);
  });

  it("refuses an apply when HEAD no longer matches the checked HEAD", async () => {
    const repo = makeRepo();
    const commits = topCommits(repo, 3);
    const before = sourceSnapshot(repo);
    const r = await applyRebase(
      systemGit,
      repo,
      commits,
      "squash",
      { email: "me@acme.io", name: "Me" },
      {
        head: "0000000000000000000000000000000000000000",
        headRef: "refs/heads/main"
      }
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("dry_run_stale");
    expect(sourceSnapshot(repo)).toEqual(before);
  });

  it("refuses an approval after switching to a different branch at the same HEAD", async () => {
    const repo = makeRepo();
    const commits = topCommits(repo, 3);
    const checkedHead = gitOut(repo, ["rev-parse", "HEAD"]);
    git(repo, ["branch", "same-tip"]);
    git(repo, ["switch", "same-tip"]);
    const before = sourceSnapshot(repo);

    const result = await applyRebase(
      systemGit,
      repo,
      commits,
      "squash",
      { email: "me@acme.io", name: "Me" },
      { head: checkedHead, headRef: "refs/heads/main" }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("dry_run_stale");
    expect(gitOut(repo, ["symbolic-ref", "HEAD"])).toBe(
      "refs/heads/same-tip"
    );
    expect(sourceSnapshot(repo)).toEqual(before);
  });
});

describe("dryRunRebase (disposable clone)", () => {
  for (const op of ["squash", "reorder"] as const) {
    it(`reports a clean ${op} without changing the source`, async () => {
      const repo = makeRepo();
      const commits = topCommits(repo, 3);
      const before = sourceSnapshot(repo);
      const tempParent = mkdtempSync(join(tmpdir(), "pwrgit-rebase-test-temp-"));

      const result = await dryRunRebase(
        systemGit,
        repo,
        commits,
        op,
        { email: "me@acme.io", name: "Me" },
        { tempParent }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual({
          sourceHead: before.head,
          sourceRef: "refs/heads/main",
          proof: {
            commitCount: 3,
            resultCount: op === "squash" ? 1 : 3,
            steps: 3,
            tree: gitOut(repo, ["rev-parse", "HEAD^{tree}"]),
            durationMs: expect.any(Number)
          }
        });
      }
      expect(sourceSnapshot(repo)).toEqual(before);
      expect(readdirSync(tempParent)).toEqual([]);
    });
  }

  it("reports a conflicting reorder and still leaves no source or temp changes", async () => {
    const repo = makeConflictingRepo();
    const before = sourceSnapshot(repo);
    const tempParent = mkdtempSync(join(tmpdir(), "pwrgit-rebase-test-temp-"));

    const result = await dryRunRebase(
      systemGit,
      repo,
      topCommits(repo, 2),
      "reorder",
      { email: "me@acme.io", name: "Me" },
      { tempParent }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("conflict");
      expect(result.error.message).toContain("worktree was not changed");
      // What a Tidy revision is told: which step, which commit, which files.
      expect(result.error.snag).toEqual({
        kind: "conflict",
        step: 1,
        total: 2,
        hash: topCommits(repo, 1)[0]?.hash,
        subject: "top",
        files: ["shared.txt"]
      });
    }
    expect(sourceSnapshot(repo)).toEqual(before);
    expect(readdirSync(tempParent)).toEqual([]);
  });

  it("discards a replay that finishes cleanly with different code", async () => {
    const repo = makeUnionRepo();
    const before = sourceSnapshot(repo);
    const tempParent = mkdtempSync(join(tmpdir(), "pwrgit-rebase-test-temp-"));

    const result = await dryRunRebase(
      systemGit,
      repo,
      topCommits(repo, 2),
      "reorder",
      { email: "me@acme.io", name: "Me" },
      { tempParent }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("tree_changed");
      expect(result.error.message).toContain("can't be applied");
      expect(result.error.snag).toEqual({
        kind: "tree_changed",
        files: [expect.objectContaining({ path: "shared.txt" })]
      });
    }
    expect(sourceSnapshot(repo)).toEqual(before);
    expect(readdirSync(tempParent)).toEqual([]);
  });

  it("proves a Tidy program in the isolated copy", async () => {
    const repo = makeRepo();
    const [c3, c2, c1] = topCommits(repo, 3);
    const result = await dryRunRebase(
      systemGit,
      repo,
      [c3!, c2!, c1!],
      "tidy",
      { email: "me@acme.io", name: "Me" },
      {
        program: {
          commits: [
            { members: [c1!.hash, c3!.hash], message: "feat: c1 and c3" },
            { members: [c2!.hash], message: null }
          ]
        }
      }
    );
    expect(result.ok && result.value.proof).toEqual(
      expect.objectContaining({ commitCount: 3, resultCount: 2, steps: 3 })
    );
  });

  it("fetches only the checked ref through the selected commits and base", async () => {
    const repo = makeRepo();
    git(repo, ["switch", "-c", "unrelated"]);
    writeFileSync(join(repo, "unrelated.txt"), "unrelated branch content\n");
    git(repo, ["add", "unrelated.txt"]);
    git(repo, ["commit", "-m", "unrelated history"]);
    git(repo, ["tag", "unrelated-tag"]);
    git(repo, ["switch", "main"]);
    const calls: string[][] = [];
    const recordingGit: GitExec = async (args, cwd) => {
      calls.push(args);
      return systemGit(args, cwd);
    };

    const result = await dryRunRebase(
      recordingGit,
      repo,
      topCommits(repo, 3),
      "squash",
      { email: "me@acme.io", name: "Me" }
    );

    expect(result.ok).toBe(true);
    expect(calls.some((args) => args.includes("clone"))).toBe(false);
    const fetch = calls.find((args) => args[0] === "fetch");
    expect(fetch).toEqual([
      "fetch",
      "--no-tags",
      "--no-recurse-submodules",
      "--depth=4",
      "--",
      repo,
      "refs/heads/main"
    ]);
  });

  it("uses the same no-hooks and no-signing policy for check and apply", async () => {
    const repo = makeRepo();
    const hook = join(repo, ".git", "hooks", "commit-msg");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n");
    chmodSync(hook, 0o755);
    git(repo, ["config", "commit.gpgSign", "true"]);
    git(repo, ["config", "user.signingKey", "missing-test-key"]);
    const commits = topCommits(repo, 3);

    const checked = await dryRunRebase(
      systemGit,
      repo,
      commits,
      "squash",
      { email: "me@acme.io", name: "Me" }
    );
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;

    const applied = await applyRebase(
      systemGit,
      repo,
      commits,
      "squash",
      { email: "me@acme.io", name: "Me" },
      {
        head: checked.value.sourceHead,
        headRef: checked.value.sourceRef
      }
    );

    expect(applied.ok).toBe(true);
    expect(gitOut(repo, ["rev-list", "--count", "HEAD"])).toBe("2");
  });
});
