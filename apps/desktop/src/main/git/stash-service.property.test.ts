import { execFileSync } from "node:child_process";
import { appendFileSync, cpSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import type { GitExec } from "./dugite";
import { pullFastForward } from "./git-service";
import { dropStash, listStashes, popStash } from "./stash-service";
import { createSystemGit } from "./test-support/system-git";

/**
 * Model test for the stash stack, with git as the oracle. A primary checkout
 * and a linked worktree share one stack. The model is the list of stash
 * hashes, newest first; after every step `git stash list` must equal it,
 * and at the end so must PwrGit's own listing.
 *
 * - Before #512, PwrGit refused to drop or pop a stash whose ref `git gc` had
 *   packed (shrunk to `stash push; git gc; drop`).
 * - Before #543, a Pull that saved local work restored the newest stash, which
 *   a sibling worktree may have pushed meanwhile.
 */

const systemGit = createSystemGit();
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

type Where = "primary" | "linked";
type Real = { root: string; upstream: string; primary: string; linked: string; next: number };
type Model = {
  stashes: string[];
  /** Pull recovery entries whose work Pull already restored. */
  restored: Set<string>;
};

let template = "";
beforeAll(() => {
  template = realpathSync.native(mkdtempSync(join(tmpdir(), "pwrgit-stash-template-")));
  const upstream = join(template, "upstream");
  const primary = join(template, "primary");
  execFileSync("git", ["init", "-q", "-b", "main", upstream]);
  git(upstream, ["config", "user.email", "t@t.com"]);
  git(upstream, ["config", "user.name", "Tester"]);
  git(upstream, ["config", "core.autocrlf", "false"]);
  writeFileSync(join(upstream, "base.txt"), "base\n");
  git(upstream, ["add", "."]);
  git(upstream, ["commit", "-q", "-m", "base"]);
  execFileSync("git", ["-c", "core.autocrlf=false", "clone", "-q", upstream, primary]);
  git(primary, ["config", "user.email", "t@t.com"]);
  git(primary, ["config", "user.name", "Tester"]);
  git(primary, ["config", "core.autocrlf", "false"]);
  // No background gc between commands: the model decides when gc runs.
  git(primary, ["config", "gc.auto", "0"]);
  git(primary, ["worktree", "add", "-q", "-b", "side", join(template, "linked")]);
});
afterAll(() => {
  if (template !== "") rmSync(template, { recursive: true, force: true });
});

/** A copy of the template: two git calls instead of building it each run. */
function setup(): Real {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "pwrgit-stash-model-")));
  roots.push(root);
  cpSync(template, root, { recursive: true });
  const upstream = join(root, "upstream");
  const primary = join(root, "primary");
  const linked = join(root, "linked");
  git(primary, ["worktree", "repair", linked]);
  git(primary, ["remote", "set-url", "origin", upstream]);
  return { root, upstream, primary, linked, next: 0 };
}

const stashList = (r: Real): string[] => {
  const out = git(r.primary, ["stash", "list", "--format=%H"]);
  return out === "" ? [] : out.split("\n");
};

function assertOracle(m: Model, r: Real): void {
  expect(stashList(r)).toEqual(m.stashes);
}

/** Run the commands, then ask PwrGit's own listing, from the other checkout. */
async function runModel(cmds: Iterable<Cmd>): Promise<void> {
  let state: { model: Model; real: Real } | undefined;
  await fc.asyncModelRun(() => (state = { model: { stashes: [], restored: new Set<string>() }, real: setup() }), cmds);
  const listed = await listStashes(systemGit, state!.real.linked);
  expect(listed.ok && listed.value.map((entry) => entry.hash)).toEqual(state!.model.stashes);
}

type Cmd = fc.AsyncCommand<Model, Real>;

/** New work in one checkout: a staged new file and an untracked one, with
 *  names no other step uses, so a later apply cannot conflict. */
class StashPush implements Cmd {
  constructor(readonly where: Where) {}
  check = () => true;
  async run(m: Model, r: Real) {
    const dir = r[this.where];
    const n = r.next++;
    writeFileSync(join(dir, `staged-${n}.txt`), `staged ${n}\n`);
    git(dir, ["add", `staged-${n}.txt`]);
    writeFileSync(join(dir, `loose-${n}.txt`), `loose ${n}\n`);
    git(dir, ["stash", "push", "-q", "--include-untracked", "-m", `model ${n}`]);
    m.stashes.unshift(git(dir, ["rev-parse", "refs/stash"]));
    assertOracle(m, r);
  }
  toString = () => `stash push (${this.where})`;
}

class Gc implements Cmd {
  check = () => true;
  async run(m: Model, r: Real) {
    git(r.primary, ["gc", "-q"]);
    assertOracle(m, r);
  }
  toString = () => "git gc";
}

class PackRefs implements Cmd {
  check = () => true;
  async run(m: Model, r: Real) {
    git(r.primary, ["pack-refs", "--all"]);
    assertOracle(m, r);
  }
  toString = () => "git pack-refs --all";
}

class Commit implements Cmd {
  constructor(readonly where: Where) {}
  check = () => true;
  async run(m: Model, r: Real) {
    const dir = r[this.where];
    const n = r.next++;
    writeFileSync(join(dir, `commit-${n}.txt`), `commit ${n}\n`);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", `commit ${n}`]);
    assertOracle(m, r);
  }
  toString = () => `commit (${this.where})`;
}

class GitDrop implements Cmd {
  check = (m: Readonly<Model>) => m.stashes.length > 0;
  async run(m: Model, r: Real) {
    git(r.primary, ["stash", "drop", "-q"]);
    m.stashes.shift();
    assertOracle(m, r);
  }
  toString = () => "git stash drop";
}

/** PwrGit removes any entry `git stash list` shows, by hash, from either
 *  checkout; Pop also brings its work into that checkout. */
class PwrGitRemove implements Cmd {
  constructor(readonly kind: "drop" | "pop", readonly pick: number, readonly where: Where) {}
  check = (m: Readonly<Model>) => m.stashes.length > 0;
  async run(m: Model, r: Real) {
    const index = this.pick % m.stashes.length;
    const hash = m.stashes[index]!;
    // Pull keeps its recovery entry after restoring the work, so that work is
    // already in the checkout: git refuses to pop it over itself, on purpose.
    if (this.kind === "pop" && m.restored.has(hash)) return;
    const remove = this.kind === "drop" ? dropStash : popStash;
    expect(await remove(systemGit, r[this.where], hash)).toEqual({ ok: true, value: undefined });
    m.stashes.splice(index, 1);
    assertOracle(m, r);
  }
  toString = () => `PwrGit ${this.kind} #${this.pick} (${this.where})`;
}

type SiblingPush = "never" | "after save" | "at fast-forward" | "before restore";

/**
 * Upstream gains a commit, the primary has its own staged and unstaged work,
 * and Pull saves it, fast-forwards and restores it, while the linked worktree
 * may push a stash of its own at any of those points. Pull must restore
 * exactly its own work and leave every other entry listed, unchanged.
 */
class Pull implements Cmd {
  constructor(readonly sibling: SiblingPush) {}
  check = () => true;
  async run(m: Model, r: Real) {
    const n = r.next++;
    writeFileSync(join(r.upstream, `upstream-${n}.txt`), `upstream ${n}\n`);
    git(r.upstream, ["add", "."]);
    git(r.upstream, ["commit", "-q", "-m", `upstream ${n}`]);
    writeFileSync(join(r.primary, `own-${n}.txt`), "staged\n");
    git(r.primary, ["add", `own-${n}.txt`]);
    appendFileSync(join(r.primary, `own-${n}.txt`), "unstaged\n");
    const before = {
      staged: git(r.primary, ["diff", "--cached"]),
      unstaged: git(r.primary, ["diff"]),
      untracked: git(r.primary, ["ls-files", "--others", "--exclude-standard"])
    };
    const prior = stashList(r);

    let foreign: string | undefined;
    const pushForeign = (): void => {
      if (foreign !== undefined) return;
      writeFileSync(join(r.linked, `sibling-${n}.txt`), `sibling ${n}\n`);
      git(r.linked, ["stash", "push", "-q", "--include-untracked", "-m", `sibling ${n}`]);
      foreign = git(r.linked, ["rev-parse", "refs/stash"]);
    };
    const interleaved: GitExec = async (args, cwd, options) => {
      if (this.sibling === "before restore" && args[0] === "stash" && args[1] === "apply") pushForeign();
      const result = await systemGit(args, cwd, options);
      if (this.sibling === "after save" && args[0] === "stash" && args[1] === "push") pushForeign();
      return result;
    };
    const pulled = await pullFastForward(interleaved, r.primary, (phase) => {
      if (this.sibling === "at fast-forward" && phase === "fast_forward") pushForeign();
    });
    expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
    if (!pulled.ok) return;

    expect(git(r.primary, ["rev-parse", "HEAD"])).toBe(git(r.upstream, ["rev-parse", "HEAD"]));
    expect({
      staged: git(r.primary, ["diff", "--cached"]),
      unstaged: git(r.primary, ["diff"]),
      untracked: git(r.primary, ["ls-files", "--others", "--exclude-standard"])
    }).toEqual(before);

    // Pull keeps its recovery entry; with the sibling's, they are the only
    // new entries, and every older one is still listed, in order.
    const after = stashList(r);
    const added = after.slice(0, after.length - prior.length);
    expect(after.slice(added.length)).toEqual(prior);
    expect(added.sort()).toEqual(
      [pulled.value.recoveryStash, foreign].filter((h): h is string => h !== undefined).sort()
    );
    if (foreign !== undefined) {
      // Same hash, same content: an untracked file lives in the third parent.
      expect(git(r.linked, ["show", `${foreign}^3:sibling-${n}.txt`])).toBe(`sibling ${n}`);
    }
    m.stashes = after;
    if (pulled.value.recoveryStash !== undefined) m.restored.add(pulled.value.recoveryStash);
    // The sibling's work went to the stash, not into the primary.
    expect(git(r.primary, ["ls-files", "--", `sibling-${n}.txt`])).toBe("");
    assertOracle(m, r);
  }
  toString = () => `pull (sibling stash: ${this.sibling})`;
}

// Each step runs a few real git commands (about 10 ms each here, several
// times that on the Windows runner), and each test must finish well inside
// vitest.config.ts's 20 s on Windows too. Linux and macOS take more runs.
const windows = process.platform === "win32";

const where = fc.constantFrom<Where>("primary", "linked");
const stashPush = where.map((w) => new StashPush(w));
const gc = fc.constant(new Gc());
const pwrgitRemove = fc.tuple(fc.constantFrom<"drop" | "pop">("drop", "pop"), fc.nat(5), where)
  .map(([kind, pick, w]) => new PwrGitRemove(kind, pick, w));

it("PwrGit drops and pops any stash git lists, and its listing matches git's after every step", async () => {
  await fc.assert(
    // Pushes and PwrGit removals are listed twice: weighted up, since every
    // other step only matters once there is a stash to remove.
    fc.asyncProperty(fc.commands([
      stashPush,
      stashPush,
      gc,
      fc.constant(new PackRefs()),
      // Only on the linked worktree's branch: a commit on the primary's
      // `main` diverges it from upstream, and Pull refuses that on purpose.
      fc.constant(new Commit("linked")),
      fc.constant(new GitDrop()),
      pwrgitRemove,
      pwrgitRemove
    ], { maxCommands: 8 }), async (cmds) => {
      await runModel(cmds);
    }),
    { numRuns: windows ? 10 : 30 }
  );
});

it("Pull restores exactly its own work and leaves every other stash entry listed", async () => {
  await fc.assert(
    fc.asyncProperty(fc.commands([
      stashPush,
      gc,
      pwrgitRemove,
      fc.constantFrom<SiblingPush>("never", "after save", "at fast-forward", "before restore")
        .map((s) => new Pull(s))
    ], { maxCommands: 5 }), async (cmds) => {
      await runModel(cmds);
    }),
    { numRuns: windows ? 5 : 12 }
  );
});
