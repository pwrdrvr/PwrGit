import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ok } from "@pwrgit/shared";
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
};

beforeAll(() => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "pwrgit-stash-model-")));
  const primary = join(root, "primary");
  const linked = join(root, "linked");
  const upstream = join(root, "upstream");
  removal = { root, upstream, primary, linked, next: 0 };
  execFileSync("git", ["init", "-q", "-b", "main", primary]);
  git(primary, ["config", "user.email", "t@t.com"]);
  git(primary, ["config", "user.name", "Tester"]);
  git(primary, ["config", "core.autocrlf", "false"]);
  // No background gc between commands: the model decides when gc runs.
  git(primary, ["config", "gc.auto", "0"]);
  writeFileSync(join(primary, "base.txt"), "base\n");
  git(primary, ["add", "."]);
  git(primary, ["commit", "-q", "-m", "base"]);
  git(primary, ["worktree", "add", "-q", "-b", "side", linked]);
  // A local tracking branch is a real Git upstream. Using another checkout
  // of it exercises the stash/fast-forward/restore path without a clone or
  // transferring objects, which are outside the stash ownership property.
  git(primary, ["worktree", "add", "-q", "-b", "incoming", upstream]);
  git(primary, ["branch", "--set-upstream-to=incoming", "main"]);
});
afterAll(() => {
  if (removal !== undefined) rmSync(removal.root, { recursive: true, force: true });
});

const stashList = (r: Real): string[] => {
  const out = git(r.primary, ["stash", "list", "--format=%H"]);
  return out === "" ? [] : out.split("\n");
};

function assertOracle(m: Model, r: Real): void {
  expect(stashList(r)).toEqual(m.stashes);
}

/** Run the commands, then ask PwrGit's own listing, from the other checkout. */
async function runModel(cmds: Iterable<Cmd>, initial: () => { model: Model; real: Real }): Promise<void> {
  let state: { model: Model; real: Real } | undefined;
  await fc.asyncModelRun(() => (state = initial()), cmds);
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
    const remove = this.kind === "drop" ? dropStash : popStash;
    expect(await remove(systemGit, r[this.where], hash)).toEqual({ ok: true, value: undefined });
    m.stashes.splice(index, 1);
    assertOracle(m, r);
  }
  toString = () => `PwrGit ${this.kind} #${this.pick} (${this.where})`;
}

type SiblingPush = "after save" | "at fast-forward" | "before restore";

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
    const prior = stashList(r);

    let foreign: string | undefined;
    const pushForeign = (): void => {
      if (foreign !== undefined) return;
      writeFileSync(join(r.linked, `sibling-${n}.txt`), `sibling ${n}\n`);
      git(r.linked, ["stash", "push", "-q", "--include-untracked", "-m", `sibling ${n}`]);
      foreign = git(r.linked, ["rev-parse", "refs/stash"]);
    };
    const interleaved: GitExec = async (args, cwd, options) => {
      // The local tracking branch already shares this object store and refs.
      // Fetch has nothing to transfer; keep this property focused on real
      // stash/merge/apply commands. Remote transport has its own tests.
      if (args[0] === "fetch") return ok({ stdout: "", stderr: "", exitCode: 0 });
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
    expect(foreign, "the generated sibling push must run").toBeDefined();
    expect(pulled.value.recoveryStash).toEqual(expect.any(String));

    expect(git(r.primary, ["rev-parse", "HEAD"])).toBe(git(r.upstream, ["rev-parse", "HEAD"]));
    // The fixture writes these exact bytes: inspect the index and working
    // file directly instead of taking six before/after diff/list snapshots.
    // Status also rules out any other staged, unstaged or untracked work.
    expect(git(r.primary, ["show", `:own-${n}.txt`])).toBe("staged");
    expect(readFileSync(join(r.primary, `own-${n}.txt`), "utf8")).toBe("staged\nunstaged\n");
    expect(git(r.primary, ["status", "--porcelain=v1", "-z"])).toBe(`AM own-${n}.txt\0`);

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
    // The sibling's work went to the stash, not into the primary.
    expect(existsSync(join(r.primary, `sibling-${n}.txt`))).toBe(false);
  }
  toString = () => `pull (sibling stash: ${this.sibling})`;
}

/** Snapshot the mutable stack, branch tips and indexes. The Git objects
 * are reused; each saved stack was produced by real stash pushes and gc.
 * Restoring bytes avoids a clone, worktree repair and git reset per run. */
type Stack = { stashes: string[]; files: Map<string, Buffer | undefined> };
let removal: Real;
const stacks: Stack[] = [];
beforeAll(async () => {
  const model: Model = { stashes: [] };
  const save = (): void => {
    const files = new Map<string, Buffer | undefined>();
    for (const path of [
      join(removal.primary, ".git", "refs", "stash"),
      join(removal.primary, ".git", "logs", "refs", "stash"),
      join(removal.primary, ".git", "packed-refs"),
      join(removal.primary, ".git", "index"),
      join(removal.primary, ".git", "worktrees", "linked", "index"),
      join(removal.primary, ".git", "worktrees", "upstream", "index"),
      join(removal.primary, ".git", "refs", "heads", "main"),
      join(removal.primary, ".git", "refs", "heads", "incoming")
    ]) {
      try { files.set(path, readFileSync(path)); }
      catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
        files.set(path, undefined);
      }
    }
    stacks.push({ stashes: [...model.stashes], files });
  };
  await new StashPush("primary").run(model, removal);
  await new Gc().run(model, removal);
  save(); // One packed entry: removing it must also remove the packed ref.
  await new StashPush("linked").run(model, removal);
  save(); // A loose tip shadows an older packed value.
  await new PackRefs().run(model, removal);
  save(); // Two entries with a packed tip; remove either position.
});

function restoreStack(stack: Stack): { model: Model; real: Real } {
  for (const [path, bytes] of stack.files) {
    if (bytes === undefined) rmSync(path, { force: true });
    else writeFileSync(path, bytes);
  }
  // Remove files restored by Pop or written by Pull. The snapshots reset
  // both branch tips and indexes, including during fast-check shrinking.
  for (const dir of [removal.primary, removal.linked, removal.upstream]) {
    for (let n = 0; n < removal.next; n++) {
      for (const prefix of ["staged", "loose", "own", "sibling", "upstream"]) {
        rmSync(join(dir, `${prefix}-${n}.txt`), { force: true });
      }
    }
  }
  return { model: { stashes: [...stack.stashes] }, real: removal };
}

const where = fc.constantFrom<Where>("primary", "linked");
const pwrgitRemove = fc.tuple(fc.constantFrom<"drop" | "pop">("drop", "pop"), fc.nat(5), where)
  .map(([kind, pick, w]) => new PwrGitRemove(kind, pick, w));

it("PwrGit drops and pops any stash git lists, and its listing matches git's after every step", async () => {
  await fc.assert(
    // Every run exercises a removal, rather than spending runs on empty
    // stacks or unrelated commits. One optional step still checks transitions
    // between Git's drop and PwrGit's removal, including the last entry.
    fc.asyncProperty(fc.integer({ min: 0, max: 2 }), pwrgitRemove, fc.commands([
      pwrgitRemove, fc.constant(new GitDrop())
    ], { maxCommands: 1 }), async (layout, first, cmds) => {
      await runModel([first, ...cmds], () => restoreStack(stacks[layout]!));
    }),
    // Windows CI measured ~0.3–0.4 s per removal run; leave room for the
    // shared real-git fixture and the more expensive Pull property below.
    { numRuns: 5 }
  );
});

it("Pull restores exactly its own work and leaves every other stash entry listed", async () => {
  await fc.assert(
    // A single Pull per run, always with both a prior entry and a sibling
    // push. Longer command lists could perform several expensive Pulls yet
    // also spend whole runs without checking Pull at all. Detailed timing
    // cases are covered by pull-stash-ownership.test.ts.
    fc.asyncProperty(
      fc.constantFrom<SiblingPush>("after save", "at fast-forward", "before restore"),
      async (sibling) => {
        await runModel([new Pull(sibling)], () => restoreStack(stacks[2]!));
      }),
    // Keep one generated Pull; deterministic interleaving tests also live
    // in pull-stash-ownership.test.ts.
    { numRuns: 1 }
  );
});
