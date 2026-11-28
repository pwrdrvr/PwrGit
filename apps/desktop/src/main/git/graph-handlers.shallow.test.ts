import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { LaneGraph } from "@pwrgit/shared";
import { CommandBus } from "../command-bus";
import { openDatabase } from "../persistence/db";
import { ProfileService } from "../profiles/profile-service";
import type { GitExec } from "./dugite";
import { RepoIndexer } from "./repo-indexer";
import { WorktreeStateService } from "./worktree-state";
import { createSystemGit } from "./test-support/system-git";
import {
  createHistorySource,
  fileUrl,
  fixtureGit,
  graftedCommits
} from "./test-support/shallow-fixture";

// graph-handlers reaches for `execGit` directly; swap the module as
// graph-handlers.test.ts does.
const { systemGit } = vi.hoisted(() => {
  let impl: GitExec | undefined;
  return {
    systemGit: (async (args, cwd, options) =>
      (impl ??= createSystemGit())(args, cwd, options)) satisfies GitExec
  };
});
vi.mock("./dugite", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./dugite")>();
  return { ...actual, execGit: systemGit };
});
const { registerGraphHandlers } = await import("./graph-handlers");

let root: string;
let source: string;

beforeAll(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "pwrgit-graph-shallow-")));
  source = createHistorySource(join(root, "source"));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

let n = 0;
async function lanesFor(repo: string): Promise<LaneGraph> {
  const db = openDatabase(":memory:");
  const profile = new ProfileService(db).create({ name: `G${(n += 1)}`, email: "g@example.com", roots: [root] });
  const indexed = await new RepoIndexer(db, systemGit).indexRepoAt(profile.id, repo);
  if (!indexed.ok) throw new Error(indexed.error.message);
  const bus = new CommandBus();
  registerGraphHandlers(bus, db, new WorktreeStateService(db, systemGit));
  const res = await bus.dispatch("graph:lanes", {
    worktreeId: indexed.value.worktrees[0]!.id,
    scope: "all",
    force: true
  });
  db.close();
  if (!res.ok) throw new Error(res.error.message);
  return res.value;
}

describe("graph:lanes in a shallow repository", () => {
  // Rule (oracle: Git's own `grafted` decoration): every drawn commit whose
  // parents were never downloaded is reported as a boundary, and nothing
  // else is. Before this, the graph drew such a commit as the project's first
  // and said nothing.
  it("marks exactly the drawn commits Git calls grafted, at several depths", async () => {
    for (const depth of [1, 2, 3]) {
      const clone = join(root, `clone-${depth}`);
      fixtureGit(root, "clone", "-q", `--depth=${depth}`, "--no-single-branch", fileUrl(source), clone);
      const graph = await lanesFor(clone);
      const drawn = new Set(graph.commits.map((commit) => commit.hash));
      const grafted = [...graftedCommits(clone)].filter((hash) => drawn.has(hash));
      expect(grafted.length).toBeGreaterThan(0);
      expect(graph.shallow).toBeDefined();
      expect(new Set(graph.shallow!.boundaries)).toEqual(new Set(grafted));
      expect(graph.shallow!.remote).toBe("origin");
      expect(graph.shallow!.fetchesOnly).toBeNull();
      // A boundary is drawn as Git reports it: with no parents.
      for (const hash of graph.shallow!.boundaries) {
        expect(graph.commits.find((commit) => commit.hash === hash)?.parents).toEqual([]);
      }
    }
  });

  it("names the one fetched branch of a single-branch clone", async () => {
    const clone = join(root, "single");
    fixtureGit(root, "clone", "-q", "--depth=2", fileUrl(source), clone);
    const graph = await lanesFor(clone);
    expect(graph.shallow?.fetchesOnly).toEqual(["main"]);
  });

  it("reports no boundary for a complete repository, whose root is a real root", async () => {
    const graph = await lanesFor(source);
    expect(graph.shallow).toBeUndefined();
    expect(graph.commits.some((commit) => commit.parents.length === 0)).toBe(true);
  });

  it("drops the boundary once the history is complete, without a cached answer", async () => {
    const clone = join(root, "deepened");
    fixtureGit(root, "clone", "-q", "--depth=1", "--no-single-branch", fileUrl(source), clone);
    expect((await lanesFor(clone)).shallow).toBeDefined();
    fixtureGit(clone, "fetch", "-q", "--unshallow", "origin");
    expect((await lanesFor(clone)).shallow).toBeUndefined();
  });
});
