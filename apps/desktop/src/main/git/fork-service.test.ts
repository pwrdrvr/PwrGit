import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { err, ok, type CloneRepository, type Result } from "@pwrgit/shared";
import { openDatabase } from "../persistence/db";
import { ProfileService } from "../profiles/profile-service";
import { ForgeRegistry } from "../forge/provider";
import { GitHubProvider } from "../github/github-provider";
import { CloneService } from "./clone-service";
import {
  ForkService,
  isForkOf,
  upstreamChoicesFor,
  UPSTREAM_REMOTE
} from "./fork-service";
import type { GitExec, GitOutput } from "./dugite";
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
      resolve(err({ kind: "git", code: "spawn_failed", message: error.message }))
    );
  });

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
      }
    })
  );
  const registry = new ForgeRegistry();
  registry.register(new GitHubProvider(gh));
  const clones = new CloneService(db, systemGit, indexer, profiles, registry);
  return {
    root,
    parentPath,
    profileId: profile.id,
    gh,
    forks: new ForkService(systemGit, indexer, profiles, registry, clones)
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
    const registry = new ForgeRegistry();
    registry.register(
      new GitHubProvider(
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
      new CloneService(db, systemGit, indexer, profiles, registry)
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

  it("refuses a name taken by an unrelated repository", async () => {
    const root = temporaryRoot();
    const db = openDatabase(":memory:");
    const profiles = new ProfileService(db);
    const profile = profiles.create({
      name: "Personal",
      email: "t@pwrgit.dev",
      roots: [root]
    });
    const registry = new ForgeRegistry();
    registry.register(
      new GitHubProvider(
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
      new CloneService(db, systemGit, indexer, profiles, registry)
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
    const registry = new ForgeRegistry();
    registry.register(
      new GitHubProvider(
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
      new CloneService(db, forkGit, indexer, profiles, registry)
    );

    const phases: string[] = [];
    const result = await forks.fork(
      {
        profileId: profile.id,
        source: "facebook/react",
        host: "github",
        hostname: "github.com",
        targetOwner: "huntharo",
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
    const checkout = join(parentPath, "react");
    expect(result.value.path).toBe(checkout);
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

  it("refuses a destination outside the profile's roots", async () => {
    const { forks, profileId } = services();
    const outside = temporaryRoot();
    const result = await forks.fork({
      profileId,
      source: "facebook/react",
      host: "github",
      hostname: "github.com",
      targetOwner: "huntharo",
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

  it("rejects a fork name that could smuggle a path or an option", async () => {
    const { forks, profileId, parentPath } = services();
    for (const targetName of ["../escape", "--upload-pack=evil"]) {
      const result = await forks.fork({
        profileId,
        source: "facebook/react",
        host: "github",
        hostname: "github.com",
        targetOwner: "huntharo",
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
