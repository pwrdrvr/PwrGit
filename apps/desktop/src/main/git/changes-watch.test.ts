import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { err, ok } from "@pwrgit/shared";
import { ChangeSetWatch, createChangeSetAnnouncer } from "./changes-watch";
import type { GitExec, GitOutput } from "./dugite";
import { parseStatus } from "./worktree-state";

const systemGit: GitExec = (args, cwd) =>
  new Promise((resolve) => {
    const proc = spawn("git", args, { cwd });
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

describe("ChangeSetWatch (system git)", () => {
  let root: string;
  let repo: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pwrgit-watch-"));
    repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.name", "PwrGit Test"]);
    git(repo, ["config", "user.email", "pwrgit@example.com"]);
    writeFileSync(join(repo, "tracked.txt"), "baseline\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "baseline"]);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const dirty = async (): Promise<number> => {
    const raw = await systemGit(["status", "--porcelain=v2", "--branch"], repo);
    if (!raw.ok) throw new Error(raw.error.message);
    return parseStatus(raw.value.stdout).dirty;
  };

  it("seeds silently on the first look", async () => {
    const watch = new ChangeSetWatch(systemGit);
    writeFileSync(join(repo, "new.txt"), "hi\n");

    await expect(watch.hasChanged("worktree-1", repo)).resolves.toBe(false);
  });

  it("stays quiet while nothing moves", async () => {
    const watch = new ChangeSetWatch(systemGit);
    writeFileSync(join(repo, "new.txt"), "hi\n");

    await watch.hasChanged("worktree-1", repo);
    await expect(watch.hasChanged("worktree-1", repo)).resolves.toBe(false);
  });

  /**
   * The case the coarse worktree state cannot see. An untracked build tree is
   * one collapsed `? dist/` status entry however many files it holds; adding
   * it to a new .gitignore removes that entry and adds `? .gitignore` — one
   * line out, one line in. The dirty count the refresher compares is identical
   * before and after, while the actual change set went from thousands of files
   * to one.
   */
  it("notices a .gitignore edit that leaves the dirty count identical", async () => {
    mkdirSync(join(repo, "dist"));
    for (let i = 0; i < 5; i += 1) {
      writeFileSync(join(repo, "dist", `chunk${i}.js`), "x\n");
    }
    const watch = new ChangeSetWatch(systemGit);
    await watch.hasChanged("worktree-1", repo);
    const before = await dirty();

    writeFileSync(join(repo, ".gitignore"), "dist/\n");

    expect(await dirty()).toBe(before);
    await expect(watch.hasChanged("worktree-1", repo)).resolves.toBe(true);
  });

  it("keeps worktrees apart", async () => {
    const watch = new ChangeSetWatch(systemGit);
    await watch.hasChanged("worktree-1", repo);
    writeFileSync(join(repo, "new.txt"), "hi\n");

    // Same directory, different id: this id has no fingerprint yet, so it
    // seeds rather than inheriting worktree-1's answer.
    await expect(watch.hasChanged("worktree-2", repo)).resolves.toBe(false);
    await expect(watch.hasChanged("worktree-1", repo)).resolves.toBe(true);
  });

  it("reports no change when git itself failed", async () => {
    const watch = new ChangeSetWatch(systemGit);
    await expect(
      watch.hasChanged("worktree-1", join(root, "not-a-repo"))
    ).resolves.toBe(false);
  });
});

describe("createChangeSetAnnouncer", () => {
  const setup = (hasChanged: boolean | Error, gate?: Promise<void>) => {
    const watch = {
      hasChanged: vi.fn(async () => {
        if (gate !== undefined) await gate;
        return hasChanged instanceof Error
          ? Promise.reject(hasChanged)
          : Promise.resolve(hasChanged);
      })
    } as unknown as ChangeSetWatch;
    const announce = vi.fn();
    const onError = vi.fn();
    // Not vi.fn: wrapping a generic in a mock erases the type parameter and
    // the deps object stops matching. Record the ids by hand instead.
    const queued: string[] = [];
    const announcer = createChangeSetAnnouncer({
      watch,
      pathOf: (id) => (id === "worktree-1" ? "/repos/project" : null),
      run: <T,>(worktreeId: string, operation: () => Promise<T>) => {
        queued.push(worktreeId);
        return operation();
      },
      announce,
      onError
    });
    return { announcer, announce, onError, queued, watch };
  };

  it("announces the worktree whose list moved", async () => {
    const { announcer, announce, queued } = setup(true);

    announcer("worktree-1");
    await vi.waitFor(() => expect(announce).toHaveBeenCalledWith("worktree-1"));
    // Through the queue, so a look cannot read a half-applied index.
    expect(queued).toEqual(["worktree-1"]);
  });

  it("stays silent when nothing moved", async () => {
    const { announcer, announce, queued } = setup(false);

    announcer("worktree-1");
    await vi.waitFor(() => expect(queued).toEqual(["worktree-1"]));
    expect(announce).not.toHaveBeenCalled();
  });

  it("skips a worktree that no longer has a path", async () => {
    const { announcer, queued, announce } = setup(true);

    announcer("gone");

    expect(queued).toEqual([]);
    expect(announce).not.toHaveBeenCalled();
  });

  it("routes a failed look to the error sink, not an unhandled rejection", async () => {
    const boom = new Error("git exploded");
    const { announcer, onError, announce } = setup(boom);

    announcer("worktree-1");

    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(boom));
    expect(announce).not.toHaveBeenCalled();
  });
  // The poll ticks every 15s and every window focus fires one too, while the
  // operation queue chains rather than coalescing — so without a guard an
  // alt-tab flurry buys one status read per focus event.
  it("keeps one look outstanding per worktree", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { announcer, announce, queued, watch } = setup(true, gate);

    announcer("worktree-1");
    announcer("worktree-1");
    announcer("worktree-1");

    expect(queued).toEqual(["worktree-1"]);
    release();
    await vi.waitFor(() => expect(announce).toHaveBeenCalledTimes(1));
    expect(watch.hasChanged).toHaveBeenCalledTimes(1);
  });

  it("looks again once the outstanding one settles", async () => {
    const { announcer, queued, watch } = setup(false);

    announcer("worktree-1");
    // Retrying the trigger is what the poll itself does, and it is the only
    // race-free way to assert the guard is transient: the call count rises
    // before the chain's `finally` reopens it.
    await vi.waitFor(() => {
      announcer("worktree-1");
      expect(watch.hasChanged).toHaveBeenCalledTimes(2);
    });

    expect(queued).toEqual(["worktree-1", "worktree-1"]);
  });

  it("does not let a failed look wedge the guard shut", async () => {
    const { announcer, onError, watch } = setup(new Error("git exploded"));

    announcer("worktree-1");
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));

    await vi.waitFor(() => {
      announcer("worktree-1");
      expect(watch.hasChanged).toHaveBeenCalledTimes(2);
    });
  });

  it("does not let one worktree's look block another", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { announcer, queued } = setup(true, gate);

    announcer("worktree-1");
    announcer("worktree-2");

    // worktree-2 has no path in this fixture, so the useful assertion is that
    // worktree-1's outstanding look did not swallow the second call: it was
    // rejected by pathOf, not by the guard.
    expect(queued).toEqual(["worktree-1"]);
    release();
  });
});
