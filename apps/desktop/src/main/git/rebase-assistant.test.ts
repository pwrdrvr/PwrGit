import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { err, ok, type RebaseCommitRef, type Result } from "@pwrgit/shared";
import type { GitExec, GitOutput } from "./dugite";
import { applyRebase, planRebase, validateSelection } from "./rebase-assistant";

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

function topCommits(repo: string, n: number): RebaseCommitRef[] {
  return gitOut(repo, ["log", "-n", String(n), "--format=%H%x1f%s"])
    .split("\n")
    .filter((l) => l.length > 0)
    .map((line) => {
      const [hash = "", subject = ""] = line.split("\x1f");
      return { hash, subject };
    });
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

  it("reorder: all picks, oldest-first", () => {
    const plan = planRebase(commits, "reorder");
    expect(plan.steps.map((s) => s.subject)).toEqual([
      "first",
      "second",
      "third"
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
});
