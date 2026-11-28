import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize, sep } from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ok } from "@pwrgit/shared";
import type { GitExec } from "./dugite";
import {
  chooseHistoryRemote,
  deepenArgs,
  deepenHistory,
  fetchedBranches,
  readShallowBoundaries,
  readShallowState
} from "./shallow-history";
import { createSystemGit } from "./test-support/system-git";
import {
  countCommits,
  createHistorySource,
  fileUrl,
  fixtureGit,
  graftedCommits,
  isShallow
} from "./test-support/shallow-fixture";

const git: GitExec = createSystemGit();
let root: string;
let source: string;

beforeAll(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "pwrgit-shallow-")));
  source = createHistorySource(join(root, "source"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

let clones = 0;
function shallowClone(depth: number, ...extra: string[]): string {
  const path = join(root, `clone-${(clones += 1)}`);
  fixtureGit(root, "clone", "-q", `--depth=${depth}`, ...extra, fileUrl(source), path);
  return path;
}

describe("readShallowState", () => {
  it("reports a complete repository as complete, at the cost of one rev-parse", async () => {
    const calls: string[][] = [];
    const counting: GitExec = (args, cwd, options) => {
      calls.push([...args]);
      return git(args, cwd, options);
    };
    expect(await readShallowState(counting, source, "main")).toEqual(ok(null));
    expect(calls).toEqual([["rev-parse", "--is-shallow-repository", "--git-common-dir"]]);
  });

  // Oracle: Git decorates exactly the commits it treats as shallow roots as
  // `grafted`. PwrGit's boundary set must be that set, for any depth.
  it("names exactly the commits Git calls grafted, at every depth", async () => {
    for (const depth of [1, 2, 3, 4]) {
      const clone = shallowClone(depth, "--no-single-branch");
      expect(isShallow(clone)).toBe(true);
      const state = await readShallowState(git, clone, "origin/main");
      expect(state.ok).toBe(true);
      if (!state.ok || state.value === null) throw new Error("expected shallow state");
      expect(state.value.boundaries).toEqual(graftedCommits(clone));
      expect(state.value.remote).toBe("origin");
      // --no-single-branch keeps the default wildcard refspec.
      expect(state.value.fetchesOnly).toBeNull();
      // Every branch and both kinds of tag near a tip arrived.
      expect(fixtureGit(clone, "branch", "-r").split("\n").map((l) => l.trim()).sort()).toEqual(
        ["origin/HEAD -> origin/main", "origin/main", "origin/side", "origin/topic"]
      );
      // At least `depth` commits of main; more where a tag near the tip is a
      // tip of its own (Git applies the depth to every fetched ref).
      expect(countCommits(clone, "origin/main")).toBeGreaterThanOrEqual(depth);
      expect(countCommits(clone, "origin/main")).toBeLessThan(countCommits(source, "main"));
    }
  });

  it("reports a depth that reached every root as complete: Git writes no boundary", async () => {
    // Every tip's history is at most 9 commits deep here (tag `old` is c4).
    const clone = shallowClone(9, "--no-single-branch");
    expect(isShallow(clone)).toBe(false);
    expect(await readShallowState(git, clone, "origin/main")).toEqual(ok(null));
  });

  it("says when a clone fetches only one branch, instead of implying the rest exist", async () => {
    const clone = shallowClone(2);
    const state = await readShallowState(git, clone, "origin/main");
    if (!state.ok || state.value === null) throw new Error("expected shallow state");
    expect(state.value.fetchesOnly).toEqual(["main"]);
    expect(fixtureGit(clone, "branch", "-r")).not.toContain("origin/side");
  });

  it("reads the same boundary from a linked worktree, which shares it", async () => {
    const clone = shallowClone(2, "--no-single-branch");
    const worktree = join(root, `wt-${clones}`);
    fixtureGit(clone, "worktree", "add", "-q", worktree, "-b", "local-side", "origin/side");
    const fromMain = await readShallowBoundaries(git, clone);
    const fromWorktree = await readShallowBoundaries(git, worktree);
    expect(fromWorktree).toEqual(fromMain);
    expect(fromMain.ok && fromMain.value !== null && fromMain.value.size > 0).toBe(true);
  });
});

describe("deepenHistory", () => {
  it("--deepen adds older commits behind every boundary and keeps the checkout's contents", async () => {
    const clone = shallowClone(2, "--no-single-branch");
    // Differential oracle: a twin clone deepened by Git's own command.
    const twin = shallowClone(2, "--no-single-branch");
    fixtureGit(twin, "fetch", "-q", "--deepen=3", "origin");
    const before = readFileSync(join(clone, "file.txt"), "utf8");
    const mainBefore = countCommits(clone, "origin/main");
    const result = await deepenHistory(git, clone, "origin", { kind: "deepen", commits: 3 });
    expect(result).toEqual(ok({ shallow: true }));
    expect(countCommits(clone, "origin/main")).toBeGreaterThan(mainBefore);
    expect(fixtureGit(clone, "rev-list", "--all").split("\n").sort()).toEqual(
      fixtureGit(twin, "rev-list", "--all").split("\n").sort()
    );
    expect(graftedCommits(clone)).toEqual(graftedCommits(twin));
    expect(readFileSync(join(clone, "file.txt"), "utf8")).toBe(before);
    // The committed blob, not the working file: Windows' default
    // core.autocrlf checks the file out with CRLF.
    expect(fixtureGit(clone, "show", "HEAD:file.txt")).toBe("12");
    expect(fixtureGit(clone, "status", "--porcelain")).toBe("");
    const state = await readShallowState(git, clone, "origin/main");
    if (!state.ok || state.value === null) throw new Error("expected shallow state");
    expect(state.value.boundaries).toEqual(graftedCommits(clone));
  });

  it("--unshallow makes the repository complete: full counts and the real merge-base", async () => {
    const clone = shallowClone(1, "--no-single-branch");
    // The fork point of side is behind the boundary: Git cannot find it yet.
    expect(() => fixtureGit(clone, "merge-base", "origin/main", "origin/side")).toThrow();
    const result = await deepenHistory(git, clone, "origin", { kind: "unshallow" });
    expect(result).toEqual(ok({ shallow: false }));
    expect(isShallow(clone)).toBe(false);
    expect(countCommits(clone, "origin/main")).toBe(countCommits(source, "main"));
    expect(fixtureGit(clone, "merge-base", "origin/main", "origin/side")).toBe(
      fixtureGit(source, "merge-base", "main", "side")
    );
    expect(await readShallowState(git, clone, "origin/main")).toEqual(ok(null));
  });

  it("keeps a single-branch clone single-branch: deepening never widens the refspec", async () => {
    const clone = shallowClone(1);
    const result = await deepenHistory(git, clone, "origin", { kind: "unshallow" });
    expect(result.ok).toBe(true);
    expect(fixtureGit(clone, "config", "--get-all", "remote.origin.fetch")).toBe(
      "+refs/heads/main:refs/remotes/origin/main"
    );
    expect(fixtureGit(clone, "branch", "-r")).not.toContain("origin/side");
  });

  it("refuses a remote that is not configured, including one shaped like an option", async () => {
    const clone = shallowClone(2, "--no-single-branch");
    for (const remote of ["upstream", "--upload-pack=touch /tmp/x", "-v"]) {
      const result = await deepenHistory(git, clone, remote, { kind: "unshallow" });
      expect(result).toMatchObject({ ok: false, error: { code: "remote_missing" } });
    }
    expect(isShallow(clone)).toBe(true);
  });

  it("refuses a malformed count before any fetch", async () => {
    const clone = shallowClone(2, "--no-single-branch");
    const mainBefore = countCommits(clone, "origin/main");
    const fetches: string[][] = [];
    const recording: GitExec = (args, cwd, options) => {
      if (args[0] === "fetch") fetches.push([...args]);
      return git(args, cwd, options);
    };
    for (const commits of [0, -1, 1.5, 100_001, Number.NaN]) {
      const result = await deepenHistory(recording, clone, "origin", { kind: "deepen", commits });
      expect(result).toMatchObject({ ok: false, error: { code: "invalid_history_depth" } });
    }
    expect(fetches).toEqual([]);
    expect(countCommits(clone, "origin/main")).toBe(mainBefore);
  });

  it("stops when cancelled and leaves the boundary as it was", async () => {
    const clone = shallowClone(2, "--no-single-branch");
    const before = graftedCommits(clone);
    const controller = new AbortController();
    controller.abort();
    const cancelled: GitExec = (args, cwd, options) =>
      git(args, cwd, args[0] === "fetch" ? { ...options, signal: controller.signal } : options);
    const result = await deepenHistory(cancelled, clone, "origin", { kind: "unshallow" });
    expect(result).toMatchObject({ ok: false, error: { code: "aborted" } });
    expect(isShallow(clone)).toBe(true);
    expect(graftedCommits(clone)).toEqual(before);
  });

  describe("against a server without shallow support (dumb HTTP)", () => {
    let server: Server;
    let url: string;
    beforeAll(async () => {
      const bare = join(root, "dumb.git");
      fixtureGit(root, "clone", "-q", "--bare", source, bare);
      fixtureGit(bare, "update-server-info");
      server = createServer((req, res) => {
        const path = normalize(join(bare, decodeURIComponent((req.url ?? "/").split("?")[0]!)));
        if (!path.startsWith(bare + sep)) {
          res.writeHead(403).end();
          return;
        }
        try {
          res.writeHead(200, { "content-type": "application/octet-stream" }).end(readFileSync(path));
        } catch {
          res.writeHead(404).end();
        }
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("no port");
      url = `http://127.0.0.1:${address.port}/`;
    });
    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it("reports the server's refusal in plain words and changes nothing", async () => {
      const clone = shallowClone(2, "--no-single-branch");
      fixtureGit(clone, "remote", "set-url", "origin", url);
      const before = graftedCommits(clone);
      for (const mode of [{ kind: "deepen", commits: 5 }, { kind: "unshallow" }] as const) {
        const result = await deepenHistory(git, clone, "origin", mode);
        expect(result).toMatchObject({ ok: false, error: { code: "shallow_unsupported" } });
        if (!result.ok) expect(result.error.message).toContain("doesn't support shallow");
      }
      expect(isShallow(clone)).toBe(true);
      expect(graftedCommits(clone)).toEqual(before);
    });
  });
});

describe("pure helpers", () => {
  it("deepenArgs puts the remote after --, and only a validated count before it", () => {
    expect(deepenArgs("origin", { kind: "deepen", commits: 100 })).toEqual(
      ok(["fetch", "--progress", "--deepen=100", "--", "origin"])
    );
    expect(deepenArgs("origin", { kind: "unshallow" })).toEqual(
      ok(["fetch", "--progress", "--unshallow", "--", "origin"])
    );
  });

  it("chooseHistoryRemote prefers the remote that publishes the default branch", () => {
    expect(chooseHistoryRemote(["origin", "upstream"], "upstream/main")).toBe("upstream");
    expect(chooseHistoryRemote(["team", "team/eu"], "team/eu/main")).toBe("team/eu");
    expect(chooseHistoryRemote(["upstream", "origin"], "main")).toBe("origin");
    expect(chooseHistoryRemote(["mirror"], "main")).toBe("mirror");
    expect(chooseHistoryRemote([], "main")).toBeNull();
  });

  it("fetchedBranches is null exactly when a refspec fetches every branch", () => {
    fc.assert(
      fc.property(
        fc.array(fc.stringMatching(/^[a-z][a-z0-9-]{0,8}$/), { maxLength: 4 }),
        fc.boolean(),
        (names, wildcard) => {
          const specs = [
            ...names.map((name) => `+refs/heads/${name}:refs/remotes/origin/${name}`),
            ...(wildcard ? ["+refs/heads/*:refs/remotes/origin/*"] : [])
          ];
          expect(fetchedBranches(specs)).toEqual(wildcard ? null : names);
        }
      )
    );
  });
});
