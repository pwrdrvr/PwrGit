import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ok } from "@pwrgit/shared";
import type { GitExec } from "./dugite";
import { createSystemGit } from "./test-support/system-git";
import { timedGitSync } from "./test-support/git-tripwire";
import { checkRemoteTips, ensureForkParentRemote } from "./auto-remote-check";
import { RemoteTipChecker } from "./remote-tip-checker";
import { resolveForkStatus } from "./git-service";

const systemGit = createSystemGit();

function git(cwd: string, ...args: string[]): string {
  return timedGitSync(args, cwd, () =>
    execFileSync("git", ["-C", cwd, ...args], {
      cwd: tmpdir(), encoding: "utf8"
    }).trim()
  );
}

async function checkSelectedRemoteTips(
  git: GitExec, cwd: string, branch: string, parent: Parameters<typeof checkRemoteTips>[2],
  exclusive: Parameters<typeof checkRemoteTips>[3], onFetched: () => void
) {
  return (await checkRemoteTips(git, [{ id: "selected", path: cwd, branch }], parent, exclusive, onFetched)).get("selected")!;
}

function forkFixture(): { origin: string; source: string; writer: string; local: string } {
  const root = mkdtempSync(join(tmpdir(), "pwrgit-auto-remote-"));
  const origin = join(root, "origin.git");
  const source = join(root, "source.git");
  const writer = join(root, "writer");
  const local = join(root, "local");
  git(root, "init", "--bare", "-b", "main", origin);
  git(root, "clone", origin, writer);
  git(writer, "config", "user.name", "Test");
  git(writer, "config", "user.email", "test@example.com");
  git(writer, "config", "core.autocrlf", "false");
  writeFileSync(join(writer, "first.txt"), "first\n");
  git(writer, "add", ".");
  git(writer, "commit", "-m", "first");
  git(writer, "push", "-u", "origin", "main");
  git(root, "clone", "--bare", origin, source);
  git(root, "clone", origin, local);
  git(local, "remote", "add", "upstream", source);
  git(local, "fetch", "upstream");
  return { origin, source, writer, local };
}

/** The repository lock, for tests that do not exercise it. */
const unlocked = <T>(run: () => Promise<T>): Promise<T> => run();

describe("automatic selected-branch remote check", () => {
  it.each([false, true])("resolves each worktree's effective tracking before batching (different endpoint: %s)", async (differentEndpoint) => {
    const { writer, local, source, origin } = forkFixture();
    git(local, "remote", "remove", "upstream");
    git(writer, "push", "origin", "main:topic");
    git(local, "fetch", "origin");
    const linked = join(mkdtempSync(join(tmpdir(), "pwrgit-worktree-config-")), "topic");
    git(local, "worktree", "add", "--no-track", "-b", "topic", linked, "origin/topic");
    git(local, "config", "extensions.worktreeConfig", "true");
    git(local, "config", "branch.topic.remote", "origin");
    git(linked, "config", "--worktree", "branch.topic.merge", "refs/heads/topic");
    if (differentEndpoint) {
      // URL values are multi-valued, so keep each endpoint only in its own
      // config.worktree rather than appending to the common URL list.
      git(local, "config", "--local", "--unset-all", "remote.origin.url");
      git(local, "config", "--worktree", "remote.origin.url", origin);
      git(linked, "config", "--worktree", "remote.origin.url", source);
      git(writer, "remote", "add", "alternate", source);
    }
    // The merge ref is visible only from the linked checkout's config.worktree.
    expect(git(local, "for-each-ref", "--format=%(upstream)", "refs/heads/topic")).toBe("");
    expect(git(linked, "rev-parse", "--symbolic-full-name", "@{u}")).toBe("refs/remotes/origin/topic");
    git(writer, "commit", "--allow-empty", "-m", "topic 1");
    git(writer, "push", differentEndpoint ? "alternate" : "origin", "main:topic");
    git(writer, "commit", "--allow-empty", "-m", "main 2");
    git(writer, "push", "origin", "main");
    const advertisements: { args: string[]; cwd: string }[] = [];
    const recorded: GitExec = (args, cwd, options) => {
      if (args[0] === "ls-remote") advertisements.push({ args, cwd });
      return systemGit(args, cwd, options);
    };
    expect(await checkRemoteTips(recorded, [
      { id: "main", path: local, branch: "main" },
      { id: "topic", path: linked, branch: "topic" }
    ], null, unlocked, () => undefined)).toEqual(new Map([["main", ok("checked")], ["topic", ok("checked")]]));
    expect(git(local, "rev-list", "--count", "HEAD..origin/main")).toBe("2");
    expect(git(linked, "rev-list", "--count", "HEAD..origin/topic")).toBe("1");
    expect(advertisements).toEqual(differentEndpoint ? [
      { args: ["ls-remote", "--heads", "origin", "refs/heads/main"], cwd: local },
      { args: ["ls-remote", "--heads", "origin", "refs/heads/topic"], cwd: linked }
    ] : [
      { args: ["ls-remote", "--heads", "origin", "refs/heads/main", "refs/heads/topic"], cwd: local }
    ]);
  });

  it("advertises each remote once for two real worktrees and applies each branch's distinct tip", async () => {
    const { writer, local } = forkFixture();
    git(writer, "push", "origin", "main:topic");
    git(local, "fetch", "origin");
    const linked = join(mkdtempSync(join(tmpdir(), "pwrgit-batched-worktree-")), "topic");
    git(local, "worktree", "add", "-b", "topic", linked, "origin/topic");
    git(writer, "commit", "--allow-empty", "-m", "main 1");
    git(writer, "push", "origin", "main:topic");
    git(writer, "commit", "--allow-empty", "-m", "main 2");
    git(writer, "push", "origin", "main");
    const commands: string[][] = [];
    const recorded: GitExec = (args, cwd, options) => {
      commands.push(args);
      return systemGit(args, cwd, options);
    };
    const answers = await checkRemoteTips(recorded, [
      { id: "main", path: local, branch: "main" },
      { id: "topic", path: linked, branch: "topic" }
    ], null, unlocked, () => undefined);
    expect(answers).toEqual(new Map([["main", ok("checked")], ["topic", ok("checked")]]));
    expect(commands.filter(([name]) => name === "ls-remote")).toEqual([
      ["ls-remote", "--heads", "origin", "refs/heads/main", "refs/heads/topic"],
      ["ls-remote", "--heads", "upstream", "refs/heads/main", "refs/heads/topic"]
    ]);
    expect(git(local, "rev-list", "--count", "HEAD..origin/main")).toBe("2");
    expect(git(linked, "rev-list", "--count", "HEAD..origin/topic")).toBe("1");
    // Absence is per ref, even when another requested head is advertised.
    git(writer, "push", "origin", "--delete", "topic");
    expect((await checkRemoteTips(recorded, [
      { id: "main", path: local, branch: "main" },
      { id: "topic", path: linked, branch: "topic" }
    ], null, unlocked, () => undefined)).get("main")).toEqual(ok("checked"));
    expect(git(local, "branch", "-r")).toContain("origin/main");
    expect(git(local, "branch", "-r")).not.toContain("origin/topic");
  });

  it("preserves sanitized DNS failure detail so the shared checker can pause the network", async () => {
    const { local } = forkFixture();
    const failingGit: GitExec = (args, cwd, options) => args[0] === "ls-remote"
      ? Promise.resolve(ok({
        exitCode: 128, stdout: "",
        stderr: "fatal: unable to access 'https://user:secret-value@example.test/repo': Could not resolve host: example.test"
      }))
      : systemGit(args, cwd, options);
    const result = await checkSelectedRemoteTips(failingGit, local, "main", null, unlocked, () => undefined);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("Could not resolve host");
    expect(result.error.message).not.toContain("secret-value");
  });

  it("discovers two remote commits for a visible repository without selecting or changing its checkout", async () => {
    const { writer, local } = forkFixture();
    const head = git(local, "rev-parse", "HEAD");
    for (const name of ["second", "third"]) {
      writeFileSync(join(writer, `${name}.txt`), `${name}\n`);
      git(writer, "add", ".");
      git(writer, "commit", "-m", name);
    }
    git(writer, "push", "origin", "main");
    expect(git(local, "rev-list", "--count", "HEAD..origin/main")).toBe("0");
    let behind = 0;
    const checked: string[] = [];
    const checker = new RemoteTipChecker({
      isFocused: () => true,
      check: async (ids) => {
        checked.push(...ids);
        const result = await checkSelectedRemoteTips(
          systemGit, local, "main", null, unlocked, () => undefined
        );
        behind = Number(git(local, "rev-list", "--count", "HEAD..origin/main"));
        return new Map(ids.map((id) => [id, result.ok ? ok({ status: result.value }) : result]));
      }
    });
    try {
      checker.report(1, ["unselected-repo"]);
      expect(checked).toEqual([]);
      await vi.waitFor(() => expect(behind).toBe(2), { timeout: 5_000 });
      expect(checked).toEqual(["unselected-repo"]);
      expect(git(local, "rev-parse", "HEAD")).toBe(head);
      expect(git(local, "status", "--porcelain")).toBe("");
    } finally {
      checker.stop();
    }
  });

  it("wires a stored fork parent once so the ordinary source status can see it", async () => {
    const remotes = new Map([["origin", "git@github.com:me/fork.git"]]);
    const commands: string[][] = [];
    const git: GitExec = async (args) => {
      commands.push(args);
      if (args[0] === "remote" && args[1] === "-v") {
        return ok({
          exitCode: 0,
          stdout: [...remotes].flatMap(([name, url]) => [
            `${name}\t${url} (fetch)`, `${name}\t${url} (push)`
          ]).join("\n") + "\n",
          stderr: ""
        });
      }
      if (args[0] === "remote" && args[1] === "add") {
        remotes.set(args[2]!, args[3]!);
        return ok({ exitCode: 0, stdout: "", stderr: "" });
      }
      throw new Error(`unexpected Git command: ${args.join(" ")}`);
    };
    const parent = { hostname: "github.com", nameWithOwner: "original/project" };
    const fork = { hostname: "github.com", nameWithOwner: "me/fork" };
    expect(await ensureForkParentRemote(git, "/repo", parent, fork)).toEqual(ok(undefined));
    expect(remotes.get("upstream")).toBe("git@github.com:original/project.git");
    expect(await ensureForkParentRemote(git, "/repo", parent, fork)).toEqual(ok(undefined));
    expect(commands.filter(([command, action]) => command === "remote" && action === "add"))
      .toHaveLength(1);
  });

  it("leaves equal tips alone and fetches only changed tracked and fork-source branches", async () => {
    const { source, writer, local } = forkFixture();

    const commands: string[][] = [];
    const locked: string[] = [];
    let holding = false;
    const recordingGit: GitExec = (args, cwd, options) => {
      commands.push(args);
      if (holding) locked.push(args[0]!);
      return systemGit(args, cwd, options);
    };
    const exclusive = async <T>(run: () => Promise<T>): Promise<T> => {
      holding = true;
      try { return await run(); } finally { holding = false; }
    };
    let fetched = 0;
    const check = () => checkSelectedRemoteTips(
      recordingGit, local, "main", null, exclusive, () => { fetched += 1; }
    );
    expect(await check()).toEqual({ ok: true, value: "checked" });
    expect(commands.filter(([name]) => name === "fetch")).toHaveLength(0);

    writeFileSync(join(writer, "second.txt"), "second\n");
    git(writer, "add", ".");
    git(writer, "commit", "-m", "second");
    git(writer, "push", "origin", "main");
    writeFileSync(join(writer, "third.txt"), "third\n");
    git(writer, "add", ".");
    git(writer, "commit", "-m", "third");
    git(writer, "remote", "add", "upstream", source);
    git(writer, "push", "upstream", "main");

    expect(await check()).toEqual({ ok: true, value: "checked" });
    expect(fetched).toBe(2);
    expect(commands.filter(([name]) => name === "fetch")).toEqual([
      ["fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"],
      ["fetch", "--no-tags", "upstream", "+refs/heads/main:refs/remotes/upstream/main"]
    ]);
    expect(git(local, "rev-list", "--count", "HEAD..refs/remotes/origin/main")).toBe("1");
    expect(git(local, "rev-list", "--count", "HEAD..refs/remotes/upstream/main")).toBe("2");
    expect(await check()).toEqual({ ok: true, value: "checked" });
    expect(fetched).toBe(2);
    git(source, "config", "receive.denyDeleteCurrent", "ignore");
    git(writer, "push", "upstream", "--delete", "main");
    expect(await check()).toEqual({ ok: true, value: "checked" });
    expect(fetched).toBe(3);
    expect(git(local, "for-each-ref", "--format=%(refname)", "refs/remotes/upstream/main"))
      .toBe("");
    // Only ref writes hold the repository lock; asking a slow remote what it
    // has must never keep a stash or a user fetch waiting.
    expect(new Set(locked)).toEqual(new Set(["rev-parse", "fetch", "update-ref"]));
    expect(commands.filter(([name]) => name === "ls-remote").length).toBeGreaterThan(0);
  });

  it("uses the configured merge ref when a fetch refspec renames the local tracking ref", async () => {
    const { writer, local } = forkFixture();
    git(local, "config", "remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/cached-main");
    git(local, "fetch", "origin");
    expect(git(local, "rev-parse", "--symbolic-full-name", "@{u}"))
      .toBe("refs/remotes/origin/cached-main");
    writeFileSync(join(writer, "second.txt"), "second\n");
    git(writer, "add", ".");
    git(writer, "commit", "-m", "second");
    git(writer, "push", "origin", "main");

    const commands: string[][] = [];
    const recordingGit: GitExec = (args, cwd, options) => {
      commands.push(args);
      return systemGit(args, cwd, options);
    };
    expect(await checkSelectedRemoteTips(
      recordingGit, local, "main", null, unlocked, () => undefined
    )).toEqual(ok("checked"));
    expect(commands).toContainEqual([
      "fetch", "--no-tags", "origin",
      "+refs/heads/main:refs/remotes/origin/cached-main"
    ]);
    expect(commands).not.toContainEqual([
      "update-ref", "-d", "refs/remotes/origin/cached-main", expect.any(String)
    ]);
    expect(git(local, "rev-list", "--count", "HEAD..refs/remotes/origin/cached-main"))
      .toBe("1");
  });

  it("checks a fork source on a branch with no tracked remote", async () => {
    const { source, writer, local } = forkFixture();
    git(local, "switch", "-c", "topic");
    writeFileSync(join(writer, "second.txt"), "second\n");
    git(writer, "add", ".");
    git(writer, "commit", "-m", "second");
    git(writer, "remote", "add", "upstream", source);
    git(writer, "push", "upstream", "main:topic");

    expect(await checkSelectedRemoteTips(
      systemGit, local, "topic", null, unlocked, () => undefined
    )).toEqual(ok("checked"));
    expect(git(local, "rev-list", "--count", "HEAD..refs/remotes/upstream/topic"))
      .toBe("1");
    const status = await resolveForkStatus(systemGit, local, null);
    expect(status.ok && status.value?.source).toMatchObject({
      ref: "refs/remotes/upstream/topic", behind: 1
    });
    expect(status.ok && status.value?.tracked).toBeNull();
  });

  it("refreshes the source default when it differs from the fork default", async () => {
    const { source, writer, local } = forkFixture();
    git(source, "branch", "-m", "main", "master");
    git(local, "fetch", "--prune", "upstream");
    git(local, "remote", "set-head", "upstream", "master");
    writeFileSync(join(writer, "second.txt"), "second\n");
    git(writer, "add", ".");
    git(writer, "commit", "-m", "second");
    git(writer, "remote", "add", "upstream", source);
    git(writer, "push", "upstream", "main:master");

    expect(await checkSelectedRemoteTips(
      systemGit, local, "main", null, unlocked, () => undefined
    )).toEqual(ok("checked"));
    expect(git(local, "rev-list", "--count", "HEAD..refs/remotes/upstream/master"))
      .toBe("1");
    const status = await resolveForkStatus(systemGit, local, null);
    expect(status.ok && status.value?.source).toMatchObject({
      ref: "refs/remotes/upstream/master", behind: 1
    });
  });
});
