import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { CommandBus } from "../command-bus";
import { openDatabase, type DB } from "../persistence/db";
import { ProfileService } from "../profiles/profile-service";
import type { SettingsService } from "../settings/settings-service";
import { registerBranchHandlers } from "./branch-handlers";
import { RepoIndexer } from "./repo-indexer";
import { createSystemGit } from "./test-support/system-git";
import { registerWorktreeLifecycleHandlers } from "./worktree-lifecycle-handlers";
import { WorktreeOperationQueue } from "./worktree-operation-queue";
import { WorktreeStateService } from "./worktree-state";

vi.mock("../ipc", () => ({ emitEvent: vi.fn() }));
vi.mock("../logs", () => ({ logMain: vi.fn() }));

/**
 * Oracle test for worktrees that vanish behind PwrGit's back: an agent deletes
 * a checkout's folder or its `.git` link, or someone runs `git worktree prune`.
 * After PwrGit re-indexes, `git worktree list --porcelain` is the oracle:
 *
 * - PwrGit has a row for exactly the entries git lists, with git's branch,
 *   flagged missing exactly when git says `prunable`;
 * - no entry whose folder is gone survives a re-index (git would refuse its
 *   branch everywhere else);
 * - removing a row PwrGit shows leaves neither the row nor git's entry;
 * - every branch PwrGit offers as free to switch to does switch.
 *
 * Without #492's drop of vanished entries it fails within a few runs, shrunk
 * to `worktree add; rm -rf worktree`.
 */

const systemGit = createSystemGit();
const roots: string[] = [];
let template = "";
let db: DB;
let profileId = "";

function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

beforeAll(() => {
  template = realpathSync.native(mkdtempSync(join(tmpdir(), "pwrgit-vanished-template-")));
  execFileSync("git", ["init", "-q", "-b", "main", template]);
  git(template, ["config", "user.email", "t@t.com"]);
  git(template, ["config", "user.name", "Tester"]);
  git(template, ["config", "gc.auto", "0"]);
  writeFileSync(join(template, "a.txt"), "1\n");
  git(template, ["add", "."]);
  git(template, ["commit", "-q", "-m", "baseline"]);
  // Something is always free to switch to.
  git(template, ["branch", "spare"]);
  db = openDatabase(":memory:");
  profileId = new ProfileService(db).create({ name: "Work", email: "t@t.com" }).id;
});
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
afterAll(() => {
  if (template !== "") rmSync(template, { recursive: true, force: true });
});

type Real = {
  root: string;
  primary: string;
  repoId: string;
  indexer: RepoIndexer;
  bus: CommandBus;
  next: number;
};
type Model = { linked: { path: string; branch: string }[] };
type Cmd = fc.AsyncCommand<Model, Real>;

async function setup(): Promise<Real> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "pwrgit-vanished-model-")));
  roots.push(root);
  const primary = join(root, "repo");
  cpSync(template, primary, { recursive: true });
  const indexer = new RepoIndexer(db, systemGit);
  const added = await indexer.indexRepoAt(profileId, primary);
  if (!added.ok) throw new Error(added.error.message);
  const operations = new WorktreeOperationQueue();
  const state = new WorktreeStateService(db, systemGit, operations);
  const refresher = { refreshWorktree: async () => {}, refreshRepoWorktrees: async () => {} };
  const bus = new CommandBus();
  registerBranchHandlers(bus, db, indexer, refresher, operations, {} as SettingsService);
  registerWorktreeLifecycleHandlers(bus, db, indexer, {} as SettingsService, state, operations);
  return { root, primary, repoId: added.value.id, indexer, bus, next: 0 };
}

type Listed = { path: string; branch: string; prunable: boolean };
function gitWorktrees(r: Real): Listed[] {
  return git(r.primary, ["worktree", "list", "--porcelain"]).split(/\r?\n\r?\n/).map((block) => {
    const lines = block.split(/\r?\n/);
    const value = (key: string) => lines.find((l) => l.startsWith(`${key} `))?.slice(key.length + 1);
    return {
      path: value("worktree")!,
      branch: (value("branch") ?? "").replace(/^refs\/heads\//, ""),
      prunable: lines.some((l) => l === "prunable" || l.startsWith("prunable "))
    };
  });
}

type Row = { id: string; path: string; branch: string; missing: number; is_primary: number };
const appRows = (r: Real): Row[] =>
  db.prepare("SELECT id, path, branch, missing, is_primary FROM worktrees WHERE repo_id = ?")
    .all(r.repoId) as Row[];

/** PwrGit's rows against git's listing, taken after a re-index. */
function assertMatchesGit(r: Real): void {
  const listed = gitWorktrees(r);
  const rows = appRows(r);
  const byPath = (a: { path: string }, b: { path: string }) => a.path.localeCompare(b.path);
  expect(rows.map((row) => ({ path: row.path, branch: row.branch, missing: row.missing === 1 })).sort(byPath))
    .toEqual(listed.map((w) => ({ path: w.path, branch: w.branch, missing: w.prunable })).sort(byPath));
  // Nothing here is locked or on a removable volume, so a gone folder is
  // gone for good: its entry must not outlive the pass.
  expect(listed.filter((w) => !existsSync(w.path)).map((w) => w.path)).toEqual([]);
}

async function reindex(r: Real): Promise<void> {
  const refreshed = await r.indexer.refreshRepoWorktrees(r.repoId);
  expect(refreshed.ok, JSON.stringify(refreshed)).toBe(true);
}

class Add implements Cmd {
  constructor(readonly nested: boolean) {}
  check = () => true;
  async run(m: Model, r: Real) {
    const n = r.next++;
    // Agents nest worktrees inside the checkout (`.claude/worktrees/<name>`).
    const target = this.nested ? join(r.primary, ".claude", "worktrees", `w${n}`) : join(r.root, `w${n}`);
    git(r.primary, ["worktree", "add", "-q", "-b", `w${n}`, target]);
    // Keep git's spelling of the path: rows store it, and node:path's would
    // differ on Windows (backslashes), so a lookup would never match.
    const path = gitWorktrees(r).find((w) => w.branch === `w${n}`)!.path;
    m.linked.push({ path, branch: `w${n}` });
  }
  toString = () => `worktree add${this.nested ? " (nested)" : ""}`;
}

class RemoveFolder implements Cmd {
  constructor(readonly pick: number) {}
  check = (m: Readonly<Model>) => m.linked.length > 0;
  async run(m: Model) {
    rmSync(m.linked[this.pick % m.linked.length]!.path, { recursive: true, force: true });
  }
  toString = () => `rm -rf worktree #${this.pick}`;
}

class RemoveLink implements Cmd {
  constructor(readonly pick: number) {}
  check = (m: Readonly<Model>) => m.linked.length > 0;
  async run(m: Model) {
    rmSync(join(m.linked[this.pick % m.linked.length]!.path, ".git"), { force: true });
  }
  toString = () => `rm worktree #${this.pick}/.git`;
}

class Prune implements Cmd {
  check = () => true;
  async run(_m: Model, r: Real) {
    git(r.primary, ["worktree", "prune"]);
  }
  toString = () => "git worktree prune";
}

class Reindex implements Cmd {
  check = () => true;
  async run(_m: Model, r: Real) {
    await reindex(r);
    assertMatchesGit(r);
  }
  toString = () => "PwrGit re-index";
}

/** Remove from PwrGit, as the sidebar does, whatever its row now stands for. */
class AppRemove implements Cmd {
  constructor(readonly pick: number) {}
  check = (m: Readonly<Model>) => m.linked.length > 0;
  async run(m: Model, r: Real) {
    const { path } = m.linked[this.pick % m.linked.length]!;
    const row = appRows(r).find((w) => w.path === path);
    // Files without a `.git` link are kept on purpose: git refuses to remove
    // them, and the user decides.
    if (row === undefined || (existsSync(path) && !existsSync(join(path, ".git")))) return;
    const result = await r.bus.dispatch("worktree:removeMany", { worktreeIds: [row.id] });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(appRows(r).map((w) => w.path)).not.toContain(path);
    expect(gitWorktrees(r).map((w) => w.path)).not.toContain(path);
  }
  toString = () => `PwrGit remove worktree #${this.pick}`;
}

/**
 * Switch the main checkout to a branch PwrGit says no worktree holds, as of a
 * re-index. Before one, a worktree added outside PwrGit is not yet a row, and
 * git's refusal (`checked_out_elsewhere`) is the handled answer to that.
 */
class Switch implements Cmd {
  constructor(readonly pick: number) {}
  check = () => true;
  async run(_m: Model, r: Real) {
    await reindex(r);
    const primary = appRows(r).find((w) => w.is_primary === 1)!;
    const refs = await r.bus.dispatch("repo:refs", { repoId: r.repoId });
    expect(refs.ok, JSON.stringify(refs)).toBe(true);
    if (!refs.ok) return;
    const current = git(r.primary, ["branch", "--show-current"]);
    const offered = refs.value.branches
      .filter((b) => b.checkedOutWorktreeIds.length === 0 && b.name !== current)
      .map((b) => b.name);
    if (offered.length === 0) return;
    const branch = offered[this.pick % offered.length]!;
    const switched = await r.bus.dispatch("branch:switch", { worktreeId: primary.id, branch });
    expect(switched.ok, `${branch}: ${JSON.stringify(switched)}`).toBe(true);
    expect(git(r.primary, ["branch", "--show-current"])).toBe(branch);
  }
  toString = () => `switch main checkout to free branch #${this.pick}`;
}

// About ten real git commands per step, several times dearer on the Windows
// runner; each test must stay well inside vitest.config.ts's 20 s there.
const windows = process.platform === "win32";

it("PwrGit's worktrees match git's after vanished folders, links and prunes", async () => {
  await fc.assert(
    fc.asyncProperty(fc.commands([
      fc.boolean().map((nested) => new Add(nested)),
      fc.boolean().map((nested) => new Add(nested)),
      fc.nat(5).map((pick) => new RemoveFolder(pick)),
      fc.nat(5).map((pick) => new RemoveLink(pick)),
      fc.constant(new Prune()),
      fc.constant(new Reindex()),
      fc.nat(5).map((pick) => new AppRemove(pick)),
      fc.nat(5).map((pick) => new Switch(pick))
    ], { maxCommands: 10 }), async (cmds) => {
      let real: Real | undefined;
      const built = await setup();
      await fc.asyncModelRun(() => ({ model: { linked: [] }, real: (real = built) }), cmds);
      // Whatever the steps left behind, a final pass must agree with git.
      await reindex(real!);
      assertMatchesGit(real!);
    }),
    { numRuns: windows ? 8 : 25 }
  );
});
