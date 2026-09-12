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
import { IdentityService, readOrigin, sameIdentity } from "./identity-service";

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
  vi.restoreAllMocks();
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

  it.each(["unknown", "private", "internal"])(
    "refreshes stale %s visibility without querying again on every fetch",
    async (visibility) => {
      const gh = vi.fn(okGh({ full_name: "huntharo/react", visibility }));
      const { db, identities, indexer, profileId } = await fixture(gh);
      const repos = indexer.listRepos(profileId);
      await identities.refresh(repos);
      gh.mockImplementation(
        okGh({ full_name: "huntharo/react", visibility: "public" })
      );
      gh.mockClear();
      expect(await identities.refresh(repos)).toEqual([]);
      expect(gh).not.toHaveBeenCalled();

      db.prepare(
        "UPDATE repo_identity SET fetched_at = datetime('now', '-7 hours')"
      ).run();
      const changes = await identities.refresh(repos);
      expect(changes[0]?.identity.visibility).toBe("public");
      expect(indexer.listRepos(profileId)[0]?.identity?.visibility).toBe("public");
      gh.mockClear();
      expect(await identities.refresh(repos)).toEqual([]);
      expect(gh).not.toHaveBeenCalled();
    }
  );

  it("coalesces overlapping refreshes for the same repository", async () => {
    const gh = vi.fn(okGh({ full_name: "huntharo/react", visibility: "public" }));
    const { identities, indexer, profileId } = await fixture(gh);
    const repos = indexer.listRepos(profileId);
    const changes = await Promise.all([
      identities.refresh(repos),
      identities.refresh(repos),
      identities.refresh(repos)
    ]);
    expect(
      gh.mock.calls.filter(([args]) => args[1]?.startsWith("repos/"))
    ).toHaveLength(1);
    expect(changes.flat()).toHaveLength(1);
  });

  it.each(["resolved", "unknown", "signed_out"] as const)("waits for an ongoing lookup and shares its %s outcome", async (status) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const gh = vi.fn(async () => {
      await gate;
      if (status === "signed_out") throw new Error("gh auth login");
      return JSON.stringify({ full_name: "huntharo/react", visibility: status === "resolved" ? "public" : "unknown" });
    });
    const { identities, indexer, profileId } = await fixture(gh);
    const repos = indexer.listRepos(profileId);
    const background = identities.refresh(repos);
    await vi.waitFor(() => expect(gh).toHaveBeenCalledTimes(1));
    let finished = false;
    const explicit = identities.refreshWithOutcomes(repos, { force: true }).then((result) => { finished = true; return result; });
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(finished).toBe(false);
    } finally {
      release();
      await Promise.all([background, explicit]);
    }
    expect(gh).toHaveBeenCalledTimes(1);
    expect((await explicit).outcomes[0]?.status).toBe(status);
    expect((await explicit).changes).toEqual([]);
  });

  it("bounds aggregate forge requests across batch and detached refreshes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let active = 0;
    let peak = 0;
    let calls = 0;
    const gh = async () => {
      active += 1;
      calls += 1;
      peak = Math.max(peak, active);
      const call = calls;
      try {
        await gate;
        if (call === 1) throw new Error("network unavailable");
        return JSON.stringify({ full_name: "huntharo/react", visibility: "public" });
      } finally {
        active -= 1;
      }
    };
    const { db, indexer, profileId } = await fixture(gh);
    const base = indexer.listRepos(profileId)[0]!;
    const repos = Array.from({ length: 12 }, (_, i) => ({ ...base, id: `queued-${i}` }));
    for (const repo of repos) {
      db.prepare("INSERT INTO repos (id, profile_id, name, path) VALUES (?, ?, ?, ?)")
        .run(repo.id, profileId, repo.name, `${repo.path}-${repo.id}`);
    }
    const registry = new ForgeRepoRegistry();
    registry.register(new GitHubRepoProvider(gh));
    const service = new IdentityService(db, async () => ok({
      exitCode: 0, stdout: "git@github.com:huntharo/react.git", stderr: ""
    }), registry);
    const pending = Promise.all([
      service.refresh(repos.slice(0, 6)),
      ...repos.slice(6).map((repo) => service.refresh([repo]))
    ]);
    try {
      await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(4));
      expect(peak).toBe(4);
    } finally {
      release();
      await pending;
    }
    expect(calls).toBe(12);
    expect(peak).toBe(4);
  });

  it("retries an unknown identity after five minutes instead of six hours", async () => {
    const { db, identities, indexer, profileId } = await fixture(
      okGh({ full_name: "huntharo/react", visibility: "public" })
    );
    const repos = indexer.listRepos(profileId);
    await identities.refresh(repos);
    db.prepare("UPDATE repo_identity SET visibility = 'unknown', fetched_at = datetime('now', '-6 minutes')").run();
    expect((await identities.refresh(repos))[0]?.identity.visibility).toBe("public");
  });

  it.each(["resolved", "unknown", "signed_out", "network"] as const)(
    "reports %s independently of changes to a previously known identity",
    async (status) => {
      const gh = vi.fn(okGh({ full_name: "huntharo/react", visibility: "private" }));
      const { identities, indexer, profileId } = await fixture(gh);
      const repos = indexer.listRepos(profileId);
      await identities.refresh(repos);
      gh.mockImplementation(async () => {
        if (status === "signed_out") throw new Error("gh auth login");
        if (status === "network") throw new Error("network unavailable");
        return JSON.stringify({ full_name: "huntharo/react", visibility: status === "resolved" ? "private" : "unknown" });
      });
      const result = await identities.refreshWithOutcomes(repos, { force: true });
      expect(result.outcomes[0]?.status).toBe(status === "network" ? "unknown" : status);
      expect(result.outcomes[0]?.identity?.visibility).toBe(
        status === "signed_out" || status === "resolved" ? "private" : "unknown"
      );
      expect(result.changes).toHaveLength(status === "signed_out" || status === "resolved" ? 0 : 1);
    }
  );

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

  it("backs off signed-out lookups without persisting unknown, then recovers", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    const gh = vi.fn<(args: string[]) => Promise<string>>(async () => { throw new Error("gh auth login"); });
    const { identities, indexer, profileId } = await fixture(gh);
    const repos = indexer.listRepos(profileId);
    await identities.refresh(repos);
    gh.mockClear();
    expect(await identities.refresh(repos)).toEqual([]);
    expect(gh).not.toHaveBeenCalled();
    expect(indexer.listRepos(profileId)[0]?.identity).toBeUndefined();

    now.mockReturnValue(Date.now() + 5 * 60_000);
    gh.mockImplementation(okGh({ full_name: "huntharo/react", visibility: "public" }));
    expect((await identities.refresh(repos))[0]?.identity.visibility).toBe("public");
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

describe("readOrigin", () => {
  const repo = { id: "r1", path: "/tmp/whatever" } as Parameters<
    typeof readOrigin
  >[1];
  const remote =
    (url: string): GitExec =>
    async () =>
      ok({ exitCode: 0, stdout: `${url}\n`, stderr: "" });

  it("needs the host list to place a self-managed instance", async () => {
    // The regression this guards: `gitlab.*` used to classify as GitLab from
    // its name alone, so removing that rule without passing the enumerated
    // hosts here would silently drop the visibility and fork-lineage marks for
    // every company GitLab — the CLI is signed in, and nothing would say why.
    const url = "git@gitlab.acme-corp.example:acme/platform/billing.git";
    expect(await readOrigin(remote(url), repo)).toMatchObject({
      host: "other"
    });
    expect(
      await readOrigin(remote(url), repo, {
        "gitlab.acme-corp.example": "gitlab"
      })
    ).toEqual({
      repoId: "r1",
      host: "gitlab",
      hostname: "gitlab.acme-corp.example",
      nameWithOwner: "acme/platform/billing"
    });
  });

  it("still knows the two SaaS hosts with no list at all", async () => {
    expect(
      await readOrigin(remote("git@github.com:huntharo/react.git"), repo)
    ).toMatchObject({ host: "github", nameWithOwner: "huntharo/react" });
  });
});
