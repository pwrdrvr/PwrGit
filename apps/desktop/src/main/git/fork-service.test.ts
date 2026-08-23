import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { err, ok, type CloneRepository, type Result } from "@pwrgit/shared";
import { openDatabase } from "../persistence/db";
import { ProfileService } from "../profiles/profile-service";
import { ForgeRepoRegistry } from "../forge/repo-provider";
import { GitHubRepoProvider } from "../forge/github/repo-provider";
import { GitLabRepoProvider } from "../forge/gitlab/repo-provider";
import { CloneService } from "./clone-service";
import {
  ForkService,
  isForkOf,
  upstreamChoicesFor,
  UPSTREAM_REMOTE
} from "./fork-service";
import type { GitExec, GitOutput } from "./dugite";
import { RepoIndexer } from "./repo-indexer";
import { ForgeStatusService } from "../forge/status";

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
      resolve(err({ kind: "git", code: "spawn_failed", message: error.message }))
    );
  });

/** Forge availability with no subprocesses. Without this the services fall
 *  back to the real probes and the suite starts depending on whether the
 *  machine running it has `gh`/`glab` installed and signed in — which is
 *  exactly how these passed locally and failed on CI. */
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

const created: string[] = [];
function temporaryRoot(): string {
  const path = realpathSync.native(mkdtempSync(join(tmpdir(), "pwrgit-fork-")));
  created.push(path);
  return path;
}
afterEach(() => {
  while (created.length > 0) {
    rmSync(created.pop()!, { recursive: true, force: true });
  }
});

function initRepo(path: string): void {
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: path, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "t@pwrgit.dev"], {
    cwd: path,
    stdio: "ignore"
  });
  execFileSync("git", ["config", "user.name", "T"], {
    cwd: path,
    stdio: "ignore"
  });
  writeFileSync(join(path, "README.md"), "# test\n");
  execFileSync("git", ["add", "."], { cwd: path, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: path, stdio: "ignore" });
}

const repo = (over: Partial<CloneRepository> = {}): CloneRepository => ({
  name: "react",
  owner: "facebook",
  nameWithOwner: "facebook/react",
  visibility: "public",
  host: "github",
  hostname: "github.com",
  sshUrl: "git@github.com:facebook/react.git",
  httpsUrl: "https://github.com/facebook/react.git",
  localPaths: [],
  ...over
});

describe("upstreamChoicesFor", () => {
  it("offers only the source when it is not a fork", () => {
    // One choice is not a question; the dialog must not ask one.
    expect(upstreamChoicesFor(repo())).toEqual([
      {
        nameWithOwner: "facebook/react",
        url: "https://github.com/facebook/react"
      }
    ]);
  });

  it("puts the network root first when the source is a fork of a fork", () => {
    const choices = upstreamChoicesFor(
      repo({
        nameWithOwner: "someone/react",
        owner: "someone",
        parent: { nameWithOwner: "gaearon/react", url: "" },
        root: { nameWithOwner: "facebook/react", url: "" }
      })
    );
    expect(choices.map((choice) => choice.nameWithOwner)).toEqual([
      "facebook/react",
      "gaearon/react",
      "someone/react"
    ]);
  });

  it("deduplicates when the parent is the root", () => {
    const choices = upstreamChoicesFor(
      repo({
        nameWithOwner: "gaearon/react",
        owner: "gaearon",
        parent: { nameWithOwner: "facebook/react", url: "" }
      })
    );
    expect(choices.map((choice) => choice.nameWithOwner)).toEqual([
      "facebook/react",
      "gaearon/react"
    ]);
  });
});

describe("isForkOf", () => {
  const source = repo();

  it("recognizes a direct fork", () => {
    expect(
      isForkOf(
        repo({
          nameWithOwner: "huntharo/react",
          parent: { nameWithOwner: "facebook/react", url: "" }
        }),
        source
      )
    ).toBe(true);
  });

  it("recognizes a fork that shares the source's root", () => {
    // Forking a fork puts the new repo under the picked repo but leaves the
    // root pointing at the original.
    expect(
      isForkOf(
        repo({
          nameWithOwner: "huntharo/react",
          parent: { nameWithOwner: "gaearon/react", url: "" },
          root: { nameWithOwner: "facebook/react", url: "" }
        }),
        repo({
          nameWithOwner: "gaearon/react",
          parent: { nameWithOwner: "facebook/react", url: "" }
        })
      )
    ).toBe(true);
  });

  it("does not mistake an unrelated namesake for your fork", () => {
    // This is the one that matters: offering "clone your fork" for a
    // stranger's same-named repo would check out the wrong code.
    expect(isForkOf(repo({ nameWithOwner: "huntharo/react" }), source)).toBe(
      false
    );
  });
});

/** A `gh` stand-in covering the calls the fork path makes. */
function fakeGh(
  repos: Record<string, unknown>,
  onCall?: (args: string[]) => void
) {
  return async (args: string[]) => {
    onCall?.(args);
    if (args[0] === "--version") return "gh version 2.92.0";
    if (args.join(" ") === "api user") return '{"login":"huntharo"}';
    if (args[1] === "user/orgs") return '[{"login":"pwr-family"}]';
    if (args[1]?.startsWith("repos/")) {
      const slug = args[1].slice("repos/".length);
      const found = repos[slug];
      if (found === undefined) throw new Error(`404 Not Found: ${slug}`);
      return JSON.stringify(found);
    }
    return "";
  };
}

function services(): {
  root: string;
  forks: ForkService;
  profileId: string;
  parentPath: string;
  gh: ReturnType<typeof vi.fn>;
} {
  const root = temporaryRoot();
  const parentPath = join(root, "forks");
  mkdirSync(parentPath, { recursive: true });
  const db = openDatabase(":memory:");
  const profiles = new ProfileService(db);
  const profile = profiles.create({
    name: "Personal",
    email: "t@pwrgit.dev",
    roots: [root]
  });
  const indexer = new RepoIndexer(db, systemGit);
  const gh = vi.fn(
    fakeGh({
      "facebook/react": {
        full_name: "facebook/react",
        name: "react",
        visibility: "public"
      },
      // The fork `provider.fork()` reads back after creating it.
      "huntharo/react": {
        full_name: "huntharo/react",
        name: "react",
        visibility: "public",
        fork: true,
        parent: { full_name: "facebook/react" }
      }
    })
  );
  const registry = new ForgeRepoRegistry();
  registry.register(new GitHubRepoProvider(gh));
  const clones = new CloneService(db, systemGit, indexer, profiles, registry, fakeForgeStatus());
  return {
    root,
    parentPath,
    profileId: profile.id,
    gh,
    forks: new ForkService(systemGit, indexer, profiles, registry, clones, fakeForgeStatus())
  };
}

describe("ForkService.preflight", () => {
  it("answers the target and upstream before anything is created", async () => {
    const { forks, profileId } = services();
    const result = await forks.preflight({
      profileId,
      source: "facebook/react",
      host: "github"
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        target: { owner: "huntharo", nameWithOwner: "huntharo/react" },
        upstreamChoices: [{ nameWithOwner: "facebook/react" }]
      }
    });
  });

  it("blocks forking a repository into the account that owns it", async () => {
    const { forks, profileId } = services();
    const result = await forks.preflight({
      profileId,
      source: "facebook/react",
      host: "github",
      targetOwner: "facebook"
    });
    expect(result).toMatchObject({
      ok: true,
      value: { blocked: { code: "self_owned" } }
    });
  });

  it("reports a missing CLI as blocked, not as a lookup failure", async () => {
    const { forks, profileId } = services();
    const result = await forks.preflight({
      profileId,
      source: "acme/api",
      host: "gitlab"
    });
    expect(result).toMatchObject({
      ok: true,
      value: { blocked: { code: "unsupported_host" } }
    });
  });

  it("recognizes an existing fork of the source", async () => {
    const root = temporaryRoot();
    const db = openDatabase(":memory:");
    const profiles = new ProfileService(db);
    const profile = profiles.create({
      name: "Personal",
      email: "t@pwrgit.dev",
      roots: [root]
    });
    const registry = new ForgeRepoRegistry();
    registry.register(
      new GitHubRepoProvider(
        fakeGh({
          "facebook/react": { full_name: "facebook/react", visibility: "public" },
          "huntharo/react": {
            full_name: "huntharo/react",
            visibility: "public",
            fork: true,
            parent: { full_name: "facebook/react" }
          }
        })
      )
    );
    const indexer = new RepoIndexer(db, systemGit);
    const forks = new ForkService(
      systemGit,
      indexer,
      profiles,
      registry,
      new CloneService(db, systemGit, indexer, profiles, registry, fakeForgeStatus()),
      fakeForgeStatus()
    );

    const result = await forks.preflight({
      profileId: profile.id,
      source: "facebook/react",
      host: "github"
    });

    expect(result).toMatchObject({
      ok: true,
      value: { existing: { nameWithOwner: "huntharo/react" } }
    });
  });

  it("does not claim a prefix-sharing checkout as the fork's location", async () => {
    const root = temporaryRoot();
    // `huntharo/react` is a substring of `huntharo/react-native`; matching the
    // remote URL by substring would point "Reveal checkout" at this repo.
    const decoy = join(root, "react-native");
    initRepo(decoy);
    execFileSync(
      "git",
      ["remote", "add", "origin", "git@github.com:huntharo/react-native.git"],
      { cwd: decoy, stdio: "ignore" }
    );
    const db = openDatabase(":memory:");
    const profiles = new ProfileService(db);
    const profile = profiles.create({
      name: "Personal",
      email: "t@pwrgit.dev",
      roots: [root]
    });
    const indexer = new RepoIndexer(db, systemGit);
    await indexer.indexRepoAt(profile.id, decoy);
    const registry = new ForgeRepoRegistry();
    registry.register(
      new GitHubRepoProvider(
        fakeGh({
          "facebook/react": { full_name: "facebook/react", visibility: "public" },
          "huntharo/react": {
            full_name: "huntharo/react",
            visibility: "public",
            fork: true,
            parent: { full_name: "facebook/react" }
          }
        })
      )
    );
    const forks = new ForkService(
      systemGit,
      indexer,
      profiles,
      registry,
      new CloneService(db, systemGit, indexer, profiles, registry, fakeForgeStatus()),
      fakeForgeStatus()
    );

    const result = await forks.preflight({
      profileId: profile.id,
      source: "facebook/react",
      host: "github"
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.existing?.nameWithOwner).toBe("huntharo/react");
    expect(result.value.existing?.localPaths).toEqual([]);
  });

  it("checks the fork name the user actually typed", async () => {
    const probed: string[] = [];
    const root = temporaryRoot();
    const db = openDatabase(":memory:");
    const profiles = new ProfileService(db);
    const profile = profiles.create({
      name: "Personal",
      email: "t@pwrgit.dev",
      roots: [root]
    });
    const registry = new ForgeRepoRegistry();
    registry.register(
      new GitHubRepoProvider(
        fakeGh(
          {
            "facebook/react": {
              full_name: "facebook/react",
              name: "react",
              visibility: "public"
            },
            // The user's pre-existing fork, under the DEFAULT name.
            "huntharo/react": {
              full_name: "huntharo/react",
              visibility: "public",
              fork: true,
              parent: { full_name: "facebook/react" }
            }
          },
          (args) => {
            if (args[1]?.startsWith("repos/")) {
              probed.push(args[1].slice("repos/".length));
            }
          }
        )
      )
    );
    const indexer = new RepoIndexer(db, systemGit);
    const forks = new ForkService(
      systemGit,
      indexer,
      profiles,
      registry,
      new CloneService(db, systemGit, indexer, profiles, registry, fakeForgeStatus()),
      fakeForgeStatus()
    );

    const result = await forks.preflight({
      profileId: profile.id,
      source: "facebook/react",
      host: "github",
      targetName: "react-fork"
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.target.nameWithOwner).toBe("huntharo/react-fork");
    // The existing `huntharo/react` is NOT this fork: reporting it would make
    // the dialog offer to reveal/clone a repository the user did not ask for.
    expect(result.value.existing).toBeUndefined();
    expect(probed).toContain("huntharo/react-fork");
    expect(probed).not.toContain("huntharo/react");
  });

  it("refuses a name taken by an unrelated repository", async () => {
    const root = temporaryRoot();
    const db = openDatabase(":memory:");
    const profiles = new ProfileService(db);
    const profile = profiles.create({
      name: "Personal",
      email: "t@pwrgit.dev",
      roots: [root]
    });
    const registry = new ForgeRepoRegistry();
    registry.register(
      new GitHubRepoProvider(
        fakeGh({
          "facebook/react": { full_name: "facebook/react", visibility: "public" },
          // Same name, not a fork of it — cloning this would be wrong code.
          "huntharo/react": { full_name: "huntharo/react", visibility: "public" }
        })
      )
    );
    const indexer = new RepoIndexer(db, systemGit);
    const forks = new ForkService(
      systemGit,
      indexer,
      profiles,
      registry,
      new CloneService(db, systemGit, indexer, profiles, registry, fakeForgeStatus()),
      fakeForgeStatus()
    );

    const result = await forks.preflight({
      profileId: profile.id,
      source: "facebook/react",
      host: "github"
    });

    expect(result).toMatchObject({
      ok: true,
      value: { blocked: { code: "forking_disabled" } }
    });
    // Not offered as "your fork" — that would check out a stranger's code.
    expect(result.ok && result.value.existing).toBeUndefined();
  });
});

describe("ForkService.fork", () => {
  it("forks, clones, wires upstream, and indexes the checkout", async () => {
    const root = temporaryRoot();
    const parentPath = join(root, "forks");
    mkdirSync(parentPath, { recursive: true });
    const origin = join(root, "origin");
    initRepo(origin);

    // The clone is redirected at a real local repository so the whole path —
    // including `git remote add upstream` on the result — actually runs.
    const forkGit: GitExec = async (args, cwd, options) => {
      if (args[0] === "clone") {
        return systemGit(["clone", "--", origin, args.at(-1)!], cwd, options);
      }
      return systemGit(args, cwd, options);
    };

    const db = openDatabase(":memory:");
    const profiles = new ProfileService(db);
    const profile = profiles.create({
      name: "Personal",
      email: "t@pwrgit.dev",
      roots: [root]
    });
    const registry = new ForgeRepoRegistry();
    registry.register(
      new GitHubRepoProvider(
        fakeGh({
          "facebook/react": { full_name: "facebook/react", visibility: "public" },
          "huntharo/react": {
            full_name: "huntharo/react",
            name: "react",
            visibility: "public",
            fork: true,
            parent: { full_name: "facebook/react" },
            ssh_url: "git@github.com:huntharo/react.git"
          }
        })
      )
    );
    const indexer = new RepoIndexer(db, forkGit);
    const forks = new ForkService(
      forkGit,
      indexer,
      profiles,
      registry,
      new CloneService(db, forkGit, indexer, profiles, registry, fakeForgeStatus()),
      fakeForgeStatus()
    );

    const phases: string[] = [];
    const result = await forks.fork(
      {
        profileId: profile.id,
        source: "facebook/react",
        host: "github",
        hostname: "github.com",
        targetOwner: "huntharo",
        targetOwnerKind: "user",
        targetName: "react",
        protocol: "ssh",
        parentPath,
        defaultBranchOnly: false,
        upstream: "facebook/react"
      },
      (progress) => phases.push(progress.phase)
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Assert the shape, not a path rebuilt with node:path: git normalises
    // separators, so on Windows the indexed path comes back with forward
    // slashes while `join` produces backslashes. Drive the rest off the
    // indexer's own answer.
    const checkout = result.value.path;
    expect(basename(checkout)).toBe("react");
    expect(checkout.replaceAll("\\", "/")).toContain("/forks/react");
    // `upstream` points at the original; `origin` stays the fork.
    const remotes = await systemGit(["remote", "-v"], checkout);
    expect(remotes.ok && remotes.value.stdout).toContain(
      `${UPSTREAM_REMOTE}\tgit@github.com:facebook/react.git`
    );
    expect(phases).toContain("creating");
    expect(phases).toContain("adding_upstream");
    expect(phases.at(-1)).toBe("indexing");
  });

  it("says the fork succeeded when only the checkout failed", async () => {
    const { forks, profileId, parentPath } = services();
    // A destination that already exists fails before git runs.
    mkdirSync(join(parentPath, "react"));
    const result = await forks.fork({
      profileId,
      source: "facebook/react",
      host: "github",
      hostname: "github.com",
      targetOwner: "huntharo",
      targetOwnerKind: "user",
      targetName: "react",
      protocol: "ssh",
      parentPath,
      defaultBranchOnly: false,
      upstream: null
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "destination_exists" }
    });
  });

  it("preserves a created GitLab fork when its import wait is canceled", async () => {
    const root = temporaryRoot();
    const parentPath = join(root, "forks");
    mkdirSync(parentPath, { recursive: true });
    const profile = {
      id: "profile-id",
      name: "Personal",
      email: "t@pwrgit.dev",
      mono: "P",
      roots: [root]
    };
    const profiles = {
      get: vi.fn((profileId: string) =>
        profileId === profile.id ? profile : null
      )
    } as unknown as ProfileService;
    const registry = new ForgeRepoRegistry();
    registry.register(
      new GitLabRepoProvider(async (args) => {
        if (args[1] !== "--method") {
          throw new Error("GitLab was polled after cancellation");
        }
        return JSON.stringify({
          path: "billing-api",
          path_with_namespace: "huntharo/billing-api",
          web_url: "https://gitlab.com/huntharo/billing-api",
          visibility: "private",
          import_status: "scheduled",
          forked_from_project: {
            path_with_namespace: "acme/platform/billing-api"
          }
        });
      })
    );
    const forks = new ForkService(
      systemGit,
      {} as RepoIndexer,
      profiles,
      registry,
      {} as CloneService,
      {} as ForgeStatusService
    );
    const controller = new AbortController();

    const result = await forks.fork(
      {
        profileId: profile.id,
        source: "acme/platform/billing-api",
        host: "gitlab",
        hostname: "gitlab.com",
        targetOwner: "huntharo",
        targetOwnerKind: "user",
        targetName: "billing-api",
        protocol: "cli",
        parentPath,
        defaultBranchOnly: false,
        upstream: "acme/platform/billing-api"
      },
      (progress) => {
        if (progress.phase === "awaiting_fork") {
          controller.abort({
            kind: "git",
            code: "aborted",
            message: "Fork canceled."
          });
        }
      },
      controller.signal
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "aborted",
        message:
          "Forked to huntharo/billing-api, but the local checkout was canceled. GitLab may still be finishing the fork."
      }
    });
    expect(existsSync(join(parentPath, "billing-api"))).toBe(false);
  });

  it("refuses a destination outside the profile's roots", async () => {
    const { forks, profileId } = services();
    const outside = temporaryRoot();
    const result = await forks.fork({
      profileId,
      source: "facebook/react",
      host: "github",
      hostname: "github.com",
      targetOwner: "huntharo",
      targetOwnerKind: "user",
      targetName: "react",
      protocol: "ssh",
      parentPath: outside,
      defaultBranchOnly: false,
      upstream: null
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "destination_outside_roots" }
    });
  });

  it("refuses an upstream unrelated to what was forked", async () => {
    const { forks, profileId, parentPath } = services();
    const result = await forks.fork({
      profileId,
      source: "facebook/react",
      host: "github",
      hostname: "github.com",
      targetOwner: "huntharo",
      targetOwnerKind: "user",
      targetName: "react",
      protocol: "ssh",
      parentPath,
      defaultBranchOnly: false,
      // A stale dialog could send this: shape-valid, but not a repository
      // this fork descends from. Wiring it would make `git fetch upstream`
      // pull unrelated history.
      upstream: "someone-else/unrelated"
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "invalid_repository" }
    });
  });

  it("rejects a fork name that could smuggle a path or an option", async () => {
    const { forks, profileId, parentPath } = services();
    for (const targetName of ["../escape", "--upload-pack=evil"]) {
      const result = await forks.fork({
        profileId,
        source: "facebook/react",
        host: "github",
        hostname: "github.com",
        targetOwner: "huntharo",
        targetOwnerKind: "user",
        targetName,
        protocol: "ssh",
        parentPath,
        defaultBranchOnly: false,
        upstream: null
      });
      expect(result).toMatchObject({
        ok: false,
        error: { code: "invalid_repository" }
      });
    }
  });
});
