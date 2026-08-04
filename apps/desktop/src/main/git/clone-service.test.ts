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
import { err, ok, type Result } from "@pwrgit/shared";
import { openDatabase } from "../persistence/db";
import { ProfileService } from "../profiles/profile-service";
import {
  cloneDestinations,
  CloneService,
  normalizeGitHubRepository,
  parseCloneRepositories
} from "./clone-service";
import type { GitExec, GitOutput } from "./dugite";
import { RepoIndexer } from "./repo-indexer";

const systemGit: GitExec = (args, cwd) =>
  new Promise<Result<GitOutput>>((resolve) => {
    const proc = spawn("git", args, { cwd });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    proc.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
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
  it("normalizes owner/name and parses GitHub CLI JSON", () => {
    expect(normalizeGitHubRepository(" pwrdrvr/PwrGit.git ")).toBe(
      "pwrdrvr/PwrGit"
    );
    expect(normalizeGitHubRepository("not-a-full-name")).toBeNull();
    expect(parseCloneRepositories("null")).toEqual([]);

    expect(
      parseCloneRepositories(
        JSON.stringify([
          {
            name: "PwrGit",
            nameWithOwner: "pwrdrvr/PwrGit",
            description: "Desktop git client",
            isPrivate: true,
            sshUrl: "git@github.com:pwrdrvr/PwrGit.git",
            url: "https://github.com/pwrdrvr/PwrGit",
            updatedAt: "2026-08-01T12:00:00Z"
          }
        ])
      )
    ).toEqual([
      {
        name: "PwrGit",
        owner: "pwrdrvr",
        nameWithOwner: "pwrdrvr/PwrGit",
        description: "Desktop git client",
        isPrivate: true,
        sshUrl: "git@github.com:pwrdrvr/PwrGit.git",
        httpsUrl: "https://github.com/pwrdrvr/PwrGit",
        updatedAt: "2026-08-01T12:00:00Z",
        localPaths: []
      }
    ]);
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
    const gh = vi.fn(async (args: string[]) => {
      const owner = args[2];
      return JSON.stringify([
        {
          name: "existing",
          nameWithOwner: `${owner}/existing`,
          isPrivate: false,
          sshUrl: `git@github.com:${owner}/existing.git`,
          url: `https://github.com/${owner}/existing`,
          updatedAt: "2026-08-01T12:00:00Z"
        }
      ]);
    });
    const service = new CloneService(
      db,
      systemGit,
      indexer,
      profiles,
      gh,
      async () => ({ installed: true, loggedIn: true })
    );

    const result = await service.catalog(profile.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.owners).toEqual(["pwrdrvr", "huntharo"]);
    expect(
      result.value.repositories.find(
        (repository) => repository.nameWithOwner === "pwrdrvr/existing"
      )?.localPaths
    ).toEqual([existingPath]);
    expect(gh).toHaveBeenCalledTimes(2);
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
    const gh = vi.fn(async () =>
      JSON.stringify({
        name: "x-code-clone",
        nameWithOwner: "huntharo/x-code-clone",
        description: "Exact lookup",
        isPrivate: false,
        sshUrl: "git@github.com:huntharo/x-code-clone.git",
        url: "https://github.com/huntharo/x-code-clone",
        updatedAt: "2026-08-04T12:00:00Z"
      })
    );
    const service = new CloneService(
      db,
      systemGit,
      indexer,
      profiles,
      gh,
      async () => ({ installed: true, loggedIn: true })
    );

    const result = await service.checkSource(
      profile.id,
      "huntharo/x-code-clone"
    );

    expect(result).toMatchObject({
      ok: true,
      value: { nameWithOwner: "huntharo/x-code-clone" }
    });
    expect(gh).toHaveBeenCalledWith([
      "repo",
      "view",
      "huntharo/x-code-clone",
      "--json",
      "name,nameWithOwner,description,isPrivate,sshUrl,url,updatedAt"
    ]);
  });

  it("clones with SSH, indexes the checkout, and records the chosen prefix", async () => {
    const root = temporaryRoot();
    const services = join(root, "services");
    mkdirSync(services, { recursive: true });
    const source = join(root, "source");
    initRepo(source);

    const cloneCalls: string[][] = [];
    const cloneGit: GitExec = async (args, cwd) => {
      if (args[0] === "clone") {
        cloneCalls.push(args);
        const destination = args.at(-1);
        if (destination === undefined) throw new Error("missing destination");
        return systemGit(["clone", "--", source, destination], cwd);
      }
      return systemGit(args, cwd);
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
      async () => "",
      async () => ({ installed: true, loggedIn: true })
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
        "--",
        "git@github.com:pwrdrvr/new-service.git",
        join(services, "new-service")
      ]
    ]);
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
    const gh = vi.fn(async () => "");
    const service = new CloneService(
      db,
      systemGit,
      indexer,
      profiles,
      gh,
      async () => ({ installed: true, loggedIn: true })
    );

    const result = await service.clone({
      profileId: profile.id,
      nameWithOwner: "huntharo/x-code-clone",
      protocol: "gh_cli",
      parentPath: root
    });

    expect(result).toEqual(ok(indexedRepo));
    expect(gh).toHaveBeenCalledWith(
      ["repo", "clone", "huntharo/x-code-clone", join(root, "x-code-clone")],
      { timeoutMs: 10 * 60_000 }
    );
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
    const service = new CloneService(db, gitExec, indexer, profiles);

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
