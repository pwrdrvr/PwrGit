import { execFileSync, spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { err, ok, type CloneProgress, type Result } from "@pwrgit/shared";
import { openDatabase } from "../persistence/db";
import { ProfileService } from "../profiles/profile-service";
import {
  cloneDestinations,
  CloneService,
  createCloneProgressParser,
  normalizeRepositoryPath,
  parseCloneProgressLine,
  sanitizeCloneStderr
} from "./clone-service";
import { ForgeRepoRegistry } from "../forge/repo-provider";
import { ForgeStatusService } from "../forge/status";
import { GitHubRepoProvider } from "../forge/github/repo-provider";
import { GitLabRepoProvider } from "../forge/gitlab/repo-provider";
import type { GitExec, GitExecOptions, GitOutput } from "./dugite";
import { RepoIndexer } from "./repo-indexer";

const systemGit: GitExec = (args, cwd, options) =>
  new Promise<Result<GitOutput>>((resolve) => {
    const proc = spawn("git", args, {
      cwd,
      env: { ...process.env, ...options?.env }
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      options?.onStderr?.(text);
    });
    proc.on("close", (code) =>
      resolve(ok({ stdout, stderr, exitCode: code ?? 0 }))
    );
    proc.on("error", (error) =>
      resolve(
        err({ kind: "git", code: "spawn_failed", message: error.message })
      )
    );
  });

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

/** A `gh` stand-in that answers the handful of calls GitHubRepoProvider makes.
 *  Tests override only the parts they care about; everything else responds
 *  the way a signed-in CLI would, so a test never fails on an unrelated call. */
function fakeGh(
  overrides: {
    login?: string;
    orgs?: string[];
    list?: (owner: string) => unknown[];
    view?: (nameWithOwner: string) => unknown;
    onCall?: (args: string[]) => void;
  } = {}
): (args: string[]) => Promise<string> {
  return async (args: string[]) => {
    overrides.onCall?.(args);
    if (args[0] === "--version") return "gh version 2.92.0";
    if (args[0] === "api" && args[1] === "user") {
      return JSON.stringify({ login: overrides.login ?? "huntharo" });
    }
    if (args[0] === "api" && args[1] === "user/orgs") {
      return JSON.stringify((overrides.orgs ?? []).map((login) => ({ login })));
    }
    if (args[0] === "api" && args[1]?.startsWith("repos/")) {
      const nameWithOwner = args[1].slice("repos/".length);
      return JSON.stringify(
        overrides.view?.(nameWithOwner) ?? {
          full_name: nameWithOwner,
          name: nameWithOwner.slice(nameWithOwner.lastIndexOf("/") + 1),
          visibility: "public",
          ssh_url: `git@github.com:${nameWithOwner}.git`,
          html_url: `https://github.com/${nameWithOwner}`
        }
      );
    }
    if (args[0] === "repo" && args[1] === "list") {
      return JSON.stringify(overrides.list?.(args[2] ?? "") ?? []);
    }
    return "";
  };
}

/** Forge availability with no subprocesses: GitHub usable, GitLab absent.
 *  Without this the service falls back to the real probes and the suite starts
 *  depending on whether the machine running it has `gh`/`glab` signed in. */
function fakeForgeStatus(): ForgeStatusService {
  return new ForgeStatusService({
    probes: [
      {
        kind: "github",
        cli: "gh",
        installed: async () => true,
        loggedIn: async () => true
      },
      {
        kind: "gitlab",
        cli: "glab",
        installed: async () => false,
        loggedIn: async () => false
      }
    ]
  });
}

/** A registry holding only GitHub, backed by the given runner. GitLab is
 *  registered with a runner that reports "not installed", which is what a
 *  machine without `glab` looks like. */
function githubOnly(gh: (args: string[]) => Promise<string>): ForgeRepoRegistry {
  const registry = new ForgeRepoRegistry();
  registry.register(new GitHubRepoProvider(gh));
  registry.register(
    new GitLabRepoProvider(async () => {
      throw new Error("spawn glab ENOENT");
    })
  );
  return registry;
}

function initRepo(path: string): void {
  mkdirSync(path, { recursive: true });
  git(path, "init", "-b", "main");
  git(path, "config", "user.email", "test@pwrgit.dev");
  git(path, "config", "user.name", "PwrGit Test");
  writeFileSync(join(path, "README.md"), "# test\n");
  git(path, "add", ".");
  git(path, "commit", "-m", "initial");
}

const temporaryPaths: string[] = [];
function temporaryRoot(): string {
  const path = realpathSync.native(mkdtempSync(join(tmpdir(), "pwrgit-clone-")));
  temporaryPaths.push(path);
  return path;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("clone source metadata", () => {
  it("normalizes a repository path, including a GitLab subgroup", () => {
    expect(normalizeRepositoryPath(" pwrdrvr/PwrGit.git ")).toBe(
      "pwrdrvr/PwrGit"
    );
    expect(normalizeRepositoryPath("acme/platform/team/api")).toBe(
      "acme/platform/team/api"
    );
    expect(normalizeRepositoryPath("not-a-full-name")).toBeNull();
    // A path segment that could be read as a flag or an option must not
    // survive: it is interpolated into a git remote URL.
    expect(normalizeRepositoryPath("--upload-pack=evil/x")).toBeNull();
    expect(normalizeRepositoryPath("a/../../etc/passwd")).toBeNull();
  });
});

describe("clone progress", () => {
  it("parses transfer totals and rates from Git progress", () => {
    expect(
      parseCloneProgressLine(
        "Receiving objects:  42% (420/1000), 12.34 MiB | 3.10 MiB/s"
      )
    ).toEqual({
      phase: "receiving",
      percent: 42,
      completedObjects: 420,
      totalObjects: 1000,
      bytesReceived: "12.34 MiB",
      transferRate: "3.10 MiB/s"
    });
  });

  it("reassembles chunked carriage-return progress", () => {
    const updates: CloneProgress[] = [];
    const parse = createCloneProgressParser((progress) =>
      updates.push(progress)
    );
    parse("remote: Counting objects: 50% (5/");
    parse("10)\rReceiving objects: 100% (10/10), 2.00 KiB | 2.00 MiB/s\r");
    expect(updates).toEqual([
      {
        phase: "counting",
        percent: 50,
        completedObjects: 5,
        totalObjects: 10
      },
      {
        phase: "receiving",
        percent: 100,
        completedObjects: 10,
        totalObjects: 10,
        bytesReceived: "2.00 KiB",
        transferRate: "2.00 MiB/s"
      }
    ]);
  });

  it("removes progress records from clone failures", () => {
    expect(
      sanitizeCloneStderr(
        "Cloning into 'repo'...\n" +
          "remote: Enumerating objects: 10, done.\n" +
          "remote: Counting objects: 50% (5/10)\r" +
          "Receiving objects: 90% (9/10), 1.00 MiB | 2.00 MiB/s\r" +
          "remote: Repository not found.\n" +
          "fatal: Could not read from remote repository.\n"
      )
    ).toBe(
      "remote: Repository not found.\nfatal: Could not read from remote repository."
    );
  });
});

describe("clone destinations", () => {
  it("detects nested prefix folders at every depth and promotes an MRU", async () => {
    const root = temporaryRoot();
    const repoPath = join(root, "search", "services", "existing");
    initRepo(repoPath);
    const db = openDatabase(":memory:");
    const profiles = new ProfileService(db);
    const profile = profiles.create({
      name: "PwrDrvr",
      email: "test@pwrgit.dev",
      roots: [root]
    });
    const indexer = new RepoIndexer(db, systemGit);
    const indexed = await indexer.indexRepoAt(profile.id, repoPath);
    expect(indexed.ok).toBe(true);

    const initial = cloneDestinations(db, profile, indexer.listRepos(profile.id));
    expect(initial.map((destination) => destination.path)).toEqual(
      expect.arrayContaining([
        root,
        join(root, "search"),
        join(root, "search", "services")
      ])
    );

    db.prepare(
      `INSERT INTO clone_destinations (profile_id, path, last_used_at)
       VALUES (?, ?, ?)`
    ).run(profile.id, join(root, "search", "services"), "2026-08-04 12:00:00");
    const withRecent = cloneDestinations(
      db,
      profile,
      indexer.listRepos(profile.id)
    );
    expect(withRecent[0]).toMatchObject({
      path: join(root, "search", "services"),
      relativePath: join("search", "services"),
      lastUsedAt: "2026-08-04 12:00:00"
    });

    const missingRecent = join(root, "removed");
    db.prepare(
      `INSERT INTO clone_destinations (profile_id, path, last_used_at)
       VALUES (?, ?, ?)`
    ).run(profile.id, missingRecent, "2026-08-05 12:00:00");
    const priority = cloneDestinations(db, profile, []);
    expect(priority.map((destination) => destination.path)).toEqual([
      join(root, "search", "services"),
      root
    ]);
    expect(priority).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: join(root, "search") })
      ])
    );
  });
});

describe("CloneService", () => {
  it("loads profile org and existing remote owners, then marks local checkouts", async () => {
    const root = temporaryRoot();
    const existingPath = join(root, "services", "existing");
    initRepo(existingPath);
    git(
      existingPath,
      "remote",
      "add",
      "origin",
      "git@github.com:pwrdrvr/existing.git"
    );
    git(
      existingPath,
      "remote",
      "add",
      "upstream",
      "https://github.com/huntharo/existing.git"
    );

    const db = openDatabase(":memory:");
    const profiles = new ProfileService(db);
    const profile = profiles.create({
      name: "PwrDrvr",
      email: "test@pwrgit.dev",
      org: "pwrdrvr",
      roots: [root]
    });
    const indexer = new RepoIndexer(db, systemGit);
    await indexer.indexRepoAt(profile.id, existingPath);
    const listed: string[] = [];
    const gh = vi.fn(
      fakeGh({
        onCall: (args) => {
          if (args[0] === "repo" && args[1] === "list") listed.push(args[2]!);
        },
        list: (owner) => [
          {
            name: "existing",
            nameWithOwner: `${owner}/existing`,
            visibility: "PUBLIC",
            sshUrl: `git@github.com:${owner}/existing.git`,
            url: `https://github.com/${owner}/existing`,
            updatedAt: "2026-08-01T12:00:00Z"
          }
        ]
      })
    );
    const service = new CloneService(
      db,
      systemGit,
      indexer,
      profiles,
      githubOnly(gh),
      fakeForgeStatus()
    );

    const result = await service.catalog(profile.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.owners.map((owner) => owner.login)).toEqual([
      "pwrdrvr",
      "huntharo"
    ]);
    expect(
      result.value.repositories.find(
        (repository) => repository.nameWithOwner === "pwrdrvr/existing"
      )?.localPaths
    ).toEqual([existingPath]);
    // One listing per distinct owner — the profile org duplicates `pwrdrvr`,
    // which is deduped rather than fetched twice.
    expect(listed.sort()).toEqual(["huntharo", "pwrdrvr"]);
  });

  it("reports both forges, so a dialog can say which CLI is missing", async () => {
    const root = temporaryRoot();
    const db = openDatabase(":memory:");
    const profiles = new ProfileService(db);
    const profile = profiles.create({
      name: "Personal",
      email: "test@pwrgit.dev",
      roots: [root]
    });
    const service = new CloneService(
      db,
      systemGit,
      new RepoIndexer(db, systemGit),
      profiles,
      githubOnly(fakeGh()),
      fakeForgeStatus()
    );

    const result = await service.catalog(profile.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.value.forges.map(({ kind, cli, installed, loggedIn }) => ({
        kind,
        cli,
        installed,
        loggedIn
      }))
    ).toEqual([
      { kind: "github", cli: "gh", installed: true, loggedIn: true },
      { kind: "gitlab", cli: "glab", installed: false, loggedIn: false }
    ]);
    // The catalog's owners are whose repositories to offer — from local
    // remotes and the profile org. Fork targets are a different question and
    // have their own command (`repo:forkTargets`), so a profile with no repos
    // and no org lists nobody here.
    expect(result.value.owners).toEqual([]);
  });

  it("checks an exact owner/name that is outside the known owner catalogs", async () => {
    const root = temporaryRoot();
    const db = openDatabase(":memory:");
    const profiles = new ProfileService(db);
    const profile = profiles.create({
      name: "Personal",
      email: "test@pwrgit.dev",
      roots: [root]
    });
    const indexer = new RepoIndexer(db, systemGit);
    const calls: string[][] = [];
    const gh = vi.fn(
      fakeGh({
        onCall: (args) => calls.push(args),
        view: (nameWithOwner) => ({
          full_name: nameWithOwner,
          name: "x-code-clone",
          description: "Exact lookup",
          visibility: "private",
          fork: true,
          parent: {
            full_name: "upstream/x-code-clone",
            html_url: "https://github.com/upstream/x-code-clone"
          },
          source: {
            full_name: "root/x-code-clone",
            html_url: "https://github.com/root/x-code-clone"
          },
          ssh_url: "git@github.com:huntharo/x-code-clone.git",
          html_url: "https://github.com/huntharo/x-code-clone",
          updated_at: "2026-08-04T12:00:00Z"
        })
      })
    );
    const service = new CloneService(
      db,
      systemGit,
      indexer,
      profiles,
      githubOnly(gh),
      fakeForgeStatus()
    );

    const result = await service.checkSource(
      profile.id,
      "huntharo/x-code-clone"
    );

    // Visibility and fork lineage both come back from the one REST read —
    // `source` is the only GitHub response that carries the network root.
    expect(result).toMatchObject({
      ok: true,
      value: {
        nameWithOwner: "huntharo/x-code-clone",
        visibility: "private",
        host: "github",
        hostname: "github.com",
        parent: { nameWithOwner: "upstream/x-code-clone" },
        root: { nameWithOwner: "root/x-code-clone" }
      }
    });
    expect(calls).toContainEqual(["api", "repos/huntharo/x-code-clone"]);
  });

  it("does not record a root that merely repeats the parent", async () => {
    const root = temporaryRoot();
    const db = openDatabase(":memory:");
    const profiles = new ProfileService(db);
    const profile = profiles.create({
      name: "Personal",
      email: "test@pwrgit.dev",
      roots: [root]
    });
    const service = new CloneService(
      db,
      systemGit,
      new RepoIndexer(db, systemGit),
      profiles,
      githubOnly(
        fakeGh({
          view: (nameWithOwner) => ({
            full_name: nameWithOwner,
            name: "react",
            visibility: "public",
            fork: true,
            parent: { full_name: "facebook/react" },
            source: { full_name: "facebook/react" }
          })
        })
      )
    );

    const result = await service.checkSource(profile.id, "huntharo/react");

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    // A fork of a source repo has parent === source. Recording `root` there
    // would make every ordinary fork look like it had an ambiguous upstream.
    expect(result.value.parent?.nameWithOwner).toBe("facebook/react");
    expect(result.value.root).toBeUndefined();
  });

  it("maps expired GitHub CLI authentication during lookup", async () => {
    const root = temporaryRoot();
    const db = openDatabase(":memory:");
    const profiles = new ProfileService(db);
    const profile = profiles.create({
      name: "Personal",
      email: "test@pwrgit.dev",
      roots: [root]
    });
    const indexer = new RepoIndexer(db, systemGit);
    const gh = vi.fn(async (args: string[]) => {
      if (args[0] === "--version") return "gh version 2.92.0";
      if (args[0] === "api" && args[1] === "user") {
        return JSON.stringify({ login: "huntharo" });
      }
      if (args[0] === "api" && args[1] === "user/orgs") return "[]";
      const failure = new Error("HTTP 401: Bad credentials") as Error & {
        stderr?: string;
      };
      failure.stderr =
        "GH_TOKEN=github_pat_secretShouldNotLeak run gh auth login";
      throw failure;
    });
    const service = new CloneService(
      db,
      systemGit,
      indexer,
      profiles,
      githubOnly(gh),
      fakeForgeStatus()
    );

    const result = await service.checkSource(profile.id, "huntharo/private");

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "remote",
        code: "forge_login_required",
        message:
          "GitHub authentication is required. Run gh auth login and verify your Git/SSH credentials, then try again."
      }
    });
    expect(JSON.stringify(result)).not.toContain("secretShouldNotLeak");
  });

  it("surfaces authentication expiry instead of flattening catalog failures", async () => {
    const root = temporaryRoot();
    const db = openDatabase(":memory:");
    const profiles = new ProfileService(db);
    const profile = profiles.create({
      name: "PwrDrvr",
      email: "test@pwrgit.dev",
      org: "pwrdrvr",
      roots: [root]
    });
    const indexer = new RepoIndexer(db, systemGit);
    const service = new CloneService(
      db,
      systemGit,
      indexer,
      profiles,
      githubOnly(async (args: string[]) => {
        if (args[0] === "--version") return "gh version 2.92.0";
        if (args[0] === "api" && args[1] === "user") {
          return JSON.stringify({ login: "huntharo" });
        }
        if (args[0] === "api" && args[1] === "user/orgs") return "[]";
        throw new Error("not logged into any GitHub hosts; run gh auth login");
      })
    );

    const result = await service.catalog(profile.id);

    expect(result).toMatchObject({
      ok: true,
      value: {
        warning:
          "GitHub authentication is required. Run gh auth login and verify your Git/SSH credentials, then try again."
      }
    });
  });

  it("clones with SSH, indexes the checkout, and records the chosen prefix", async () => {
    const root = temporaryRoot();
    const services = join(root, "services");
    mkdirSync(services, { recursive: true });
    const source = join(root, "source");
    initRepo(source);

    const cloneCalls: string[][] = [];
    const cloneOptions: GitExecOptions[] = [];
    const cloneGit: GitExec = async (args, cwd, options) => {
      if (args[0] === "clone") {
        cloneCalls.push(args);
        if (options !== undefined) cloneOptions.push(options);
        const destination = args.at(-1);
        if (destination === undefined) throw new Error("missing destination");
        return systemGit(["clone", "--", source, destination], cwd, options);
      }
      return systemGit(args, cwd, options);
    };
    const db = openDatabase(":memory:");
    const profiles = new ProfileService(db);
    const profile = profiles.create({
      name: "PwrDrvr",
      email: "test@pwrgit.dev",
      roots: [root]
    });
    const indexer = new RepoIndexer(db, cloneGit);
    const service = new CloneService(
      db,
      cloneGit,
      indexer,
      profiles,
      githubOnly(fakeGh()),
      fakeForgeStatus()
    );

    const result = await service.clone({
      profileId: profile.id,
      nameWithOwner: "pwrdrvr/new-service",
      protocol: "ssh",
      parentPath: services
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.path).toBe(join(services, "new-service"));
    expect(cloneCalls).toEqual([
      [
        "clone",
        "--progress",
        "--",
        "git@github.com:pwrdrvr/new-service.git",
        join(services, "new-service")
      ]
    ]);
    expect(cloneOptions[0]?.env).toEqual({ LC_ALL: "C", LANG: "C" });
    expect(
      db
        .prepare(
          "SELECT path FROM clone_destinations WHERE profile_id = ?"
        )
        .get(profile.id)
    ).toEqual({ path: services });
  });

  it("uses GitHub CLI when that clone method is selected", async () => {
    const root = temporaryRoot();
    const db = openDatabase(":memory:");
    const profiles = new ProfileService(db);
    const profile = profiles.create({
      name: "Personal",
      email: "test@pwrgit.dev",
      roots: [root]
    });
    const indexedRepo = {
      id: "checked-repo",
      name: "x-code-clone",
      path: join(root, "x-code-clone"),
      profileId: profile.id,
      pinned: false,
      worktrees: []
    };
    const indexer = {
      listRepos: vi.fn(() => []),
      indexRepoAt: vi.fn(async () => ok(indexedRepo))
    } as unknown as RepoIndexer;
    const gh = vi.fn(fakeGh());
    const service = new CloneService(
      db,
      systemGit,
      indexer,
      profiles,
      githubOnly(gh),
      fakeForgeStatus()
    );

    const result = await service.clone({
      profileId: profile.id,
      nameWithOwner: "huntharo/x-code-clone",
      protocol: "cli",
      parentPath: root
    });

    expect(result).toEqual(ok(indexedRepo));
    expect(gh).toHaveBeenCalledWith(
      [
        "repo",
        "clone",
        "huntharo/x-code-clone",
        join(root, "x-code-clone"),
        "--",
        "--progress"
      ],
      {
        timeoutMs: 10 * 60_000,
        onStderr: expect.any(Function),
        env: { LC_ALL: "C", LANG: "C" }
      }
    );
  });

  it("returns direct clone failures without progress records", async () => {
    const root = temporaryRoot();
    const db = openDatabase(":memory:");
    const profiles = new ProfileService(db);
    const profile = profiles.create({
      name: "Personal",
      email: "test@pwrgit.dev",
      roots: [root]
    });
    const gitExec = vi.fn<GitExec>(async () =>
      ok({
        stdout: "",
        stderr:
          "Cloning into 'missing'...\n" +
          "Receiving objects: 50% (5/10), 1.00 MiB | 2.00 MiB/s\r" +
          "remote: Repository not found.\n" +
          "fatal: Could not read from remote repository.\n",
        exitCode: 128
      })
    );
    const indexer = {
      listRepos: vi.fn(() => []),
      indexRepoAt: vi.fn()
    } as unknown as RepoIndexer;
    const service = new CloneService(
      db,
      gitExec,
      indexer,
      profiles,
      githubOnly(fakeGh()),
      fakeForgeStatus()
    );

    const result = await service.clone({
      profileId: profile.id,
      nameWithOwner: "huntharo/missing",
      protocol: "ssh",
      parentPath: root
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "exit_128",
        message:
          "remote: Repository not found.\nfatal: Could not read from remote repository."
      }
    });
    expect(gitExec).toHaveBeenCalledWith(
      expect.any(Array),
      root,
      expect.objectContaining({ env: { LC_ALL: "C", LANG: "C" } })
    );
    expect(indexer.indexRepoAt).not.toHaveBeenCalled();
  });

  it("maps GitHub CLI clone authentication without leaking credentials", async () => {
    const root = temporaryRoot();
    const db = openDatabase(":memory:");
    const profiles = new ProfileService(db);
    const profile = profiles.create({
      name: "Personal",
      email: "test@pwrgit.dev",
      roots: [root]
    });
    const secret = "gho_secretShouldNotLeak";
    const gh = vi.fn(async () => {
      const failure = new Error("clone failed") as Error & { stderr?: string };
      failure.stderr = `fatal: could not read Username for 'https://github.com': terminal prompts disabled ${secret}`;
      throw failure;
    });
    const indexer = {
      listRepos: vi.fn(() => []),
      indexRepoAt: vi.fn()
    } as unknown as RepoIndexer;
    const service = new CloneService(
      db,
      systemGit,
      indexer,
      profiles,
      githubOnly(gh),
      fakeForgeStatus()
    );

    const result = await service.clone({
      profileId: profile.id,
      nameWithOwner: "huntharo/private",
      protocol: "cli",
      parentPath: root
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: "remote",
        code: "forge_login_required",
        message:
          "GitHub authentication is required. Run gh auth login and verify your Git/SSH credentials, then try again."
      }
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(indexer.indexRepoAt).not.toHaveBeenCalled();
  });

  it("rejects destinations outside registered roots before running git", async () => {
    const root = temporaryRoot();
    const outside = temporaryRoot();
    const db = openDatabase(":memory:");
    const profiles = new ProfileService(db);
    const profile = profiles.create({
      name: "PwrDrvr",
      email: "test@pwrgit.dev",
      roots: [root]
    });
    const gitExec = vi.fn<GitExec>(systemGit);
    const indexer = new RepoIndexer(db, gitExec);
    const service = new CloneService(
      db,
      gitExec,
      indexer,
      profiles,
      githubOnly(fakeGh()),
      fakeForgeStatus()
    );

    const result = await service.clone({
      profileId: profile.id,
      nameWithOwner: "pwrdrvr/nope",
      protocol: "https",
      parentPath: outside
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "destination_outside_roots" }
    });
    expect(gitExec).not.toHaveBeenCalled();
  });
});
