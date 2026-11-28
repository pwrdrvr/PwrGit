import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ok } from "@pwrgit/shared";
import { openDatabase } from "../persistence/db";
import { ProfileService } from "../profiles/profile-service";
import { ForgeRepoRegistry } from "../forge/repo-provider";
import { ForgeStatusService } from "../forge/status";
import { GitHubRepoProvider } from "../forge/github/repo-provider";
import { GitCafeRepoProvider } from "../forge/gitcafe/repo-provider";
import { CloneService, cloneHistoryArgs } from "./clone-service";
import type { GitExec } from "./dugite";
import { RepoIndexer } from "./repo-indexer";
import { createSystemGit } from "./test-support/system-git";
import {
  countCommits,
  createHistorySource,
  fixtureGit,
  graftedCommits,
  isShallow
} from "./test-support/shallow-fixture";

const systemGit: GitExec = createSystemGit();
let root: string;
let source: string;

beforeAll(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "pwrgit-shallow-clone-")));
  source = createHistorySource(join(root, "sources", "history"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function forgeStatus(): ForgeStatusService {
  return new ForgeStatusService({
    probes: [
      { kind: "github", cli: "gh", installed: async () => true, loggedIn: async () => true },
      { kind: "gitlab", cli: "glab", installed: async () => false, loggedIn: async () => false },
      { kind: "gitcafe", cli: "cafe", installed: async () => true, loggedIn: async () => true }
    ]
  });
}

let destinations = 0;
function setup(
  git: GitExec = systemGit,
  options: { gh?: (args: string[]) => Promise<string>; cafe?: (args: string[]) => Promise<string> } = {}
) {
  const parent = join(root, `dest-${(destinations += 1)}`);
  fixtureGit(root, "init", "-q", parent); // any directory will do; a repo keeps the scan happy
  rmSync(join(parent, ".git"), { recursive: true, force: true });
  const db = openDatabase(":memory:");
  const profiles = new ProfileService(db);
  const profile = profiles.create({ name: "Shallow", email: "test@pwrgit.com", roots: [parent] });
  const registry = new ForgeRepoRegistry();
  registry.register(new GitHubRepoProvider(options.gh ?? (async () => "")));
  registry.register(
    new GitCafeRepoProvider(
      options.cafe ??
        (async () => {
          throw new Error("cafe must not run");
        })
    )
  );
  const service = new CloneService(db, git, new RepoIndexer(db, git), profiles, registry, forgeStatus());
  return { db, parent, profile, service };
}

function recordingGit(calls: string[][], exitCode = 0, stderr = ""): GitExec {
  return async (args, cwd, options) => {
    calls.push([...args]);
    if (args[0] === "clone") return ok({ stdout: "", stderr, exitCode });
    return systemGit(args, cwd, options);
  };
}

describe("cloneHistoryArgs", () => {
  it("is empty for full history and always pairs --depth with --no-single-branch", () => {
    expect(cloneHistoryArgs(undefined)).toEqual(ok([]));
    expect(cloneHistoryArgs(50)).toEqual(ok(["--depth", "50", "--no-single-branch"]));
    for (const bad of [0, -3, 2.5, 100_001, Number.NaN]) {
      expect(cloneHistoryArgs(bad)).toMatchObject({ ok: false, error: { code: "invalid_history_depth" } });
    }
  });
});

describe("CloneService with recent history only", () => {
  it("makes a real shallow clone of a local repository through file://, with every branch", async () => {
    const { db, parent, profile, service } = setup();
    const result = await service.clone({
      profileId: profile.id,
      nameWithOwner: source,
      sourcePath: source,
      protocol: "ssh",
      parentPath: parent,
      depth: 2
    });
    expect(result.ok).toBe(true);
    const clone = join(parent, "history");
    // A plain-path clone would have ignored --depth with a warning.
    expect(isShallow(clone)).toBe(true);
    expect(graftedCommits(clone).size).toBeGreaterThan(0);
    expect(countCommits(clone, "origin/main")).toBeLessThan(countCommits(source, "main"));
    // Branch semantics: all branches, the default refspec, the default branch checked out.
    expect(fixtureGit(clone, "config", "--get-all", "remote.origin.fetch")).toBe("+refs/heads/*:refs/remotes/origin/*");
    expect(fixtureGit(clone, "for-each-ref", "--format=%(refname:short)", "refs/remotes/origin").split("\n").sort()).toEqual(
      ["origin", "origin/main", "origin/side", "origin/topic"]
    );
    expect(fixtureGit(clone, "branch", "--show-current")).toBe("main");
    // Content: the checkout is the source's tip, byte for byte.
    expect(fixtureGit(clone, "rev-parse", "HEAD^{tree}")).toBe(fixtureGit(source, "rev-parse", "main^{tree}"));
    // The committed blob, not the working file: Windows' default
    // core.autocrlf checks the file out with CRLF.
    expect(fixtureGit(clone, "show", "HEAD:file.txt")).toBe("12");
    expect(readFileSync(join(clone, "file.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("12\n");
    // Every tag arrives too, each with its own latest commits: `old` (c4) is
    // present although main's last two commits do not reach it.
    expect(fixtureGit(clone, "tag", "--list").split("\n").sort()).toEqual(["old", "v2"]);
    expect(fixtureGit(clone, "rev-parse", "old^{commit}")).toBe(fixtureGit(source, "rev-parse", "old^{commit}"));
    db.close();
  });

  it("leaves the full-history clone exactly as it was: no depth, no file:// rewrite", async () => {
    const calls: string[][] = [];
    const real: GitExec = (args, cwd, options) => {
      calls.push([...args]);
      return systemGit(args, cwd, options);
    };
    const { db, parent, profile, service } = setup(real);
    const result = await service.clone({
      profileId: profile.id,
      nameWithOwner: source,
      sourcePath: source,
      protocol: "ssh",
      parentPath: parent
    });
    expect(result.ok).toBe(true);
    expect(calls.find((args) => args[0] === "clone")).toEqual([
      "clone",
      "--progress",
      "--",
      source,
      join(parent, "history")
    ]);
    expect(isShallow(join(parent, "history"))).toBe(false);
    db.close();
  });

  it("refuses a malformed depth before touching the disk or running Git", async () => {
    for (const depth of [0, -1, 1.5, 100_001, Number.NaN, "50" as unknown as number]) {
      const calls: string[][] = [];
      const { db, parent, profile, service } = setup(recordingGit(calls));
      const result = await service.clone({
        profileId: profile.id,
        nameWithOwner: "acme/api",
        protocol: "https",
        parentPath: parent,
        depth
      });
      expect(result).toMatchObject({ ok: false, error: { code: "invalid_history_depth" } });
      expect(calls.filter((args) => args[0] === "clone")).toEqual([]);
      expect(existsSync(join(parent, "api"))).toBe(false);
      db.close();
    }
  });

  it("sends --depth and --no-single-branch before the URL for SSH and HTTPS", async () => {
    for (const protocol of ["ssh", "https"] as const) {
      const calls: string[][] = [];
      const { db, parent, profile, service } = setup(recordingGit(calls, 128, "fatal: stop after recording"));
      await service.clone({
        profileId: profile.id,
        nameWithOwner: "acme/api",
        protocol,
        parentPath: parent,
        depth: 25
      });
      expect(calls.find((args) => args[0] === "clone")).toEqual([
        "clone",
        "--progress",
        "--depth",
        "25",
        "--no-single-branch",
        "--",
        protocol === "ssh" ? "git@github.com:acme/api.git" : "https://github.com/acme/api.git",
        join(parent, "api")
      ]);
      db.close();
    }
  });

  it("reports a server that cannot serve shallow clones, removes the partial checkout, and never retries as full", async () => {
    const calls: string[][] = [];
    const { db, parent, profile, service } = setup(
      recordingGit(calls, 128, "Cloning into 'api'...\nfatal: dumb http transport does not support shallow capabilities")
    );
    const result = await service.clone({
      profileId: profile.id,
      nameWithOwner: "acme/api",
      protocol: "https",
      parentPath: parent,
      depth: 10
    });
    expect(result).toMatchObject({ ok: false, error: { code: "shallow_unsupported" } });
    if (!result.ok) expect(result.error.message).toContain("Recent history only");
    expect(calls.filter((args) => args[0] === "clone")).toHaveLength(1);
    expect(existsSync(join(parent, "api"))).toBe(false);
    db.close();
  });

  it("passes the options to gh after --, and refuses the GitCafe CLI rather than cloning everything", async () => {
    const ghCalls: string[][] = [];
    const github = setup(recordingGit([]), {
      gh: async (args) => {
        ghCalls.push([...args]);
        return "";
      }
    });
    await github.service.runClone(
      { host: "github", hostname: "github.com", nameWithOwner: "acme/api", protocol: "cli", depth: 7 },
      join(github.parent, "api"),
      github.parent,
      () => undefined
    );
    expect(ghCalls.find((args) => args[0] === "repo")).toEqual([
      "repo",
      "clone",
      "acme/api",
      join(github.parent, "api"),
      "--",
      "--progress",
      "--depth",
      "7",
      "--no-single-branch"
    ]);
    github.db.close();

    const cafe = setup(recordingGit([]));
    const refused = await cafe.service.runClone(
      { host: "gitcafe", hostname: "git.cafe", nameWithOwner: "acme/api", protocol: "cli", depth: 7 },
      join(cafe.parent, "api"),
      cafe.parent,
      () => undefined
    );
    expect(refused).toMatchObject({ ok: false, error: { code: "shallow_clone_unsupported" } });
    cafe.db.close();
  });

  it("cancels a shallow clone like any other and keeps nothing", async () => {
    const { db, parent, profile, service } = setup();
    const controller = new AbortController();
    controller.abort({ kind: "git", code: "aborted", message: "Clone canceled." });
    const result = await service.clone(
      {
        profileId: profile.id,
        nameWithOwner: source,
        sourcePath: source,
        protocol: "ssh",
        parentPath: parent,
        depth: 3
      },
      () => undefined,
      controller.signal
    );
    expect(result).toMatchObject({ ok: false, error: { code: "aborted" } });
    expect(existsSync(join(parent, "history"))).toBe(false);
    db.close();
  });
});
