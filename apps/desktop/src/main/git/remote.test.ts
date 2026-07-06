import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { err, ok, type Result } from "@pwrgit/shared";
import type { GitExec, GitOutput } from "./dugite";
import { fetchRemote, pullFastForward, pushRemote } from "./git-service";

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
function configure(dir: string, name: string): void {
  git(dir, ["config", "user.email", `${name}@t.com`]);
  git(dir, ["config", "user.name", name]);
}
function commit(dir: string, file: string, msg: string): void {
  writeFileSync(join(dir, file), `${file}\n`);
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", msg]);
}

let cloneA: string;
let cloneB: string;

beforeAll(() => {
  const root = mkdtempSync(join(tmpdir(), "pwrgit-remote-"));
  git(root, ["init", "--bare", "-b", "main", "origin.git"]);

  cloneA = join(root, "A");
  git(root, ["clone", "origin.git", "A"]);
  configure(cloneA, "A");
  commit(cloneA, "f.txt", "c1");
  git(cloneA, ["push", "-u", "origin", "main"]);

  cloneB = join(root, "B");
  git(root, ["clone", "origin.git", "B"]);
  configure(cloneB, "B");
});

describe("remote ops (bare-remote fixture)", () => {
  it("push sends a new commit to the remote", async () => {
    commit(cloneB, "g.txt", "c2 from B");
    const result = await pushRemote(systemGit, cloneB);
    expect(result.ok).toBe(true);
  });

  it("pull fast-forwards a behind branch and advances the tree", async () => {
    const result = await pullFastForward(systemGit, cloneA);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.fastForwarded).toBe(true);
    expect(existsSync(join(cloneA, "g.txt"))).toBe(true);
  });

  it("fetch succeeds when already up to date", async () => {
    const result = await fetchRemote(systemGit, cloneA);
    expect(result.ok).toBe(true);
  });

  it("pull refuses (not_fast_forward) when the branch has diverged", async () => {
    commit(cloneA, "h.txt", "c3 local on A");
    commit(cloneB, "i.txt", "c4 on B");
    git(cloneB, ["push"]);

    const result = await pullFastForward(systemGit, cloneA);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_fast_forward");
  });
});
