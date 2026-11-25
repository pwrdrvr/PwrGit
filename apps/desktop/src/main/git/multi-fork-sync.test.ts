import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloneRepository, ForgeHostMap, RepoIdentity } from "@pwrgit/shared";
import { CommandBus } from "../command-bus";
import { IdentityService } from "../forge/identity-service";
import type { ForgeRepoProvider, ForgeRepoRegistry } from "../forge/repo-provider";
import { openDatabase, type DB } from "../persistence/db";
import { registerBranchHandlers } from "./branch-handlers";
import { execGit } from "./dugite";
import {
  readForkSyncPrefs,
  readRemoteIdentities,
  writeRemoteIdentity
} from "./fork-sync-remotes";
import { registerRemoteHandlers } from "./remote-handlers";
import type { RepoIndexer } from "./repo-indexer";
import type { WorktreeRefresher } from "./worktree-handlers";
import { WorktreeOperationQueue } from "./worktree-operation-queue";
import type { SettingsService } from "../settings/settings-service";

const urlRewrites: Array<[string, string]> = [];

vi.mock("./dugite", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./dugite")>();
  return {
    ...actual,
    execGit: vi.fn((args: string[], cwd: string, options?: Parameters<typeof actual.execGit>[2]) => {
      const sub = args.find((arg) => !arg.startsWith("-"));
      if ((sub === "fetch" || sub === "push") && urlRewrites.length > 0) {
        const prefix = urlRewrites.flatMap(([localPath, forgeUrl]) => [
          "-c",
          `url.${localPath}.insteadOf=${forgeUrl}`
        ]);
        return actual.execGit([...prefix, ...args], cwd, options);
      }
      return actual.execGit(args, cwd, options);
    })
  };
});

vi.mock("../ipc", () => ({ emitEvent: vi.fn() }));
vi.mock("../logs", () => ({ logMain: vi.fn() }));

async function gitOk(args: string[], cwd: string): Promise<string> {
  const res = await execGit(args, cwd);
  if (!res.ok || res.value.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed in ${cwd}: ${res.ok ? res.value.stderr : res.error.message}`
    );
  }
  return res.value.stdout.trim();
}

async function commitFile(
  cwd: string,
  name: string,
  content: string,
  message: string
): Promise<string> {
  writeFileSync(join(cwd, name), content);
  await gitOk(["add", name], cwd);
  await gitOk(
    [
      "-c",
      "user.name=Test User",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      message
    ],
    cwd
  );
  return gitOk(["rev-parse", "HEAD"], cwd);
}

describe("multi-fork sync (real git + SQLite)", () => {
  const dirs: string[] = [];
  const dbs: DB[] = [];

  afterEach(() => {
    urlRewrites.length = 0;
    for (const db of dbs.splice(0)) db.close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function createMultiForkWorld() {
    const root = mkdtempSync(join(tmpdir(), "pwrgit-multi-fork-"));
    dirs.push(root);

    const upstreamBare = join(root, "upstream.git");
    const originBare = join(root, "origin.git");
    const personalBare = join(root, "personal.git");
    const readonlyBare = join(root, "readonly.git");
    const upstreamWork = join(root, "upstream-work");
    const checkout = join(root, "checkout");

    await gitOk(["init", "--bare", "--initial-branch=main", upstreamBare], root);
    await gitOk(["clone", upstreamBare, upstreamWork], root);
    const initial = await commitFile(upstreamWork, "README.md", "v1\n", "initial");
    await gitOk(["push", "-u", "origin", "main"], upstreamWork);

    // Clone three forks at the initial commit.
    await gitOk(["clone", "--bare", upstreamBare, originBare], root);
    await gitOk(["clone", "--bare", upstreamBare, personalBare], root);
    await gitOk(["clone", "--bare", upstreamBare, readonlyBare], root);

    // Local checkout starts from `origin` (org fork), with `upstream`,
    // `personal` (writable fork), and `coworker` (read-only fork) configured.
    await gitOk(["clone", originBare, checkout], root);
    await gitOk(["remote", "add", "upstream", upstreamBare], checkout);
    await gitOk(["remote", "add", "personal", personalBare], checkout);
    await gitOk(["remote", "add", "coworker", readonlyBare], checkout);

    // Redirect fetch/push to the local bare repos via per-command `-c url.*.insteadOf`
    // while `git remote -v` and `git remote get-url` keep the real forge SSH URLs.
    urlRewrites.push(
      [upstreamBare, "git@github.com:acme/app.git"],
      [originBare, "git@github.com:org/app.git"],
      [personalBare, "git@github.com:me/app.git"],
      [readonlyBare, "git@github.com:alice/app.git"]
    );
    await gitOk(["remote", "set-url", "origin", "git@github.com:org/app.git"], checkout);
    await gitOk(["remote", "set-url", "upstream", "git@github.com:acme/app.git"], checkout);
    await gitOk(["remote", "set-url", "personal", "git@github.com:me/app.git"], checkout);
    await gitOk(["remote", "set-url", "coworker", "git@github.com:alice/app.git"], checkout);
    await gitOk(["fetch", "--all"], checkout);
    await gitOk(["remote", "set-head", "origin", "main"], checkout);
    await gitOk(["remote", "set-head", "upstream", "main"], checkout);
    await gitOk(["remote", "set-head", "personal", "main"], checkout);

    const db = openDatabase(":memory:");
    dbs.push(db);
    db.prepare(
      `INSERT INTO profiles (id, name, email) VALUES ('p1', 'Dev', 'dev@example.com')`
    ).run();
    db.prepare(
      `INSERT INTO repos (id, profile_id, name, path, source)
       VALUES ('repo-1', 'p1', 'app', ?, 'manual')`
    ).run(checkout);
    db.prepare(
      `INSERT INTO worktrees (id, repo_id, branch, path, is_primary)
       VALUES ('wt-1', 'repo-1', 'main', ?, 1)`
    ).run(checkout);

    const identity: RepoIdentity = {
      host: "github",
      hostname: "github.com",
      owner: "org",
      name: "app",
      nameWithOwner: "org/app",
      visibility: "public",
      viewerCanPush: true,
      parent: { nameWithOwner: "acme/app", url: "https://github.com/acme/app" }
    };

    writeRemoteIdentity(db, "repo-1", {
      hostname: "github.com",
      nameWithOwner: "me/app",
      viewerCanPush: true,
      parent: "acme/app"
    });
    writeRemoteIdentity(db, "repo-1", {
      hostname: "github.com",
      nameWithOwner: "alice/app",
      viewerCanPush: false,
      parent: "acme/app"
    });

    const bus = new CommandBus();
    const refresher: WorktreeRefresher = {
      refreshWorktree: vi.fn(async () => undefined),
      refreshRepoWorktrees: vi.fn(async () => undefined)
    };
    const operations = new WorktreeOperationQueue();
    const hosts: ForgeHostMap = {};
    registerRemoteHandlers(
      bus,
      db,
      refresher,
      operations,
      undefined,
      undefined,
      () => identity,
      () => hosts
    );
    const fakeIndexer = {
      pinnedBranchNames: () => new Set<string>()
    } as unknown as RepoIndexer;
    registerBranchHandlers(
      bus,
      db,
      fakeIndexer,
      refresher,
      operations,
      {} as SettingsService,
      undefined,
      () => identity,
      () => hosts
    );

    return {
      root,
      db,
      bus,
      checkout,
      upstreamWork,
      upstreamBare,
      originBare,
      personalBare,
      readonlyBare,
      initial
    };
  }

  it("syncs upstream/main to both writable forks by default and leaves read-only forks untouched", async () => {
    const w = await createMultiForkWorld();
    const tip1 = await commitFile(w.upstreamWork, "a.txt", "1\n", "upstream 1");
    const tip2 = await commitFile(w.upstreamWork, "b.txt", "2\n", "upstream 2");
    await gitOk(["push", "origin", "main"], w.upstreamWork);
    await gitOk(["fetch", "upstream"], w.checkout);

    const status = await w.bus.dispatch("remote:forkStatus", { worktreeId: "wt-1" });
    expect(status.ok).toBe(true);
    if (!status.ok || status.value === null || status.value.source === null) {
      throw new Error("expected fork status");
    }
    expect(status.value.source.behind).toBe(2);
    expect(status.value.source.syncTargets?.map((t) => ({
      remote: t.remote,
      branch: t.branch,
      nameWithOwner: t.nameWithOwner,
      tracked: t.tracked,
      enabled: t.enabled,
      adds: t.pushBack?.adds ?? 0
    }))).toEqual([
      { remote: "origin", branch: "main", nameWithOwner: "org/app", tracked: true, enabled: true, adds: 2 },
      { remote: "personal", branch: "main", nameWithOwner: "me/app", tracked: false, enabled: true, adds: 2 }
    ]);

    const synced = await w.bus.dispatch("remote:syncFork", {
      worktreeId: "wt-1",
      branch: "main",
      sourceRef: "refs/remotes/upstream/main",
      push: true
    });
    expect(synced.ok).toBe(true);
    if (!synced.ok) return;
    expect(synced.value.arrived).toBe(2);
    expect(synced.value.pushes).toEqual([
      { outcome: "pushed", remote: "origin", branch: "main" },
      { outcome: "pushed", remote: "personal", branch: "main" }
    ]);

    // Oracle: verify directly against every bare git repository.
    expect(await gitOk(["rev-parse", "HEAD"], w.checkout)).toBe(tip2);
    expect(await gitOk(["rev-parse", "refs/heads/main"], w.originBare)).toBe(tip2);
    expect(await gitOk(["rev-parse", "refs/heads/main"], w.personalBare)).toBe(tip2);
    expect(await gitOk(["rev-parse", "refs/heads/main"], w.readonlyBare)).toBe(w.initial);
    expect(tip1).not.toBe(tip2);
  });

  it("honors per-remote opt-out and catches up a re-enabled fork even when local main is already current", async () => {
    const w = await createMultiForkWorld();
    const disabled = await w.bus.dispatch("remote:setForkSyncRemote", {
      repoId: "repo-1",
      remote: "personal",
      enabled: false
    });
    expect(disabled).toEqual({ ok: true, value: { remote: "personal", enabled: false } });
    expect(readForkSyncPrefs(w.db, "repo-1").get("personal")).toBe(false);

    const tip = await commitFile(w.upstreamWork, "c.txt", "3\n", "upstream 3");
    await gitOk(["push", "origin", "main"], w.upstreamWork);
    await gitOk(["fetch", "upstream"], w.checkout);

    const synced = await w.bus.dispatch("remote:syncFork", {
      worktreeId: "wt-1",
      branch: "main",
      sourceRef: "refs/remotes/upstream/main",
      push: true
    });
    expect(synced.ok).toBe(true);
    if (!synced.ok) return;
    expect(synced.value.push).toEqual({ outcome: "pushed", remote: "origin", branch: "main" });
    expect(synced.value.pushes).toBeUndefined();
    expect(await gitOk(["rev-parse", "refs/heads/main"], w.originBare)).toBe(tip);
    expect(await gitOk(["rev-parse", "refs/heads/main"], w.personalBare)).toBe(w.initial);

    // Re-enable `personal`; local main & origin/main are already at `tip`,
    // yet syncing now fast-forwards `personal/main` too.
    await w.bus.dispatch("remote:setForkSyncRemote", {
      repoId: "repo-1",
      remote: "personal",
      enabled: true
    });
    const status = await w.bus.dispatch("remote:forkStatus", { worktreeId: "wt-1" });
    expect(status.ok && status.value?.source?.syncTargets?.[1]?.pushBack?.adds).toBe(1);

    const catchUp = await w.bus.dispatch("remote:syncFork", {
      worktreeId: "wt-1",
      branch: "main",
      sourceRef: "refs/remotes/upstream/main",
      push: true
    });
    expect(catchUp.ok).toBe(true);
    if (!catchUp.ok) return;
    expect(catchUp.value.arrived).toBe(0);
    expect(catchUp.value.pushes).toEqual([
      { outcome: "up_to_date", remote: "origin", branch: "main" },
      { outcome: "pushed", remote: "personal", branch: "main" }
    ]);
    expect(await gitOk(["rev-parse", "refs/heads/main"], w.personalBare)).toBe(tip);
  });

  it("never force-pushes a diverged sibling fork while still pushing the clean fork", async () => {
    const w = await createMultiForkWorld();
    // Push an unrelated commit to `personal/main` from a separate clone.
    const personalWork = join(w.root, "personal-work");
    await gitOk(["clone", w.personalBare, personalWork], w.root);
    const divergedTip = await commitFile(personalWork, "local-only.txt", "x\n", "fork-only");
    await gitOk(["push", "origin", "main"], personalWork);

    // Advance upstream.
    const upstreamTip = await commitFile(w.upstreamWork, "up.txt", "u\n", "upstream move");
    await gitOk(["push", "origin", "main"], w.upstreamWork);
    await gitOk(["fetch", "upstream"], w.checkout);

    const synced = await w.bus.dispatch("remote:syncFork", {
      worktreeId: "wt-1",
      branch: "main",
      sourceRef: "refs/remotes/upstream/main",
      push: true
    });
    expect(synced.ok).toBe(true);
    if (!synced.ok) return;
    expect(synced.value.pushes).toEqual([
      { outcome: "pushed", remote: "origin", branch: "main" },
      { outcome: "diverged", remote: "personal", branch: "main", overwrites: 1 }
    ]);
    // Oracle: origin updated, personal preserved intact.
    expect(await gitOk(["rev-parse", "refs/heads/main"], w.originBare)).toBe(upstreamTip);
    expect(await gitOk(["rev-parse", "refs/heads/main"], w.personalBare)).toBe(divergedTip);
  });

  it("refuses to push a sibling remote whose push URLs include another destination", async () => {
    const w = await createMultiForkWorld();
    const mirrorBare = join(w.root, "mirror.git");
    await gitOk(["clone", "--bare", w.upstreamBare, mirrorBare], w.root);
    urlRewrites.push([mirrorBare, "git@github.com:other/mirror.git"]);
    // Configure two push URLs on `personal`: the confirmed fork AND an extra mirror.
    await gitOk(
      ["config", "--add", "remote.personal.pushurl", "git@github.com:me/app.git"],
      w.checkout
    );
    await gitOk(
      ["config", "--add", "remote.personal.pushurl", "git@github.com:other/mirror.git"],
      w.checkout
    );

    const upstreamTip = await commitFile(w.upstreamWork, "sec.txt", "s\n", "upstream sec");
    await gitOk(["push", "origin", "main"], w.upstreamWork);
    await gitOk(["fetch", "upstream"], w.checkout);

    const synced = await w.bus.dispatch("remote:syncFork", {
      worktreeId: "wt-1",
      branch: "main",
      sourceRef: "refs/remotes/upstream/main",
      push: true
    });
    expect(synced.ok).toBe(true);
    if (!synced.ok) return;
    expect(synced.value.pushes).toEqual([
      { outcome: "pushed", remote: "origin", branch: "main" },
      expect.objectContaining({ outcome: "failed", remote: "personal", branch: "main" })
    ]);
    expect(await gitOk(["rev-parse", "refs/heads/main"], w.originBare)).toBe(upstreamTip);
    expect(await gitOk(["rev-parse", "refs/heads/main"], w.personalBare)).toBe(w.initial);
    expect(await gitOk(["rev-parse", "refs/heads/main"], mirrorBare)).toBe(w.initial);
  });

  it("does not create a non-default branch on a sibling fork that does not carry it", async () => {
    const w = await createMultiForkWorld();
    await gitOk(["checkout", "-b", "release/v1"], w.upstreamWork);
    await commitFile(w.upstreamWork, "rel.txt", "r1\n", "rel 1");
    await gitOk(["push", "origin", "release/v1"], w.upstreamWork);

    // Put release/v1 on origin too, but NOT on personal.
    await gitOk(["fetch", "upstream"], w.checkout);
    await gitOk(["checkout", "-b", "release/v1", "upstream/release/v1"], w.checkout);
    await gitOk(["push", "-u", "origin", "release/v1"], w.checkout);
    const relTip = await commitFile(w.upstreamWork, "rel2.txt", "r2\n", "rel 2");
    await gitOk(["push", "origin", "release/v1"], w.upstreamWork);
    await gitOk(["fetch", "upstream"], w.checkout);

    const status = await w.bus.dispatch("remote:forkStatus", { worktreeId: "wt-1" });
    expect(status.ok).toBe(true);
    if (!status.ok || status.value?.source == null) throw new Error("expected status");
    expect(status.value.source.syncTargets?.map((t) => t.remote)).toEqual(["origin"]);

    const synced = await w.bus.dispatch("remote:syncFork", {
      worktreeId: "wt-1",
      branch: "release/v1",
      sourceRef: "refs/remotes/upstream/release/v1",
      push: true
    });
    expect(synced.ok).toBe(true);
    expect(await gitOk(["rev-parse", "refs/heads/release/v1"], w.originBare)).toBe(relTip);
    const personalBranches = await gitOk(["for-each-ref", "--format=%(refname:short)", "refs/heads"], w.personalBare);
    expect(personalBranches.split("\n")).toEqual(["main"]);
  });

  it("enriches repo:refs remotes with fork sync eligibility and preference state", async () => {
    const w = await createMultiForkWorld();
    await w.bus.dispatch("remote:setForkSyncRemote", {
      repoId: "repo-1",
      remote: "personal",
      enabled: false
    });
    const refs = await w.bus.dispatch("repo:refs", { repoId: "repo-1" });
    expect(refs.ok).toBe(true);
    if (!refs.ok) return;
    const byName = new Map(refs.value.remotes.map((r) => [r.name, r]));
    expect(byName.get("origin")).toMatchObject({
      viewerCanPush: true,
      forkParent: "acme/app",
      forkSyncEligible: true,
      forkSyncEnabled: true
    });
    expect(byName.get("personal")).toMatchObject({
      viewerCanPush: true,
      forkParent: "acme/app",
      forkSyncEligible: true,
      forkSyncEnabled: false
    });
    expect(byName.get("coworker")).toMatchObject({
      viewerCanPush: false,
      forkParent: "acme/app"
    });
    expect(byName.get("coworker")?.forkSyncEligible).toBeUndefined();
    expect(byName.get("upstream")?.forkSyncEligible).toBeUndefined();
  });

  it("discovers and caches sibling remote identities via IdentityService and prunes removed remotes", async () => {
    const db = openDatabase(":memory:");
    dbs.push(db);
    db.prepare(`INSERT INTO profiles (id, name, email) VALUES ('p1', 'Dev', 'd@e.com')`).run();
    db.prepare(
      `INSERT INTO repos (id, profile_id, name, path, source)
       VALUES ('repo-1', 'p1', 't3code', '/tmp/t3code', 'manual')`
    ).run();

    let remotesOutput = [
      "origin\tgit@github.com:pwrdrvr/t3code.git (fetch)",
      "origin\tgit@github.com:pwrdrvr/t3code.git (push)",
      "upstream\tgit@github.com:pingdotgg/t3code.git (fetch)",
      "upstream\tgit@github.com:pingdotgg/t3code.git (push)",
      "huntharo\tgit@github.com:huntharo/t3code.git (fetch)",
      "huntharo\tgit@github.com:huntharo/t3code.git (push)"
    ].join("\n");

    const viewed: string[] = [];
    const provider = {
      viewRepo: vi.fn(async (slug: string): Promise<CloneRepository> => {
        viewed.push(slug);
        if (slug === "pwrdrvr/t3code") {
          return {
            host: "github",
            hostname: "github.com",
            owner: "pwrdrvr",
            name: "t3code",
            nameWithOwner: "pwrdrvr/t3code",
            visibility: "public",
            viewerCanPush: true,
            parent: { nameWithOwner: "pingdotgg/t3code", url: "https://github.com/pingdotgg/t3code" },
            sshUrl: "git@github.com:pwrdrvr/t3code.git",
            httpsUrl: "https://github.com/pwrdrvr/t3code",
            localPaths: []
          };
        }
        return {
          host: "github",
          hostname: "github.com",
          owner: "huntharo",
          name: "t3code",
          nameWithOwner: "huntharo/t3code",
          visibility: "public",
          viewerCanPush: true,
          parent: { nameWithOwner: "pingdotgg/t3code", url: "https://github.com/pingdotgg/t3code" },
          sshUrl: "git@github.com:huntharo/t3code.git",
          httpsUrl: "https://github.com/huntharo/t3code",
          localPaths: []
        };
      }),
      isAuthError: () => false,
      errorMessage: (e: unknown) => String(e)
    } as unknown as ForgeRepoProvider;

    const forges: ForgeRepoRegistry = {
      get: () => provider
    } as unknown as ForgeRepoRegistry;

    const service = new IdentityService(
      db,
      async () => ({ ok: true as const, value: { exitCode: 0, stdout: remotesOutput, stderr: "" } }),
      forges,
      {
        overrides: () => ({}),
        isEnabled: () => ({ enabled: true, source: "auto" })
      }
    );

    const repo = { id: "repo-1", profileId: "p1", name: "t3code", path: "/tmp/t3code" } as never;
    const changes = await service.refresh([repo]);
    expect(changes).toHaveLength(1);
    expect(viewed).toEqual(["pwrdrvr/t3code", "huntharo/t3code"]);
    expect(readRemoteIdentities(db, "repo-1")).toMatchObject([
      {
        hostname: "github.com",
        nameWithOwner: "huntharo/t3code",
        viewerCanPush: true,
        parent: "pingdotgg/t3code"
      }
    ]);

    // Remove the `huntharo` remote and force refresh: cached row is pruned.
    remotesOutput = [
      "origin\tgit@github.com:pwrdrvr/t3code.git (fetch)",
      "origin\tgit@github.com:pwrdrvr/t3code.git (push)",
      "upstream\tgit@github.com:pingdotgg/t3code.git (fetch)",
      "upstream\tgit@github.com:pingdotgg/t3code.git (push)"
    ].join("\n");
    const pruned = await service.refresh([repo], { force: true });
    expect(pruned).toHaveLength(1);
    expect(readRemoteIdentities(db, "repo-1")).toEqual([]);
  });
});
