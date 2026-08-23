import { execFile, execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { err, ok } from "@pwrgit/shared";
import { bulkSyncRepositories, type BulkSyncRepoInput } from "./bulk-sync";
import type { GitExec } from "./dugite";

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

const systemGit: GitExec = (args, cwd, options) =>
  new Promise((resolve) => {
    execFile(
      "git",
      args,
      {
        cwd,
        env: { ...GIT_ENV, ...options?.env },
        encoding: "utf8",
        ...(options?.signal === undefined ? {} : { signal: options.signal })
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve(ok({ stdout, stderr, exitCode: 0 }));
          return;
        }
        if (typeof error.code === "number") {
          resolve(ok({ stdout, stderr, exitCode: error.code }));
          return;
        }
        resolve(
          err({
            kind: "git",
            code: error.name === "AbortError" ? "aborted" : "spawn_failed",
            message: error.message,
            cause: error
          })
        );
      }
    );
  });

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    env: GIT_ENV,
    encoding: "utf8"
  }).trim();
}

function gitMayFail(cwd: string, ...args: string[]): number {
  return spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).status ?? 1;
}

type TrackedRepo = {
  input: BulkSyncRepoInput;
  remote: string;
  base: string;
};

let root: string;
let sequence = 0;

function trackedRepo(name: string): TrackedRepo {
  const id = `${name}-${sequence++}`;
  const remote = join(root, `${id}.git`);
  const path = join(root, id);
  git(root, "init", "--bare", "--initial-branch=main", remote);
  mkdirSync(path);
  git(path, "init", "-b", "main");
  git(path, "config", "core.autocrlf", "false");
  writeFileSync(join(path, "shared.txt"), "base\n");
  git(path, "add", "-A");
  git(path, "commit", "-m", "initial");
  git(path, "remote", "add", "origin", remote);
  git(path, "push", "-u", "origin", "main");
  const base = git(path, "rev-parse", "HEAD");
  return {
    remote,
    base,
    input: {
      id,
      name,
      path,
      worktrees: [{ id: `${id}-main`, branch: "main", path }]
    }
  };
}

function leaveMainBehind(repo: TrackedRepo, file = "upstream.txt"): string {
  writeFileSync(join(repo.input.path, file), "upstream\n");
  git(repo.input.path, "add", "-A");
  git(repo.input.path, "commit", "-m", `advance ${file}`);
  const upstream = git(repo.input.path, "rev-parse", "HEAD");
  git(repo.input.path, "push", "origin", "main");
  git(repo.input.path, "reset", "--hard", repo.base);
  git(
    repo.input.path,
    "update-ref",
    "refs/remotes/origin/main",
    repo.base
  );
  return upstream;
}

function peerAdvance(remote: string, branch: string, file: string): string {
  const peer = join(root, `peer-${sequence++}`);
  git(root, "clone", remote, peer);
  git(peer, "config", "core.autocrlf", "false");
  if (branch !== "main") git(peer, "switch", branch);
  writeFileSync(join(peer, file), `${branch}\n`);
  git(peer, "add", "-A");
  git(peer, "commit", "-m", `advance ${branch}`);
  const head = git(peer, "rev-parse", "HEAD");
  git(peer, "push", "origin", branch);
  return head;
}

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "pwrgit-bulk-sync-")));
  sequence = 0;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("bulk repository synchronization", () => {
  it("fetches a shared repository once and fast-forwards each safe worktree", async () => {
    const repo = trackedRepo("shared-worktrees");
    git(repo.input.path, "branch", "release");
    git(repo.input.path, "push", "-u", "origin", "release");
    const releasePath = join(root, "release-worktree");
    git(repo.input.path, "worktree", "add", releasePath, "release");
    repo.input.worktrees.push({
      id: `${repo.input.id}-release`,
      branch: "release",
      path: releasePath
    });

    const mainHead = peerAdvance(repo.remote, "main", "main-upstream.txt");
    const releaseHead = peerAdvance(
      repo.remote,
      "release",
      "release-upstream.txt"
    );
    git(repo.input.path, "update-ref", "refs/remotes/origin/main", repo.base);
    git(repo.input.path, "update-ref", "refs/remotes/origin/release", repo.base);

    let fetches = 0;
    const countedGit: GitExec = (args, cwd, options) => {
      if (args[0] === "fetch") fetches += 1;
      return systemGit(args, cwd, options);
    };
    const summary = await bulkSyncRepositories(countedGit, [repo.input], {
      operationId: "shared-success",
      mode: "soft-pull"
    });

    expect(fetches).toBe(1);
    expect(summary.counts.worktrees.updated).toBe(2);
    expect(summary.results[0]?.outcome).toBe("success");
    expect(git(repo.input.path, "rev-parse", "HEAD")).toBe(mainHead);
    expect(git(releasePath, "rev-parse", "HEAD")).toBe(releaseHead);
  });

  it(
    "skips dirty, conflicted, detached, untracked, diverged, and in-progress worktrees without moving them",
    async () => {
      const dirty = trackedRepo("dirty");
      leaveMainBehind(dirty);
      writeFileSync(join(dirty.input.path, "local.txt"), "do not touch\n");

      const detached = trackedRepo("detached");
      leaveMainBehind(detached);
      git(detached.input.path, "switch", "--detach", detached.base);

      const noUpstream = trackedRepo("no-upstream");
      git(noUpstream.input.path, "branch", "--unset-upstream");

      const diverged = trackedRepo("diverged");
      leaveMainBehind(diverged);
      writeFileSync(join(diverged.input.path, "local-only.txt"), "local\n");
      git(diverged.input.path, "add", "-A");
      git(diverged.input.path, "commit", "-m", "local-only");

      const ahead = trackedRepo("ahead");
      writeFileSync(join(ahead.input.path, "local-ahead.txt"), "local\n");
      git(ahead.input.path, "add", "-A");
      git(ahead.input.path, "commit", "-m", "local ahead");

      const conflicted = trackedRepo("conflicted");
      git(conflicted.input.path, "switch", "-c", "other");
      writeFileSync(join(conflicted.input.path, "shared.txt"), "theirs\n");
      git(conflicted.input.path, "add", "-A");
      git(conflicted.input.path, "commit", "-m", "theirs");
      const conflictingCommit = git(conflicted.input.path, "rev-parse", "HEAD");
      git(conflicted.input.path, "switch", "main");
      writeFileSync(join(conflicted.input.path, "shared.txt"), "ours\n");
      git(conflicted.input.path, "commit", "-am", "ours");
      expect(gitMayFail(conflicted.input.path, "cherry-pick", conflictingCommit)).not.toBe(0);

      const inProgress = trackedRepo("in-progress");
      git(inProgress.input.path, "switch", "-c", "side");
      writeFileSync(join(inProgress.input.path, "side.txt"), "side\n");
      git(inProgress.input.path, "add", "-A");
      git(inProgress.input.path, "commit", "-m", "side");
      git(inProgress.input.path, "switch", "main");
      git(inProgress.input.path, "merge", "--no-commit", "--no-ff", "side");

      const inputs = [
        dirty.input,
        detached.input,
        noUpstream.input,
        diverged.input,
        ahead.input,
        conflicted.input,
        inProgress.input
      ];
      const beforeHeads = new Map(
        inputs.map((input) => [
          input.id,
          git(input.path, "rev-parse", "HEAD")
        ])
      );
      const beforeDirtyStatus = git(dirty.input.path, "status", "--porcelain");

      const summary = await bulkSyncRepositories(systemGit, inputs, {
        operationId: "safety-skips",
        mode: "soft-pull",
        concurrency: 3
      });
      const reason = (name: string) =>
        summary.results
          .find((result) => result.name === name)
          ?.worktrees[0]?.reason;

      expect(reason("dirty")).toBe("dirty");
      expect(reason("detached")).toBe("detached_head");
      expect(reason("no-upstream")).toBe("no_upstream");
      expect(reason("diverged")).toBe("diverged");
      expect(reason("ahead")).toBe("ahead");
      expect(reason("conflicted")).toBe("conflicts");
      expect(reason("in-progress")).toBe("in_progress");
      for (const input of inputs) {
        expect(git(input.path, "rev-parse", "HEAD")).toBe(beforeHeads.get(input.id));
      }
      expect(git(dirty.input.path, "status", "--porcelain")).toBe(
        beforeDirtyStatus
      );
      expect(git(inProgress.input.path, "rev-parse", "--verify", "MERGE_HEAD"))
        .not.toBe("");
    },
    60_000
  );

  it("isolates remote failures, identifies auth, and keeps fetching other remotes", async () => {
    const partial = trackedRepo("partial");
    leaveMainBehind(partial);
    git(partial.input.path, "remote", "add", "broken", join(root, "missing.git"));
    git(
      partial.input.path,
      "remote",
      "add",
      "ignored",
      join(root, "also-missing.git")
    );
    git(partial.input.path, "config", "remote.ignored.skipFetchAll", "true");

    const auth = trackedRepo("auth");
    leaveMainBehind(auth);
    const unsafe = trackedRepo("unsafe");
    leaveMainBehind(unsafe);

    const intercepted: GitExec = (args, cwd, options) => {
      if (args[0] === "fetch" && cwd === auth.input.path) {
        return Promise.resolve(
          ok({
            stdout: "",
            stderr: "fatal: Authentication failed for remote",
            exitCode: 128
          })
        );
      }
      if (args[0] === "status" && cwd === unsafe.input.path) {
        return Promise.resolve(
          err({ kind: "git", code: "spawn_failed", message: "status unavailable" })
        );
      }
      return systemGit(args, cwd, options);
    };

    const summary = await bulkSyncRepositories(
      intercepted,
      [partial.input, auth.input, unsafe.input],
      { operationId: "failures", mode: "soft-pull" }
    );
    const partialResult = summary.results.find((result) => result.name === "partial")!;
    expect(partialResult.remotes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ remote: "origin", outcome: "fetched" }),
        expect.objectContaining({ remote: "broken", outcome: "failed" }),
        expect.objectContaining({
          remote: "ignored",
          outcome: "skipped",
          reason: "skip_fetch_all"
        })
      ])
    );
    expect(partialResult.worktrees[0]?.outcome).toBe("updated");
    expect(partialResult.outcome).toBe("partial");
    expect(
      summary.results.find((result) => result.name === "auth")?.worktrees[0]
    ).toMatchObject({ outcome: "skipped", reason: "authentication" });
    expect(
      summary.results.find((result) => result.name === "unsafe")?.worktrees[0]
    ).toMatchObject({ outcome: "failed", reason: "unsafe_state" });
  });

  it("caps repository concurrency and returns legible cancellation results", async () => {
    const controller = new AbortController();
    let activeFetches = 0;
    let maxActiveFetches = 0;
    let announceStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      announceStarted = resolve;
    });
    const fakeGit: GitExec = async (args, _cwd, options) => {
      if (args[0] === "remote") {
        return ok({ stdout: "origin\n", stderr: "", exitCode: 0 });
      }
      if (args[0] === "config") {
        return ok({ stdout: "", stderr: "", exitCode: 1 });
      }
      if (args[0] === "fetch") {
        activeFetches += 1;
        maxActiveFetches = Math.max(maxActiveFetches, activeFetches);
        if (activeFetches === 2) announceStarted();
        await new Promise<void>((resolve) =>
          options?.signal?.addEventListener("abort", () => resolve(), {
            once: true
          })
        );
        activeFetches -= 1;
        return err({ kind: "git", code: "aborted", message: "cancelled" });
      }
      throw new Error(`unexpected git command: ${args.join(" ")}`);
    };
    const repos: BulkSyncRepoInput[] = Array.from({ length: 7 }, (_, index) => ({
      id: `repo-${index}`,
      name: `repo-${index}`,
      path: `/repo-${index}`,
      worktrees: []
    }));
    const operation = bulkSyncRepositories(fakeGit, repos, {
      operationId: "cancel",
      mode: "fetch",
      concurrency: 2,
      signal: controller.signal
    });
    await started;
    controller.abort();
    const summary = await operation;

    expect(maxActiveFetches).toBe(2);
    expect(summary.cancelled).toBe(true);
    expect(summary.counts.repos.cancelled).toBe(7);
    expect(summary.results).toHaveLength(7);
    expect(summary.results.every((result) => result.outcome === "cancelled")).toBe(
      true
    );
  });
});
