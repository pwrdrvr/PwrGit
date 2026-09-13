import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PWRGIT_PULL_STASH_MESSAGE,
  err,
  ok
} from "@pwrgit/shared";
import type { GitExec, GitOutput } from "./dugite";
import {
  applyStash,
  createStash,
  dropStash,
  listStashes,
  parseStashNumstat,
  popStash,
  readStashDetails,
  readStashPatch
} from "./stash-service";

const systemGit: GitExec = (args, cwd, options) =>
  new Promise((resolve) => {
    const proc = spawn("git", args, {
      cwd,
      env: { ...process.env, ...options?.env }
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    proc.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    proc.on("error", (cause) =>
      resolve(err({ kind: "git", code: "spawn_failed", message: cause.message }))
    );
    proc.on("close", (exitCode) =>
      resolve(ok({ stdout, stderr, exitCode: exitCode ?? 1 } satisfies GitOutput))
    );
  });

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

describe("stash service (system git)", () => {
  let root: string;
  let repo: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pwrgit-stashes-"));
    repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.name", "PwrGit Test"]);
    git(repo, ["config", "user.email", "pwrgit@example.com"]);
    git(repo, ["config", "core.autocrlf", "false"]);
    writeFileSync(join(repo, "README.md"), "baseline\n");
    writeFileSync(join(repo, "other.txt"), "other baseline\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "baseline"]);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("lists one shared ordered stack from multiple worktrees with metadata and details", async () => {
    writeFileSync(join(repo, "README.md"), "baseline\nordinary edit\n");
    writeFileSync(join(repo, "new.txt"), "untracked\n");
    await expect(
      createStash(systemGit, repo, "ordinary named work", true)
    ).resolves.toEqual(ok(true));

    const linked = join(root, "linked");
    git(repo, ["worktree", "add", "-b", "feature/recovery", linked]);
    writeFileSync(join(linked, "other.txt"), "recovery edit\n");
    await expect(
      createStash(systemGit, linked, PWRGIT_PULL_STASH_MESSAGE, false)
    ).resolves.toEqual(ok(true));

    const fromPrimary = await listStashes(systemGit, repo);
    const fromLinked = await listStashes(systemGit, linked);
    expect(fromPrimary).toEqual(fromLinked);
    expect(fromPrimary.ok).toBe(true);
    if (!fromPrimary.ok) return;
    expect(fromPrimary.value).toHaveLength(2);
    expect(fromPrimary.value[0]).toMatchObject({
      selector: "stash@{0}",
      branch: "feature/recovery",
      name: PWRGIT_PULL_STASH_MESSAGE,
      kind: "pwrgit-pull-recovery"
    });
    expect(fromPrimary.value[1]).toMatchObject({
      selector: "stash@{1}",
      branch: "main",
      name: "ordinary named work",
      kind: "ordinary"
    });

    const ordinary = fromPrimary.value[1];
    if (ordinary === undefined) throw new Error("missing ordinary stash");
    const details = await readStashDetails(systemGit, linked, ordinary);
    expect(details).toMatchObject({
      ok: true,
      value: {
        additions: 2,
        deletions: 0,
        files: expect.arrayContaining([
          { path: "README.md", additions: 1, deletions: 0 },
          { path: "new.txt", additions: 1, deletions: 0 }
        ])
      }
    });
    const patch = await readStashPatch(systemGit, repo, ordinary.hash);
    expect(patch).toMatchObject({ ok: true });
    if (patch.ok) {
      expect(patch.value).toContain("ordinary edit");
      expect(patch.value).toContain("diff --git a/new.txt b/new.txt");
    }
  });

  it("applies and drops a selected non-top entry without touching the top entry", async () => {
    writeFileSync(join(repo, "README.md"), "first stash\n");
    await createStash(systemGit, repo, "older", false);
    writeFileSync(join(repo, "other.txt"), "second stash\n");
    await createStash(systemGit, repo, "newer", false);
    const before = await listStashes(systemGit, repo);
    if (!before.ok) throw new Error(before.error.message);
    const newerHash = before.value[0]?.hash;
    const older = before.value[1];
    if (newerHash === undefined || older === undefined) {
      throw new Error("expected two stashes");
    }

    await expect(
      applyStash(systemGit, repo, older.selector)
    ).resolves.toEqual(ok(undefined));
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("first stash\n");
    expect((await listStashes(systemGit, repo))).toEqual(before);

    git(repo, ["reset", "--hard", "HEAD"]);
    await expect(
      dropStash(systemGit, repo, older.selector)
    ).resolves.toEqual(ok(undefined));
    const after = await listStashes(systemGit, repo);
    expect(after).toMatchObject({
      ok: true,
      value: [{ selector: "stash@{0}", hash: newerHash }]
    });
  });

  it("marks repeated reflog occurrences of the same stash commit", async () => {
    writeFileSync(join(repo, "README.md"), "repeated stash\n");
    await createStash(systemGit, repo, "original", false);
    const original = await listStashes(systemGit, repo);
    if (!original.ok || original.value[0] === undefined) {
      throw new Error("expected original stash");
    }
    const repeatedHash = original.value[0].hash;

    writeFileSync(join(repo, "other.txt"), "different stash\n");
    await createStash(systemGit, repo, "between", false);
    git(repo, ["stash", "store", "-m", "stored again", repeatedHash]);

    const listed = await listStashes(systemGit, repo);
    expect(listed).toMatchObject({
      ok: true,
      value: [
        { selector: "stash@{0}", hash: repeatedHash, occurrenceCount: 2 },
        { selector: "stash@{1}", occurrenceCount: 1 },
        { selector: "stash@{2}", hash: repeatedHash, occurrenceCount: 2 }
      ]
    });
  });

  it("keeps a PwrGit pull recovery stash when pop conflicts", async () => {
    writeFileSync(join(repo, "README.md"), "stashed side\n");
    await createStash(systemGit, repo, PWRGIT_PULL_STASH_MESSAGE, false);
    writeFileSync(join(repo, "README.md"), "upstream side\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "conflicting upstream"]);

    const listed = await listStashes(systemGit, repo);
    if (!listed.ok || listed.value[0] === undefined) {
      throw new Error("expected recovery stash");
    }
    const popped = await popStash(systemGit, repo, listed.value[0].selector);
    expect(popped.ok).toBe(false);
    expect(git(repo, ["diff", "--name-only", "--diff-filter=U"])).toBe(
      "README.md"
    );
    const kept = await listStashes(systemGit, repo);
    expect(kept).toMatchObject({
      ok: true,
      value: [
        {
          hash: listed.value[0].hash,
          kind: "pwrgit-pull-recovery"
        }
      ]
    });
  });

  it("makes untracked inclusion explicit", async () => {
    const untracked = join(repo, "only-untracked.txt");
    writeFileSync(untracked, "new\n");
    await expect(
      createStash(systemGit, repo, "tracked only", false)
    ).resolves.toEqual(ok(false));
    expect(existsSync(untracked)).toBe(true);
    await expect(
      createStash(systemGit, repo, "include new files", true)
    ).resolves.toEqual(ok(true));
    expect(existsSync(untracked)).toBe(false);
  });
});

describe("parseStashNumstat", () => {
  it("preserves tabs in NUL-delimited paths and marks binary files", () => {
    expect(
      parseStashNumstat("2\t1\tdocs/a\tb.md\0-\t-\timage.png\0")
    ).toEqual([
      { path: "docs/a\tb.md", additions: 2, deletions: 1 },
      { path: "image.png", additions: null, deletions: null }
    ]);
  });
});
