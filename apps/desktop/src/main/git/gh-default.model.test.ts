import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, expect, it } from "vitest";
import { ghDefaultNotice } from "@pwrgit/shared";
import { readGhDefault, setGhDefault } from "./repository-setup";
import { createSystemGit } from "./test-support/system-git";

/**
 * Model test for gh's default repository in one clone, with real Git holding
 * the config. Commands are the things that change it in life: adding and
 * removing remotes, `gh repo set-default` (its own writes, replayed with Git:
 * unset the current default's key, then `--add base` on the first remote for
 * the repository, per cli/cli `setdefault.go`), PwrGit's "Use for gh", and the
 * Pull card's "this fork has moved on" answer.
 *
 * After every step, PwrGit's reading must match the model's, and the header
 * chip must show exactly when gh's target disagrees with the moved-on answer
 * or gh is guessing between different repositories.
 */

const NAMES = ["origin", "upstream", "github", "pwrdrvr", "zeta"] as const;
const REPOS = ["mara/app", "northwind/app", "other/app"] as const;
const systemGit = createSystemGit();

type Model = {
  remotes: Map<string, string>;
  keys: Map<string, string[]>;
  movedOn: string | null;
};
type Real = { dir: string };

// gh's ranking, written as buckets rather than a comparator.
function ranked(model: Model): string[] {
  const bucket = (name: string): number => ({ upstream: 0, github: 1, origin: 2 } as Record<string, number>)[name] ?? 3;
  return [...model.remotes.keys()].sort((a, b) => bucket(a) - bucket(b) || (a < b ? -1 : a > b ? 1 : 0));
}

function modelTarget(model: Model): { repository: string | null; guessing: boolean } {
  const order = ranked(model);
  const resolved = order.find((name) => (model.keys.get(name) ?? []).length > 0);
  if (resolved !== undefined) return { repository: model.remotes.get(resolved)!, guessing: false };
  const distinct = new Set(order.map((name) => model.remotes.get(name)));
  return { repository: order[0] === undefined ? null : model.remotes.get(order[0])!, guessing: distinct.size > 1 };
}

// `-C` from a stable cwd: Git for Windows can hold a cwd inside a directory
// we later remove (src/main/git/AGENTS.md).
function git(dir: string, ...args: string[]): void {
  execFileSync("git", ["-C", dir, ...args], { cwd: tmpdir(), stdio: "ignore" });
}

async function check(model: Model, real: Real): Promise<void> {
  const gh = await readGhDefault(systemGit, real.dir);
  const expected = modelTarget(model);
  expect(gh?.repository ?? null).toBe(expected.repository);
  expect(gh?.status === "ambiguous").toBe(expected.guessing);
  const intended = model.movedOn === null ? undefined : model.remotes.get(model.movedOn);
  const disagrees = intended !== undefined && expected.repository !== intended;
  const silencedByFork = intended !== undefined && !disagrees;
  const shows = disagrees || (expected.guessing && !silencedByFork);
  expect(ghDefaultNotice(gh, model.movedOn) !== null, JSON.stringify({ model: [...model.remotes], keys: [...model.keys], movedOn: model.movedOn })).toBe(shows);
}

class AddRemote implements fc.AsyncCommand<Model, Real> {
  constructor(readonly name: string, readonly repo: string) {}
  check = (m: Readonly<Model>): boolean => !m.remotes.has(this.name);
  async run(m: Model, r: Real): Promise<void> {
    git(r.dir, "remote", "add", this.name, `git@github.com:${this.repo}.git`);
    m.remotes.set(this.name, this.repo);
    await check(m, r);
  }
  toString = (): string => `add ${this.name}=${this.repo}`;
}

class RemoveRemote implements fc.AsyncCommand<Model, Real> {
  constructor(readonly name: string) {}
  check = (m: Readonly<Model>): boolean => m.remotes.has(this.name);
  async run(m: Model, r: Real): Promise<void> {
    // `git remote remove` drops the remote's whole section, gh-resolved too.
    git(r.dir, "remote", "remove", this.name);
    m.remotes.delete(this.name);
    m.keys.delete(this.name);
    await check(m, r);
  }
  toString = (): string => `remove ${this.name}`;
}

class GhCliSetDefault implements fc.AsyncCommand<Model, Real> {
  constructor(readonly repo: string) {}
  check = (m: Readonly<Model>): boolean => [...m.remotes.values()].includes(this.repo);
  async run(m: Model, r: Real): Promise<void> {
    const order = ranked(m);
    const current = order.find((name) => (m.keys.get(name) ?? []).length > 0);
    if (current !== undefined) {
      // gh runs `git config --unset`, which refuses a key with two values.
      const unset = spawnSync("git", ["-C", r.dir, "config", "--unset", `remote.${current}.gh-resolved`], { cwd: tmpdir() });
      if (unset.status !== 0) {
        expect(m.keys.get(current)!.length).toBeGreaterThan(1);
        await check(m, r);
        return;
      }
      m.keys.delete(current);
    }
    const target = order.find((name) => m.remotes.get(name) === this.repo)!;
    git(r.dir, "config", "--add", `remote.${target}.gh-resolved`, "base");
    m.keys.set(target, [...(m.keys.get(target) ?? []), "base"]);
    await check(m, r);
  }
  toString = (): string => `gh repo set-default ${this.repo}`;
}

class PwrGitSetDefault implements fc.AsyncCommand<Model, Real> {
  constructor(readonly name: string) {}
  check = (m: Readonly<Model>): boolean => m.remotes.has(this.name);
  async run(m: Model, r: Real): Promise<void> {
    const result = await setGhDefault(systemGit, r.dir, this.name);
    expect(result.ok).toBe(true);
    const repo = m.remotes.get(this.name)!;
    const target = ranked(m).find((name) => m.remotes.get(name) === repo)!;
    m.keys = new Map([[target, ["base"]]]);
    // "Use for gh" on the fork's remote ends any disagreement with moving on.
    if (result.ok && m.movedOn === this.name) expect(ghDefaultNotice(result.value, this.name)).toBeNull();
    await check(m, r);
  }
  toString = (): string => `PwrGit: use ${this.name} for gh`;
}

class AnswerMovedOn implements fc.AsyncCommand<Model, Real> {
  constructor(readonly remote: string | null) {}
  check = (): boolean => true;
  async run(m: Model, r: Real): Promise<void> {
    m.movedOn = this.remote;
    await check(m, r);
  }
  toString = (): string => `moved on: ${this.remote ?? "unanswered"}`;
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "pwrgit-gh-model-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let run = 0;

it("PwrGit's gh reading and warning track every change to remotes and gh's default", async () => {
  const name = fc.constantFrom(...NAMES);
  const commands = [
    fc.tuple(name, fc.constantFrom(...REPOS)).map(([n, repo]) => new AddRemote(n, repo)),
    name.map((n) => new RemoveRemote(n)),
    fc.constantFrom(...REPOS).map((repo) => new GhCliSetDefault(repo)),
    name.map((n) => new PwrGitSetDefault(n)),
    fc.option(name, { nil: null }).map((remote) => new AnswerMovedOn(remote))
  ];
  await fc.assert(
    fc.asyncProperty(fc.commands(commands, { maxCommands: 14 }), async (cmds) => {
      const dir = join(root, `r${run++}`);
      execFileSync("git", ["init", "-q", dir], { cwd: tmpdir() });
      await fc.asyncModelRun(() => ({
        model: { remotes: new Map(), keys: new Map(), movedOn: null },
        real: { dir }
      }), cmds);
    }),
    { numRuns: 100 }
  );
}, 120_000);
