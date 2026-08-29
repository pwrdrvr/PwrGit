import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { err, ok, type RepoIdentity, type Result } from "@pwrgit/shared";
import { openDatabase } from "../persistence/db";
import { ProfileService } from "../profiles/profile-service";
import { RepoIndexer } from "../git/repo-indexer";
import type { GitExec, GitOutput } from "../git/dugite";
import { GitHubRepoProvider } from "../forge/github/repo-provider";
import { ForgeRepoRegistry } from "./repo-provider";
import { IdentityService, sameIdentity } from "./identity-service";

const systemGit: GitExec = (args, cwd, options) =>
  new Promise<Result<GitOutput>>((resolve) => {
    const proc = spawn("git", args, { cwd, env: { ...process.env, ...options?.env } });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    proc.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    proc.on("close", (code) => resolve(ok({ stdout, stderr, exitCode: code ?? 0 })));
    proc.on("error", (e) =>
      resolve(err({ kind: "git", code: "spawn_failed", message: e.message }))
    );
  });

const created: string[] = [];
function temporaryRoot(): string {
  const path = realpathSync.native(mkdtempSync(join(tmpdir(), "pwrgit-ident-")));
  created.push(path);
  return path;
}
afterEach(() => {
  while (created.length > 0) rmSync(created.pop()!, { recursive: true, force: true });
});

function initRepo(path: string, origin: string): void {
  mkdirSync(path, { recursive: true });
  const run = (...args: string[]) =>
    execFileSync("git", args, { cwd: path, stdio: "ignore" });
  run("init", "-b", "main");
  run("config", "user.email", "t@pwrgit.com");
  run("config", "user.name", "T");
  writeFileSync(join(path, "README.md"), "# t\n");
  run("add", ".");
  run("commit", "-m", "init");
  run("remote", "add", "origin", origin);
}

async function fixture(
  gh: (args: string[]) => Promise<string>,
  origin = "git@github.com:huntharo/react.git"
) {
  const root = temporaryRoot();
  const repoPath = join(root, "react");
  initRepo(repoPath, origin);
  const db = openDatabase(":memory:");
  const profiles = new ProfileService(db);
  const profile = profiles.create({
    name: "Personal",
    email: "t@pwrgit.com",
    roots: [root]
  });
  const indexer = new RepoIndexer(db, systemGit);
  await indexer.indexRepoAt(profile.id, repoPath);
  const registry = new ForgeRepoRegistry();
  registry.register(new GitHubRepoProvider(gh));
  return {
    db,
    indexer,
    profileId: profile.id,
    identities: new IdentityService(db, systemGit, registry)
  };
}

const okGh =
  (repo: Record<string, unknown>) =>
  async (args: string[]): Promise<string> => {
    if (args[0] === "--version") return "gh version 2.92.0";
    if (args[1]?.startsWith("repos/")) return JSON.stringify(repo);
    return "{}";
  };

describe("IdentityService", () => {
  it("reads origin, stores the identity, and reports it as changed", async () => {
    const { identities, indexer, profileId } = await fixture(
      okGh({
        full_name: "huntharo/react",
        name: "react",
        visibility: "private",
        fork: true,
        parent: { full_name: "facebook/react" }
      })
    );

    const changes = await identities.refresh(indexer.listRepos(profileId));

    expect(changes).toHaveLength(1);
    expect(changes[0]?.identity).toMatchObject({
      host: "github",
      hostname: "github.com",
      nameWithOwner: "huntharo/react",
      visibility: "private",
      parent: { nameWithOwner: "facebook/react" }
    });
  });

  it("hydrates the stored identity onto repo:list", async () => {
    const { identities, indexer, profileId } = await fixture(
      okGh({ full_name: "huntharo/react", visibility: "public" })
    );
    await identities.refresh(indexer.listRepos(profileId));

    // Joined by the indexer so the marks arrive with the first paint rather
    // than a frame later.
    expect(indexer.listRepos(profileId)[0]?.identity).toMatchObject({
      nameWithOwner: "huntharo/react",
      visibility: "public"
    });
  });

  it("reports nothing changed when the facts are the same", async () => {
    const { identities, indexer, profileId } = await fixture(
      okGh({ full_name: "huntharo/react", visibility: "public" })
    );
    await identities.refresh(indexer.listRepos(profileId));

    // `force` re-reads; the answer is identical, so the renderer is not asked
    // to repaint. A refresh that confirms the same facts is not a change.
    expect(
      await identities.refresh(indexer.listRepos(profileId), { force: true })
    ).toEqual([]);
  });

  it("records `unknown` when the forge will not answer", async () => {
    const { identities, indexer, profileId } = await fixture(async (args) => {
      if (args[0] === "--version") return "gh version 2.92.0";
      throw new Error("404 Not Found");
    });

    const changes = await identities.refresh(indexer.listRepos(profileId));

    // Distinct from "never looked up": re-asking about a repo we cannot see
    // on every pass would be pure noise.
    expect(changes[0]?.identity.visibility).toBe("unknown");
  });

  it("leaves the row alone when the CLI is signed out", async () => {
    const gh = vi.fn(async (args: string[]) => {
      if (args[0] === "--version") return "gh version 2.92.0";
      throw new Error("gh auth login");
    });
    const { identities, indexer, profileId } = await fixture(gh);

    const changes = await identities.refresh(indexer.listRepos(profileId));

    // Signed out is transient and fixable — caching "unknown" for it would
    // mean signing in produced no refresh.
    expect(changes).toEqual([]);
    expect(indexer.listRepos(profileId)[0]?.identity).toBeUndefined();
  });

  it("ignores a repo whose origin is on no known forge", async () => {
    const gh = vi.fn(okGh({ full_name: "x/y", visibility: "public" }));
    const { identities, indexer, profileId } = await fixture(
      gh,
      "https://code.acme.io/acme/api.git"
    );

    expect(await identities.refresh(indexer.listRepos(profileId))).toEqual([]);
    // No provider was asked; a row here would suppress a later retry.
    expect(gh.mock.calls.some((c) => c[0]?.[1]?.startsWith("repos/"))).toBe(
      false
    );
  });

  it("describes the fork's origin, not a fetched upstream", async () => {
    // A fork checkout has origin (the fork) and upstream (the original). The
    // marks describe what you push to.
    const { identities, indexer, profileId } = await fixture(
      async (args) => {
        if (args[0] === "--version") return "gh version 2.92.0";
        expect(args[1]).toBe("repos/huntharo/react");
        return JSON.stringify({
          full_name: "huntharo/react",
          visibility: "public"
        });
      }
    );
    const repos = indexer.listRepos(profileId);
    execFileSync(
      "git",
      ["remote", "add", "upstream", "git@github.com:facebook/react.git"],
      { cwd: repos[0]!.path, stdio: "ignore" }
    );

    const changes = await identities.refresh(repos);

    expect(changes[0]?.identity.nameWithOwner).toBe("huntharo/react");
  });
});

describe("sameIdentity", () => {
  const base: RepoIdentity = {
    host: "github",
    hostname: "github.com",
    owner: "huntharo",
    name: "react",
    nameWithOwner: "huntharo/react",
    visibility: "public"
  };

  it("ignores fetchedAt — a re-read is not a repaint", () => {
    expect(sameIdentity({ ...base, fetchedAt: "2020" }, base)).toBe(true);
  });

  it("notices every fact the marks render", () => {
    expect(sameIdentity({ ...base, visibility: "private" }, base)).toBe(false);
    expect(
      sameIdentity(base, { ...base, parent: { nameWithOwner: "f/r", url: "" } })
    ).toBe(false);
    expect(sameIdentity(undefined, base)).toBe(false);
  });
});
