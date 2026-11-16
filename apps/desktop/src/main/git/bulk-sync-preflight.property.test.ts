import { execFileSync } from "node:child_process";
import { appendFileSync, cpSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { bulkSyncRepositories, type BulkSyncRepoInput } from "./bulk-sync";
import { execGit, type GitExec } from "./dugite";
import { createSystemGit } from "./test-support/system-git";
import { PULL_STALL_TIMEOUT_MS } from "./pull-watchdog";
import { CommandBus } from "../command-bus";
import { openDatabase } from "../persistence/db";
import { ProfileService } from "../profiles/profile-service";
import { registerBulkSyncHandlers } from "./bulk-sync-handlers";
import { WorktreeOperationQueue } from "./worktree-operation-queue";
import { tagAutoChecksFor } from "./tag-auto-check";
import { ok } from "@pwrgit/shared";

vi.mock("../ipc", () => ({ emitEvent: vi.fn() }));
vi.mock("../logs", () => ({ logMain: vi.fn() }));
vi.mock("./dugite", async (original) => ({
  ...await original<typeof import("./dugite")>(), execGit: vi.fn()
}));

const env = {
  ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "Sync Test", GIT_AUTHOR_EMAIL: "sync@example.test",
  GIT_COMMITTER_NAME: "Sync Test", GIT_COMMITTER_EMAIL: "sync@example.test"
};
const systemGit = createSystemGit({ env });
let template: string;
const directories: string[] = [];
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    cwd: tmpdir(), env, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"]
  }).trim();
}
beforeAll(() => {
  template = realpathSync.native(mkdtempSync(join(tmpdir(), "pwrgit-sync-template-")));
  git(template, "init", "--bare", "-b", "main", "remote.git");
  git(template, "clone", "remote.git", "publisher");
  const publisher = join(template, "publisher");
  git(publisher, "config", "core.autocrlf", "false");
  writeFileSync(join(publisher, "file.txt"), "base\n");
  git(publisher, "add", ".");
  git(publisher, "commit", "-m", "base");
  git(publisher, "push", "-u", "origin", "main");
  git(template, "clone", "remote.git", "local");
  git(join(template, "local"), "config", "core.autocrlf", "false");
});
afterAll(() => {
  for (const directory of [...directories, template]) rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "pwrgit-sync-preflight-")));
  directories.push(root);
  cpSync(template, root, { recursive: true });
  const path = join(root, "local");
  const publisher = join(root, "publisher");
  for (const cwd of [path, publisher]) git(cwd, "remote", "set-url", "origin", join(root, "remote.git"));
  const input: BulkSyncRepoInput = {
    id: root, name: "local", path,
    worktrees: [{ id: `${root}-main`, branch: "main", path }]
  };
  const calls: Array<{ args: string[]; cwd: string }> = [];
  const exec: GitExec = (args, cwd, options) => {
    calls.push({ args: [...args], cwd });
    return systemGit(args, cwd, options);
  };
  const run = () => bulkSyncRepositories(exec, [input], { operationId: "check", mode: "soft-pull" });
  const advance = (branch = "main") => {
    git(publisher, "switch", branch);
    writeFileSync(join(publisher, "file.txt"), `${branch}-${git(publisher, "rev-parse", "HEAD")}\n`);
    git(publisher, "commit", "-am", "advance");
    git(publisher, "push", "origin", branch);
    return git(publisher, "rev-parse", "HEAD");
  };
  return { root, path, publisher, input, calls, exec, run, advance };
}

describe("bulk pull remote preflight, with Git as the oracle", () => {
  // Rule: unchanged remote tips and current/untracked checkouts need no fetch
  // or per-checkout Git probes, regardless of sibling count or loose files.
  // Six real-Git runs cover generated layouts without multiplying Windows'
  // process-start cost by fast-check's default 100 runs.
  it("keeps unchanged-cycle process count independent of worktree count", async () => {
    await fc.assert(fc.asyncProperty(
      fc.integer({ min: 1, max: 5 }), fc.boolean(), fc.boolean(),
      async (siblings, dirty, packed) => {
        const f = fixture();
        for (let i = 0; i < siblings; i++) {
          const path = join(f.root, `topic-${i}`);
          git(f.path, "worktree", "add", "-b", `topic-${i}`, path, "main");
          if (i % 2 === 0) git(path, "branch", "--set-upstream-to", "origin/main");
          if (dirty) writeFileSync(join(path, "loose.txt"), "keep me\n");
          f.input.worktrees.push({ id: path, branch: `topic-${i}`, path });
        }
        if (packed) git(f.path, "pack-refs", "--all");
        const result = await f.run();
        expect(result.counts.repos.success).toBe(1);
        expect(f.calls.filter((c) => c.args[0] === "fetch")).toHaveLength(0);
        expect(f.calls.filter((c) => c.args[0] === "status")).toHaveLength(0);
        expect(f.calls.filter((c) => c.args[0] === "ls-remote")).toHaveLength(1);
        expect(f.calls.length).toBeLessThanOrEqual(5);
        for (const wt of f.input.worktrees) expect(git(wt.path, "rev-parse", "HEAD")).toBe(git(f.publisher, "rev-parse", "HEAD"));
      }
    ), { numRuns: 6 });
  });

  it("retries a dirty checkout after it is cleaned even when remote tips did not change", async () => {
    const f = fixture();
    const target = f.advance();
    writeFileSync(join(f.path, "file.txt"), "local work\n");
    const blocked = await f.run();
    expect(blocked.results[0]?.worktrees[0]?.reason).toBe("dirty");
    git(f.path, "restore", "file.txt");
    f.calls.length = 0;
    const pulled = await f.run();
    expect(pulled.counts.worktrees.updated).toBe(1);
    expect(git(f.path, "rev-parse", "HEAD")).toBe(target);
    expect(f.calls.some((c) => c.args[0] === "fetch")).toBe(false);
    expect(f.calls.some((c) => c.args[0] === "status")).toBe(true);
  });

  it("checks one current checkout with three processes and no worktree probes", async () => {
    const f = fixture();
    const result = await f.run();
    expect(result.counts.worktrees.upToDate).toBe(1);
    expect(result.counts.remotes.fetched).toBe(0);
    expect(result.results[0]?.remotes[0]?.reason).toBe("unchanged");
    expect(f.calls.map((call) => call.args[0])).toEqual(["config", "for-each-ref", "ls-remote"]);
  });

  it("inspects only the checkout whose upstream moved", async () => {
    const f = fixture();
    git(f.publisher, "branch", "topic");
    git(f.publisher, "push", "origin", "topic");
    git(f.path, "fetch", "origin");
    const path = join(f.root, "topic");
    git(f.path, "worktree", "add", "--track", "-b", "topic", path, "origin/topic");
    f.input.worktrees.push({ id: path, branch: "topic", path });
    const target = f.advance();
    const result = await f.run();
    expect(result.counts.worktrees.updated).toBe(1);
    expect(result.counts.worktrees.upToDate).toBe(1);
    expect(git(f.path, "rev-parse", "HEAD")).toBe(target);
    expect(f.calls.filter((c) => c.args[0] === "status").map((c) => c.cwd)).toEqual([f.path, f.path]);
  });

  it("notices an external reset even after an unchanged check", async () => {
    const f = fixture();
    const before = git(f.path, "rev-parse", "HEAD");
    const target = f.advance();
    await f.run();
    git(f.path, "reset", "--hard", before);
    f.calls.length = 0;
    expect((await f.run()).counts.worktrees.updated).toBe(1);
    expect(git(f.path, "rev-parse", "HEAD")).toBe(target);
    expect(f.calls.some((c) => c.args[0] === "fetch")).toBe(false);
  });

  it("fetches and prunes when the remote deletes a tracked branch", async () => {
    const f = fixture();
    git(f.publisher, "switch", "-c", "topic");
    git(f.publisher, "push", "origin", "topic");
    git(f.path, "fetch", "origin");
    const path = join(f.root, "topic");
    git(f.path, "worktree", "add", "--track", "-b", "topic", path, "origin/topic");
    f.input.worktrees.push({ id: path, branch: "topic", path });
    const before = git(path, "rev-parse", "HEAD");
    git(f.publisher, "push", "origin", "--delete", "topic");
    const result = await f.run();
    expect(result.results[0]?.worktrees[1]?.reason).toBe("no_upstream");
    expect(git(path, "rev-parse", "HEAD")).toBe(before);
    expect(git(f.path, "for-each-ref", "refs/remotes/origin/topic")).toBe("");
    expect(f.calls.filter((c) => c.args[0] === "fetch")).toHaveLength(1);
  });

  it("does not move a branch to a force-pushed, diverged upstream", async () => {
    const f = fixture();
    const original = f.advance();
    await f.run();
    git(f.publisher, "reset", "--hard", "HEAD~1");
    writeFileSync(join(f.publisher, "different.txt"), "rewritten\n");
    git(f.publisher, "add", ".");
    git(f.publisher, "commit", "-m", "different history");
    git(f.publisher, "push", "--force", "origin", "main");
    const result = await f.run();
    expect(result.results[0]?.worktrees[0]?.reason).toBe("diverged");
    expect(git(f.path, "rev-parse", "HEAD")).toBe(original);
    expect(git(f.path, "rev-parse", "origin/main")).toBe(git(f.publisher, "rev-parse", "HEAD"));
  });

  it("keeps custom fetch mappings on Git's ordinary fetch path", async () => {
    const f = fixture();
    git(f.path, "config", "remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/renamed");
    git(f.path, "config", "branch.main.merge", "refs/heads/main");
    const target = f.advance();
    const result = await f.run();
    expect(result.counts.worktrees.updated).toBe(1);
    expect(git(f.path, "rev-parse", "HEAD")).toBe(target);
    expect(f.calls.some((c) => c.args[0] === "ls-remote")).toBe(false);
  });

  it("respects worktree-specific upstream configuration", async () => {
    const f = fixture();
    git(f.publisher, "branch", "topic");
    git(f.publisher, "push", "origin", "topic");
    git(f.path, "fetch", "origin");
    const path = join(f.root, "topic");
    git(f.path, "worktree", "add", "-b", "topic", path, "main");
    git(f.path, "config", "extensions.worktreeConfig", "true");
    git(path, "config", "--worktree", "branch.topic.remote", "origin");
    git(path, "config", "--worktree", "branch.topic.merge", "refs/heads/topic");
    f.input.worktrees.push({ id: path, branch: "topic", path });
    const target = f.advance("topic");
    const result = await f.run();
    expect(result.results[0]?.worktrees[1]?.outcome).toBe("updated");
    expect(git(path, "rev-parse", "HEAD")).toBe(target);
    expect(f.calls.filter((c) => c.args[0] === "ls-remote")).toHaveLength(1);
  });

  it("observes new tracking configuration without a stale cached answer", async () => {
    const f = fixture();
    await f.run();
    git(f.publisher, "branch", "topic");
    git(f.publisher, "push", "origin", "topic");
    const target = f.advance("topic");
    git(f.path, "config", "branch.main.merge", "refs/heads/topic");
    expect((await f.run()).counts.worktrees.updated).toBe(1);
    expect(git(f.path, "rev-parse", "HEAD")).toBe(target);
  });

  it("keeps identity-only conditional includes on the cheap path", async () => {
    const f = fixture();
    const path = join(f.root, "topic");
    git(f.path, "worktree", "add", "--track", "-b", "topic", path, "origin/main");
    f.input.worktrees.push({ id: path, branch: "topic", path });
    const include = join(f.root, "identity.conf");
    writeFileSync(include, "[user]\n\temail = topic@example.test\n");
    git(f.path, "config", "includeIf.onbranch:topic.path", include);
    git(f.path, "config", "extensions.worktreeConfig", "true");
    const result = await f.run();
    expect(result.counts.worktrees.upToDate).toBe(2);
    expect(f.calls.map((c) => c.args[0])).toEqual(["config", "for-each-ref", "ls-remote", "config"]);
  });

  it("resolves conditional branch tracking in the checkout that owns it", async () => {
    const f = fixture();
    git(f.publisher, "branch", "topic");
    git(f.publisher, "push", "origin", "topic");
    git(f.path, "fetch", "origin");
    const path = join(f.root, "topic");
    git(f.path, "worktree", "add", "-b", "topic", path, "main");
    f.input.worktrees.push({ id: path, branch: "topic", path });
    const include = join(f.root, "tracking.conf");
    writeFileSync(include, '[branch "topic"]\n\tremote = origin\n\tmerge = refs/heads/topic\n');
    git(f.path, "config", "includeIf.onbranch:topic.path", include);
    const target = f.advance("topic");
    const result = await f.run();
    expect(result.results[0]?.worktrees[1]?.outcome).toBe("updated");
    expect(git(path, "rev-parse", "HEAD")).toBe(target);
  });

  it("still fetches explicitly, and honors skipFetchAll during pull", async () => {
    const f = fixture();
    await bulkSyncRepositories((args, cwd, options) => {
      f.calls.push({ args: [...args], cwd });
      return systemGit(args, cwd, options);
    }, [f.input], { operationId: "explicit", mode: "fetch" });
    expect(f.calls.filter((c) => c.args[0] === "fetch")).toHaveLength(1);
    f.calls.length = 0;
    git(f.path, "config", "remote.origin.skipFetchAll", "true");
    const result = await f.run();
    expect(result.results[0]?.remotes[0]?.reason).toBe("skip_fetch_all");
    expect(f.calls.some((c) => ["fetch", "ls-remote", "merge"].includes(c.args[0]!))).toBe(false);
  });

  it("interprets skipFetchAll booleans like Git, including empty and valueless settings", async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom("", "true", "false", "yes", "no", "2", "-1", null), async (value) => {
      const f = fixture();
      if (value === null) appendFileSync(join(f.path, ".git", "config"), '\n[remote "origin"]\n\tskipFetchAll\n');
      else git(f.path, "config", "remote.origin.skipFetchAll", value);
      const skip = git(f.path, "config", "--bool", "--get", "remote.origin.skipFetchAll") === "true";
      const result = await f.run();
      expect(result.results[0]?.remotes[0]?.reason).toBe(skip ? "skip_fetch_all" : "unchanged");
      expect(f.calls.some((c) => c.args[0] === "ls-remote")).toBe(!skip);
    }), { numRuns: 10, examples: [[""], [null], ["2"], ["-1"]] });
  });

  it.each([false, true])("refreshes family state only for an actual change (pending pull: %s)", async (pending) => {
    const f = fixture();
    if (pending) {
      f.advance();
      writeFileSync(join(f.path, "file.txt"), "local work\n");
      await f.run();
      git(f.path, "restore", "file.txt");
    }
    const db = openDatabase(":memory:");
    try {
      const profiles = new ProfileService(db);
      const mine = profiles.create({ name: "mine", email: "mine@example.test", roots: [] }).id;
      const theirs = profiles.create({ name: "theirs", email: "theirs@example.test", roots: [] }).id;
      for (const [id, profile, path] of [[f.input.id, mine, f.path], ["other", theirs, "/other"]]) {
        db.prepare("INSERT INTO repos (id, profile_id, path, name) VALUES (?, ?, ?, 'local')").run(id, profile, path);
        db.prepare("INSERT INTO worktrees (id, repo_id, path, branch, is_primary) VALUES (?, ?, ?, 'main', 1)").run(`${id}-main`, id, path);
      }
      tagAutoChecksFor(db).afterSyncWhen(() => false);
      f.calls.length = 0;
      vi.mocked(execGit).mockImplementation(f.exec);
      const refresher = { refreshWorktree: vi.fn(), refreshRepoWorktrees: vi.fn() };
      const indexer = { refreshRepoRemoteBranches: vi.fn().mockResolvedValue(ok(undefined)) };
      const identity = vi.fn();
      const bus = new CommandBus();
      registerBulkSyncHandlers(bus, db, refresher, new WorktreeOperationQueue(), indexer, identity);
      const result = await bus.dispatch("remote:bulkSync", {
        profileId: mine, operationId: "profile", mode: "soft-pull", repoIds: [f.input.id, "other"]
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.results.map((repo) => repo.repoId)).toEqual([f.input.id]);
        expect(result.value.counts.worktrees.updated).toBe(Number(pending));
      }
      expect(f.calls.some((c) => c.args[0] === "fetch")).toBe(false);
      expect(indexer.refreshRepoRemoteBranches).not.toHaveBeenCalled();
      expect(identity).not.toHaveBeenCalled();
      expect(refresher.refreshRepoWorktrees.mock.calls).toEqual(pending ? [[f.input.id]] : []);
      expect(refresher.refreshWorktree).not.toHaveBeenCalled();
    } finally { db.close(); }
  });

  it("bounds a silent remote advertisement with the same watchdog as a fetch", async () => {
    const f = fixture();
    let reached!: () => void;
    const checking = new Promise<void>((resolve) => { reached = resolve; });
    const exec: GitExec = async (args, cwd, options) => {
      if (args[0] !== "ls-remote") return systemGit(args, cwd, options);
      reached();
      return new Promise((resolve) => {
        const aborted = () => resolve({ ok: false as const, error: { kind: "git" as const, code: "aborted", message: "stopped" } });
        if (options?.signal?.aborted) aborted();
        else options?.signal?.addEventListener("abort", aborted, { once: true });
      });
    };
    vi.useFakeTimers();
    const run = bulkSyncRepositories(exec, [f.input], { operationId: "silent", mode: "soft-pull" });
    try {
      await checking;
      await vi.advanceTimersByTimeAsync(PULL_STALL_TIMEOUT_MS + 1);
      const result = await run;
      expect(result.results[0]?.remotes[0]).toMatchObject({ outcome: "failed", reason: "fetch_failed" });
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
