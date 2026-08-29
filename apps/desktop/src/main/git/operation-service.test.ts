import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { err, ok } from "@pwrgit/shared";
import type { GitExec } from "./dugite";
import {
  abortOperation,
  continueOperation,
  countUnmergedPaths,
  detectOperation,
  hasConflictMarkers,
  MARKER_SCAN_SIZE_LIMIT,
  readOperationState,
  scanConflictMarkers
} from "./operation-service";

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "Tester",
  GIT_AUTHOR_EMAIL: "t@t.com",
  GIT_COMMITTER_NAME: "Tester",
  GIT_COMMITTER_EMAIL: "t@t.com"
};

/** The service takes GitExec by injection, so point it straight at system git. */
function makeExecGit(base: NodeJS.ProcessEnv = GIT_ENV): GitExec {
  return (args, cwd, options) =>
  new Promise((resolve) => {
    const proc = spawn("git", args, {
      cwd,
      env: { ...base, ...(options?.env ?? {}) }
    });
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
  });
}

const execGit = makeExecGit();

/**
 * GIT_AUTHOR_* / GIT_COMMITTER_* outrank `-c user.email`, so identity has to
 * be proven with those unset — which is also how the app really runs.
 */
const execGitWithoutIdentityEnv = makeExecGit({
  ...GIT_ENV,
  GIT_AUTHOR_NAME: undefined,
  GIT_AUTHOR_EMAIL: undefined,
  GIT_COMMITTER_NAME: undefined,
  GIT_COMMITTER_EMAIL: undefined
});

/** Non-zero exits are expected throughout (a conflict is a failed command). */
function git(dir: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  try {
    return execFileSync("git", args, {
      cwd: dir,
      env: { ...GIT_ENV, ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
  } catch {
    return "";
  }
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pwrgit-op-"));
  git(dir, ["init", "-q", "-b", "main", "."]);
  // Windows CI defaults core.autocrlf on; these tests compare file contents.
  git(dir, ["config", "core.autocrlf", "false"]);
  return dir;
}

function write(dir: string, file: string, text: string): void {
  writeFileSync(join(dir, file), text);
}

function commit(dir: string, file: string, text: string, message: string): void {
  write(dir, file, text);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", message]);
}

function head(dir: string): string {
  return git(dir, ["rev-parse", "HEAD"]).trim();
}

function gitDir(dir: string): string {
  return git(dir, ["rev-parse", "--absolute-git-dir"]).trim();
}

/** main and topic each change `file`, so merging or rebasing them conflicts. */
function diverged(dir: string, file = "a.txt"): void {
  commit(dir, file, "base\n", "base");
  git(dir, ["checkout", "-qb", "topic"]);
  commit(dir, file, "topic\n", "topic change");
  git(dir, ["checkout", "-q", "main"]);
  commit(dir, file, "main\n", "main change");
}

describe("operation detection (real Git)", () => {
  it("reports no operation in a clean repository", async () => {
    const dir = repo();
    commit(dir, "a.txt", "a\n", "one");

    const state = await readOperationState(execGit, dir);

    expect(state.ok && state.value).toEqual({
      operation: null,
      conflictCount: 0
    });
  });

  it("detects a conflicted merge and counts the unmerged path", async () => {
    const dir = repo();
    diverged(dir);
    git(dir, ["merge", "topic"]);

    const state = await readOperationState(execGit, dir);

    expect(state.ok && state.value.operation?.kind).toBe("merge");
    expect(state.ok && state.value.conflictCount).toBe(1);
  });

  /**
   * The state that made the previous attempt at this feature hide the whole
   * rail: an operation is genuinely in progress with nothing to resolve.
   */
  it("detects `merge --no-commit` as an operation with zero conflicts", async () => {
    const dir = repo();
    commit(dir, "a.txt", "a\n", "base");
    git(dir, ["checkout", "-qb", "topic"]);
    commit(dir, "b.txt", "b\n", "theirs");
    git(dir, ["checkout", "-q", "main"]);
    commit(dir, "c.txt", "c\n", "ours");
    git(dir, ["merge", "--no-commit", "--no-ff", "topic"]);

    const state = await readOperationState(execGit, dir);

    expect(state.ok && state.value.operation?.kind).toBe("merge");
    expect(state.ok && state.value.conflictCount).toBe(0);
  });

  it("detects a conflicted rebase with its step counters", async () => {
    const dir = repo();
    diverged(dir);
    git(dir, ["checkout", "-q", "topic"]);
    git(dir, ["rebase", "main"]);

    const state = await readOperationState(execGit, dir);

    expect(state.ok && state.value.operation?.kind).toBe("rebase");
    expect(state.ok && state.value.operation?.progress).toEqual({
      current: 1,
      total: 1
    });
    expect(state.ok && state.value.conflictCount).toBe(1);
  });

  /** A rebase paused on `edit` has no conflicts and still needs --continue. */
  it("detects an interactive rebase paused on an edit step", async () => {
    const dir = repo();
    commit(dir, "a.txt", "1\n", "one");
    commit(dir, "a.txt", "2\n", "two");
    commit(dir, "b.txt", "3\n", "three");
    git(dir, ["rebase", "-i", "HEAD~2"], {
      GIT_SEQUENCE_EDITOR: "sed -i.bak 1s/^pick/edit/"
    });

    const state = await readOperationState(execGit, dir);

    expect(state.ok && state.value.operation?.kind).toBe("rebase");
    expect(state.ok && state.value.conflictCount).toBe(0);
  });

  it("detects a conflicted cherry-pick rather than a merge", async () => {
    const dir = repo();
    diverged(dir);
    git(dir, ["cherry-pick", "topic"]);

    const state = await readOperationState(execGit, dir);

    expect(state.ok && state.value.operation?.kind).toBe("cherry-pick");
    expect(state.ok && state.value.conflictCount).toBe(1);
  });

  it("detects a conflicted revert rather than a merge", async () => {
    const dir = repo();
    commit(dir, "a.txt", "base\n", "base");
    commit(dir, "a.txt", "second\n", "second");
    commit(dir, "a.txt", "third\n", "third");
    git(dir, ["revert", "--no-edit", "HEAD~1"]);

    const state = await readOperationState(execGit, dir);

    expect(state.ok && state.value.operation?.kind).toBe("revert");
  });

  it("distinguishes `git am` from a rebase sharing rebase-apply/", async () => {
    const dir = repo();
    commit(dir, "a.txt", "base\n", "base");
    git(dir, ["checkout", "-qb", "topic"]);
    commit(dir, "a.txt", "topic\n", "topic change");
    const patch = join(dir, "patch.mbox");
    writeFileSync(patch, git(dir, ["format-patch", "--stdout", "main"]));
    git(dir, ["checkout", "-q", "main"]);
    commit(dir, "a.txt", "main\n", "main change");
    git(dir, ["am", "--3way", patch]);

    const state = await readOperationState(execGit, dir);

    expect(state.ok && state.value.operation?.kind).toBe("am");
  });

  it("returns null for a git directory with no operation markers", () => {
    const dir = repo();
    commit(dir, "a.txt", "a\n", "one");

    expect(detectOperation(gitDir(dir))).toBeNull();
  });
});

describe("continue classification", () => {
  /**
   * The regression this feature exists to avoid. `git rebase --continue` exits
   * non-zero when it applies one step and then stops on the *next* conflict,
   * so an exit-code-only reading calls an ordinary multi-commit rebase a
   * failure.
   */
  it("reports a rebase that advances and stops again as progress, not failure", async () => {
    const dir = repo();
    commit(dir, "a.txt", "1\n", "base a");
    commit(dir, "b.txt", "1\n", "base b");
    git(dir, ["checkout", "-qb", "topic"]);
    commit(dir, "a.txt", "topicA\n", "topic a");
    commit(dir, "b.txt", "topicB\n", "topic b");
    git(dir, ["checkout", "-q", "main"]);
    commit(dir, "a.txt", "mainA\n", "main a");
    commit(dir, "b.txt", "mainB\n", "main b");
    git(dir, ["checkout", "-q", "topic"]);
    git(dir, ["rebase", "main"]);

    // Resolve only the first of the two conflicting steps.
    write(dir, "a.txt", "resolvedA\n");
    git(dir, ["add", "a.txt"]);
    const before = head(dir);

    const result = await continueOperation(execGit, dir, "rebase");

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.kind).toBe("stopped");
    if (result.ok && result.value.kind === "stopped") {
      expect(result.value.state.operation?.kind).toBe("rebase");
      expect(result.value.state.conflictCount).toBe(1);
      expect(result.value.detail).toContain("1 conflicted path");
      expect(result.value.detail).toContain("step 2 of 2");
    }
    // The first step really was committed, which is why this is progress.
    expect(head(dir)).not.toBe(before);
  });

  it("reports the final rebase step as completed", async () => {
    const dir = repo();
    diverged(dir);
    git(dir, ["checkout", "-q", "topic"]);
    git(dir, ["rebase", "main"]);
    write(dir, "a.txt", "resolved\n");
    git(dir, ["add", "a.txt"]);

    const result = await continueOperation(execGit, dir, "rebase");

    expect(result.ok && result.value.kind).toBe("completed");
    const state = await readOperationState(execGit, dir);
    expect(state.ok && state.value.operation).toBeNull();
  });

  it("completes a resolved merge and records both parents", async () => {
    const dir = repo();
    diverged(dir);
    git(dir, ["merge", "topic"]);
    write(dir, "a.txt", "resolved\n");
    git(dir, ["add", "a.txt"]);

    const result = await continueOperation(
      execGitWithoutIdentityEnv,
      dir,
      "merge",
      { email: "author@example.com", name: "Author" }
    );

    expect(result.ok && result.value.kind).toBe("completed");
    expect(git(dir, ["rev-list", "--parents", "-n", "1", "HEAD"]).trim().split(" ")).toHaveLength(3);
    expect(git(dir, ["log", "-1", "--format=%ae"]).trim()).toBe(
      "author@example.com"
    );
  });

  it("refuses to continue while a path is still unmerged", async () => {
    const dir = repo();
    diverged(dir);
    git(dir, ["merge", "topic"]);
    const before = head(dir);

    const result = await continueOperation(execGit, dir, "merge");

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("unresolved_conflicts");
    expect(!result.ok && result.error.message).toContain("1 path is");
    // Nothing was attempted, so Git is exactly where it was.
    expect(head(dir)).toBe(before);
  });

  it("refuses to continue an operation the caller did not observe", async () => {
    const dir = repo();
    diverged(dir);
    git(dir, ["merge", "topic"]);
    write(dir, "a.txt", "resolved\n");
    git(dir, ["add", "a.txt"]);

    const result = await continueOperation(execGit, dir, "rebase");

    expect(!result.ok && result.error.code).toBe("operation_changed");
    // The merge is untouched and still resumable.
    const state = await readOperationState(execGit, dir);
    expect(state.ok && state.value.operation?.kind).toBe("merge");
  });

  it("refuses to continue when nothing is in progress", async () => {
    const dir = repo();
    commit(dir, "a.txt", "a\n", "one");

    const result = await continueOperation(execGit, dir, "merge");

    expect(!result.ok && result.error.code).toBe("operation_gone");
  });

  /** Nothing moved: HEAD, the counter, and the conflict count all held. */
  it("reports a genuine failure when a hook blocks the commit", async () => {
    const dir = repo();
    diverged(dir);
    git(dir, ["merge", "topic"]);
    write(dir, "a.txt", "resolved\n");
    git(dir, ["add", "a.txt"]);
    const hook = join(gitDir(dir), "hooks", "pre-commit");
    mkdirSync(join(gitDir(dir), "hooks"), { recursive: true });
    writeFileSync(hook, "#!/bin/sh\necho refused by hook >&2\nexit 1\n");
    chmodSync(hook, 0o755);
    const before = head(dir);

    const result = await continueOperation(execGit, dir, "merge");

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("continue_failed");
    expect(head(dir)).toBe(before);
  });
});

describe("abort", () => {
  it("restores the pre-merge head and keeps an unrelated edit", async () => {
    const dir = repo();
    commit(dir, "unrelated.txt", "keep\n", "unrelated");
    diverged(dir);
    const before = head(dir);
    git(dir, ["merge", "topic"]);
    write(dir, "unrelated.txt", "locally edited\n");

    const result = await abortOperation(execGit, dir, "merge");

    expect(result.ok).toBe(true);
    expect(head(dir)).toBe(before);
    expect(readFileSync(join(dir, "unrelated.txt"), "utf8")).toBe(
      "locally edited\n"
    );
    const state = await readOperationState(execGit, dir);
    expect(state.ok && state.value).toEqual({
      operation: null,
      conflictCount: 0
    });
  });

  it("restores the pre-rebase branch tip", async () => {
    const dir = repo();
    diverged(dir);
    git(dir, ["checkout", "-q", "topic"]);
    const before = head(dir);
    git(dir, ["rebase", "main"]);

    const result = await abortOperation(execGit, dir, "rebase");

    expect(result.ok).toBe(true);
    expect(head(dir)).toBe(before);
  });

  it("refuses to abort an operation the caller did not observe", async () => {
    const dir = repo();
    diverged(dir);
    git(dir, ["merge", "topic"]);

    const result = await abortOperation(execGit, dir, "cherry-pick");

    expect(!result.ok && result.error.code).toBe("operation_changed");
    const state = await readOperationState(execGit, dir);
    expect(state.ok && state.value.operation?.kind).toBe("merge");
  });
});

describe("unmerged index parsing", () => {
  it("counts each conflicted path once across its three stages", () => {
    const record = (stage: number, path: string): string =>
      `100644 ${"0".repeat(40)} ${stage}\t${path}\0`;
    const stdout =
      record(1, "a.txt") +
      record(2, "a.txt") +
      record(3, "a.txt") +
      record(2, "b.txt");

    expect(countUnmergedPaths(stdout)).toBe(2);
  });

  it("is zero for an empty listing", () => {
    expect(countUnmergedPaths("")).toBe(0);
  });

  it("keeps a path containing a newline intact", () => {
    const stdout = `100644 ${"0".repeat(40)} 2\tweird\nname.txt\0`;

    expect(countUnmergedPaths(stdout)).toBe(1);
  });
});

describe("conflict marker detection", () => {
  it("flags a real conflicted file", () => {
    const text = [
      "before",
      "<<<<<<< HEAD",
      "ours",
      "=======",
      "theirs",
      ">>>>>>> topic",
      "after"
    ].join("\n");

    expect(hasConflictMarkers(text)).toBe(true);
  });

  /** Documentation about merge conflicts must not trip the warning. */
  it("does not flag an opening marker with no closing marker", () => {
    expect(
      hasConflictMarkers("Git writes <<<<<<< HEAD when a merge conflicts.\n")
    ).toBe(false);
    expect(hasConflictMarkers("<<<<<<< HEAD\nours\n=======\n")).toBe(false);
  });

  it("does not flag a closing marker that precedes an opening one", () => {
    expect(hasConflictMarkers(">>>>>>> topic\n<<<<<<< HEAD\n")).toBe(false);
  });

  it("scans only the paths given, and skips binary and missing files", () => {
    const dir = repo();
    write(dir, "conflicted.txt", "<<<<<<< HEAD\na\n=======\nb\n>>>>>>> t\n");
    write(dir, "clean.txt", "resolved\n");
    write(dir, "untouched.txt", "<<<<<<< HEAD\na\n=======\nb\n>>>>>>> t\n");
    writeFileSync(
      join(dir, "binary.bin"),
      Buffer.from([0x00, 0x3c, 0x3c, 0x00])
    );

    const flagged = scanConflictMarkers(dir, [
      "conflicted.txt",
      "clean.txt",
      "binary.bin",
      "missing.txt"
    ]);

    expect(flagged).toEqual(["conflicted.txt"]);
  });

  it("refuses to read outside the worktree", () => {
    const dir = repo();
    const outside = mkdtempSync(join(tmpdir(), "pwrgit-outside-"));
    writeFileSync(
      join(outside, "secret.txt"),
      "<<<<<<< HEAD\na\n=======\nb\n>>>>>>> t\n"
    );

    expect(scanConflictMarkers(dir, ["../secret.txt"])).toEqual([]);
    expect(scanConflictMarkers(dir, [join(outside, "secret.txt")])).toEqual([]);
  });
});

describe("marker scan limits", () => {
  it("skips a symlink rather than following it out of the worktree", () => {
    const dir = repo();
    const outside = mkdtempSync(join(tmpdir(), "pwrgit-outside-"));
    const secret = join(outside, "secret.txt");
    writeFileSync(secret, "<<<<<<< HEAD\na\n=======\nb\n>>>>>>> t\n");
    symlinkSync(secret, join(dir, "link.txt"));

    expect(scanConflictMarkers(dir, ["link.txt"])).toEqual([]);
  });

  it("does not read a file past the per-file size limit", () => {
    const dir = repo();
    const padding = "x\n".repeat(MARKER_SCAN_SIZE_LIMIT / 2 + 8);
    write(dir, "huge.txt", `<<<<<<< HEAD\na\n=======\nb\n>>>>>>> t\n${padding}`);

    expect(scanConflictMarkers(dir, ["huge.txt"])).toEqual([]);
  });
});
