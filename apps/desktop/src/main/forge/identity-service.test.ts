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
import { GitLabRepoProvider } from "../forge/gitlab/repo-provider";
import { ForgeHosts } from "./hosts";
import { ForgeRepoRegistry } from "./repo-provider";
import {
  IdentityService,
  sameIdentity,
  type ForgeHostGate
} from "./identity-service";

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
  options: { origin?: string; gate?: ForgeHostGate } = {}
) {
  const origin = options.origin ?? "git@github.com:huntharo/react.git";
  const gate: ForgeHostGate =
    options.gate ?? (() => ({ enabled: true, source: "auto" }));
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
  // Registered with a factory so a self-managed hostname resolves to a real
  // provider: a gate test that passes only because no provider exists would
  // pass with the gate removed.
  const glab = vi.fn(async (_args: string[]) => "{}");
  registry.register(
    new GitLabRepoProvider(glab),
    (hostname) => new GitLabRepoProvider(glab, hostname)
  );
  return {
    db,
    glab,
    indexer,
    profileId: profile.id,
    identities: new IdentityService(db, systemGit, registry, gate)
  };
}

/** True when the provider actually reached the forge. Scans the whole argv:
 *  `targetHost` inserts `--hostname <host>` before the path for a non-default
 *  host, so an index-pinned check silently stops testing anything there. */
function calledApi(gh: { mock: { calls: unknown[][] } }): boolean {
  return gh.mock.calls.some((call) =>
    (call[0] as string[] | undefined)?.some((arg) => arg.startsWith("repos/")) === true
  );
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
    }), registry, () => ({ enabled: true, source: "auto" }));
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
    const { identities, indexer, profileId } = await fixture(gh, {
      origin: "https://code.acme.io/acme/api.git"
    });

    expect(await identities.refresh(indexer.listRepos(profileId))).toEqual([]);
    // No provider was asked; a row here would suppress a later retry.
    expect(gh.mock.calls.some((c) => c[0]?.[1]?.startsWith("repos/"))).toBe(
      false
    );
  });

  it("asks nothing and writes no row for a host switched off in Settings", async () => {
    const gh = vi.fn(okGh({ full_name: "huntharo/react", visibility: "private" }));
    const { identities, indexer, profileId } = await fixture(gh, {
      gate: () => ({ enabled: false, source: "config" })
    });

    const result = await identities.refreshWithOutcomes(
      indexer.listRepos(profileId)
    );

    // Asserted against the whole argv, not slot 1: `targetHost` inserts
    // `--hostname <host>` there for a non-default host, which would make an
    // index-pinned assertion pass while the subprocess still ran.
    expect(calledApi(gh)).toBe(false);
    expect(result.changes).toEqual([]);
    // Its own status: nothing failed, the user turned it off. `unavailable`
    // would say we could not ask; `unknown` would say the forge refused.
    expect(result.outcomes[0]?.status).toBe("host_disabled");
    expect(indexer.listRepos(profileId)[0]?.identity).toBeUndefined();
  });

  it("stops re-reading the remote for a host that is staying off", async () => {
    // The gate writes no row, so without a backoff every pass would re-run
    // `git remote get-url origin` forever and fill REFRESH_BATCH with repos
    // that can never resolve — starving repos on hosts that ARE on.
    let remoteReads = 0;
    const git: GitExec = async (args, cwd, options) => {
      if (args[0] === "remote") remoteReads += 1;
      return systemGit(args, cwd, options);
    };
    const { db, indexer, profileId } = await fixture(okGh({}));
    const registry = new ForgeRepoRegistry();
    registry.register(new GitHubRepoProvider(okGh({})));
    const service = new IdentityService(db, git, registry, () => ({
      enabled: false,
      source: "config"
    }));
    const repos = indexer.listRepos(profileId);

    for (let pass = 0; pass < 5; pass += 1) await service.refresh(repos);

    expect(remoteReads).toBe(1);
  });

  it("keeps the identity it already stored when the host is switched off", async () => {
    const gh = vi.fn(okGh({ full_name: "huntharo/react", visibility: "private" }));
    let gate: ForgeHostGate = () => ({ enabled: true, source: "auto" });
    const { identities, indexer, profileId } = await fixture(gh, {
      gate: (hostname) => gate(hostname)
    });
    const repos = indexer.listRepos(profileId);
    await identities.refresh(repos);

    gate = () => ({ enabled: false, source: "config" });
    gh.mockClear();
    const off = await identities.refreshWithOutcomes(repos, { force: true });

    // "Off" means stop asking, not forget. Clearing the row would collapse
    // "asked, and it is private" into "never looked up" — and the env
    // allowlists that can flip this are scoped to one session.
    expect(calledApi(gh)).toBe(false);
    expect(off.changes).toEqual([]);
    expect(off.outcomes[0]).toMatchObject({
      status: "host_disabled",
      identity: { visibility: "private" }
    });
    expect(indexer.listRepos(profileId)[0]?.identity?.visibility).toBe("private");

    // A stored row names its host, so the next background pass answers from it
    // without spawning git at all.
    gh.mockClear();
    expect(await identities.refresh(repos)).toEqual([]);
    expect(calledApi(gh)).toBe(false);

    // Back on, and the very next pass reads it again — the gate is consulted
    // per lookup rather than captured at construction.
    gate = () => ({ enabled: true, source: "auto" });
    gh.mockImplementation(
      okGh({ full_name: "huntharo/react", visibility: "public" })
    );
    const on = await identities.refresh(repos, { force: true });
    expect(on[0]?.identity.visibility).toBe("public");
  });

  it("does not back off a host that is merely unrecognized yet", async () => {
    // `auto` means enumeration has not landed — two subprocesses that finish
    // after the first refresh. Caching that as "off" would leave a
    // self-managed host without marks for the length of the backoff.
    const gh = vi.fn(okGh({ full_name: "huntharo/react", visibility: "public" }));
    let known = false;
    const { identities, indexer, profileId } = await fixture(gh, {
      gate: () => ({ enabled: known, source: "auto" })
    });
    const repos = indexer.listRepos(profileId);

    expect((await identities.refreshWithOutcomes(repos)).outcomes[0]?.status)
      .toBe("unavailable");

    known = true;
    expect((await identities.refresh(repos))[0]?.identity.visibility).toBe(
      "public"
    );
  });

  it("re-asks once the gate changes, without forcing a full re-read", async () => {
    // The backoff caches an answer the gate gave. Host enumeration landing, or
    // a switch being flipped, changes that answer — and nothing else would
    // ever ask again: a repo gated before it had a row renders no glyph, and
    // the glyph is the only manual refresh.
    const gh = vi.fn(okGh({ full_name: "huntharo/react", visibility: "private" }));
    let gate: ForgeHostGate = () => ({ enabled: false, source: "config" });
    const { identities, indexer, profileId } = await fixture(gh, {
      gate: (hostname) => gate(hostname)
    });
    const repos = indexer.listRepos(profileId);
    await identities.refresh(repos);
    expect(calledApi(gh)).toBe(false);

    // Switched back on: without clearing the stamp the repo sits out its
    // backoff for a decision that no longer applies.
    gate = () => ({ enabled: true, source: "config" });
    expect(await identities.refresh(repos)).toEqual([]);
    expect(calledApi(gh)).toBe(false);

    identities.clearGateBackoff();
    const changed = await identities.refresh(repos);
    expect(changed[0]?.identity.visibility).toBe("private");

    // And it is not a `force`: the row it just wrote is fresh, so the next
    // pass still costs nothing.
    gh.mockClear();
    expect(await identities.refresh(repos)).toEqual([]);
    expect(calledApi(gh)).toBe(false);
  });

  it("holds a switched-off host past the signed-out window", async () => {
    // The two windows differ on purpose. A signed-out CLI recovers from
    // outside the app, so it re-asks in five minutes; a switched-off host can
    // only change through a settings write, which clears the stamp outright.
    // Re-deriving that answer every five minutes costs ~3,600 `git remote`
    // spawns an hour on a 300-repo profile and can tell us nothing new.
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    let remoteReads = 0;
    const git: GitExec = async (args, cwd, options) => {
      if (args[0] === "remote") remoteReads += 1;
      return systemGit(args, cwd, options);
    };
    const { db, indexer, profileId } = await fixture(okGh({}));
    const registry = new ForgeRepoRegistry();
    registry.register(new GitHubRepoProvider(okGh({})));
    const service = new IdentityService(db, git, registry, () => ({
      enabled: false,
      source: "config"
    }));
    const repos = indexer.listRepos(profileId);

    await service.refresh(repos);
    expect(remoteReads).toBe(1);

    // Well past IDENTITY_RETRY_MS, still inside IDENTITY_TTL_MS.
    now.mockReturnValue(Date.now() + 30 * 60_000);
    await service.refresh(repos);
    expect(remoteReads).toBe(1);
  });

  it("does not drop a signed-out backoff when the gate changes", async () => {
    // The two stamps recover differently. A settings write invalidates what
    // the GATE said and nothing else — clearing the signed-out stamp too
    // turned an unrelated toggle (a theme, say) into a burst of spawns
    // against a CLI already known to be logged out.
    const gh = vi.fn<(args: string[]) => Promise<string>>(async () => {
      throw new Error("gh auth login");
    });
    const { identities, indexer, profileId } = await fixture(gh);
    const repos = indexer.listRepos(profileId);
    await identities.refresh(repos);
    expect(calledApi(gh)).toBe(true);

    identities.clearGateBackoff();
    gh.mockClear();

    expect(await identities.refresh(repos)).toEqual([]);
    expect(calledApi(gh)).toBe(false);
  });

  it("follows ForgeHosts rather than the gitlab.* hostname rule", async () => {
    // `parseForgeRemote` still reads any `gitlab.*` name as GitLab, while
    // `ForgeHosts` refuses to guess a forge from a name — so this instance has
    // no settings row at all, and no switch the user could have turned off.
    const hosts = new ForgeHosts({
      readSettings: () => ({ hosts: {} }),
      discovered: () => [],
      env: {}
    });
    const origin = "git@gitlab.internal.example:group/app.git";
    const gated = await fixture(okGh({}), {
      origin,
      gate: (hostname) => hosts.isEnabled(hostname)
    });

    const result = await gated.identities.refreshWithOutcomes(
      gated.indexer.listRepos(gated.profileId)
    );

    expect(gated.glab).not.toHaveBeenCalled();
    // Unrecognized, not switched off — nobody ever decided about this host.
    expect(result.outcomes[0]?.status).toBe("unavailable");
    expect(gated.indexer.listRepos(gated.profileId)[0]?.identity).toBeUndefined();
  });

  it("reaches a self-managed GitLab provider once the gate allows it", async () => {
    // The other half of the claim above: a provider IS reachable for this
    // hostname, so the silence there is the gate and not a missing factory.
    const ungated = await fixture(okGh({}), {
      origin: "git@gitlab.internal.example:group/app.git"
    });

    await ungated.identities.refresh(
      ungated.indexer.listRepos(ungated.profileId)
    );

    expect(ungated.glab).toHaveBeenCalled();
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
