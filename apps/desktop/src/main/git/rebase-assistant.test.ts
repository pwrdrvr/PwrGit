import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { err, ok, type RebaseCommitRef, type Result } from "@pwrgit/shared";
import type { GitExec, GitOutput } from "./dugite";
import {
  applyRebase,
  dryRunRebase,
  planRebase,
  validateSelection
} from "./rebase-assistant";

const systemGit: GitExec = (args, cwd) =>
  new Promise<Result<GitOutput>>((resolve) => {
    const proc = spawn("git", args, { cwd });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    proc.on("close", (code) =>
      resolve(ok({ stdout, stderr, exitCode: code ?? 0 }))
    );
    proc.on("error", (e) =>
      resolve(err({ kind: "git", code: "spawn_failed", message: e.message }))
    );
  });

function git(dir: string, args: string[]): void {
  execFileSync("git", args, { cwd: dir, stdio: "ignore" });
}
function gitOut(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
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

  it("refuses when the worktree is dirty", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "dirty.txt"), "x\n");
    const r = await applyRebase(systemGit, repo, topCommits(repo, 3), "squash", {
      email: "me@acme.io"
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("dirty");
  }, 15_000);

  it("validateSelection rejects a non-top selection", async () => {
    const repo = makeRepo();
    const all = topCommits(repo, 4); // c3, c2, c1, c0
    const notTop = [all[1], all[2]] as RebaseCommitRef[]; // c2, c1 (excludes HEAD)
    const v = await validateSelection(systemGit, repo, notTop);
    expect(v.ok).toBe(false);
  }, 15_000);

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
          sourceRef: "refs/heads/main"
        });
      }
      expect(sourceSnapshot(repo)).toEqual(before);
      expect(readdirSync(tempParent)).toEqual([]);
    }, 15_000);
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
    }
    expect(sourceSnapshot(repo)).toEqual(before);
    expect(readdirSync(tempParent)).toEqual([]);
  }, 15_000);

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
  }, 15_000);

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
  }, 15_000);
});
