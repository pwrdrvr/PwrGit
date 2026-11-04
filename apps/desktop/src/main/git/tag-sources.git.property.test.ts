import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import type { TagSyncStatus } from "@pwrgit/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CommandBus } from "../command-bus";
import { openDatabase, type DB } from "../persistence/db";
import { fetchRemote, pullFastForward } from "./git-service";
import { registerRemoteHandlers } from "./remote-handlers";
import { registerTagHandlers } from "./tag-handlers";
import { tagSourcesFor } from "./tag-sources";
import { createSystemGit } from "./test-support/system-git";
import type { WorktreeRefresher } from "./worktree-handlers";
import { WorktreeOperationQueue } from "./worktree-operation-queue";

vi.mock("../ipc", () => ({ emitEvent: vi.fn() }));
vi.mock("../logs", () => ({ logMain: vi.fn() }));

/*
 * A model test of published tags through the real handlers, with git as the
 * oracle (docs/property-model-oracle-testing.md). Random sequences of what a
 * maintainer and the user do; after every step:
 *
 *  - local refs/tags are exactly what the user's own actions made them: no
 *    step but Take / Download changes an existing tag;
 *  - each row's status is what `git ls-remote` (as of the last check) and
 *    `git for-each-ref` say, and Keep local holds for exactly its pair;
 *  - the sidebar's stored count equals that comparison after anything that
 *    changes local tags or decisions (a sync never compares: design 1c);
 *  - Take / Download succeeds exactly when origin still has the reviewed
 *    object, and a replaced value stays reachable through `git gc`.
 */

const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const systemGit = createSystemGit({ env });
let template: string;
const runs: string[] = [];

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], {
    cwd: tmpdir(), env, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"]
  }).trim();
}

function setup(repo: string): void {
  git(repo, "config", "user.name", "Tag Fixture");
  git(repo, "config", "user.email", "tags@example.test");
  git(repo, "config", "maintenance.auto", "false");
  git(repo, "config", "gc.auto", "0");
  git(repo, "config", "core.autocrlf", "false");
}

/** name -> object id, from git. */
function tagsOf(listing: string): Map<string, string> {
  const tags = new Map<string, string>();
  for (const line of listing.split("\n")) {
    const [objectId = "", ref = ""] = line.split(/\s+/);
    if (ref.startsWith("refs/tags/") && !ref.endsWith("^{}")) tags.set(ref.slice(10), objectId);
  }
  return tags;
}
const localTags = (repo: string) => tagsOf(git(repo, "for-each-ref", "--format=%(objectname) %(refname)", "refs/tags"));
const originTags = (origin: string) => tagsOf(execFileSync("git", ["ls-remote", "--tags", origin], { cwd: tmpdir(), env, encoding: "utf8" }));

type Model = {
  local: Map<string, string>;
  /** origin's tags at the last check, as git listed them; null before one. */
  listed: Map<string, string> | null;
  keeps: Map<string, { local: string; remote: string }>;
  /** Every value a Take replaced: each must stay reachable. */
  replaced: string[];
};

type Real = { bus: CommandBus; db: DB; root: string; local: string; publisher: string; origin: string };

function oracleStatus(model: Model, name: string): TagSyncStatus {
  const local = model.local.get(name);
  const remote = model.listed?.get(name);
  if (local === undefined) return "remote_only";
  if (model.listed === null) return "unchecked";
  if (remote === undefined) return "local_only";
  if (remote === local) return "same";
  const keep = model.keeps.get(name);
  return keep?.local === local && keep.remote === remote ? "kept_local" : "differs";
}

function oracleDiffers(model: Model): number {
  return [...model.local.keys()].filter((name) => oracleStatus(model, name) === "differs").length;
}

async function check(model: Model, real: Real, compared: boolean): Promise<void> {
  expect(localTags(real.local)).toEqual(model.local);
  expect(git(real.local, "for-each-ref", "refs/pwrgit/incoming-tags")).toBe("");
  const pins = git(real.local, "for-each-ref", "--format=%(objectname)", "refs/pwrgit/replaced-tags");
  for (const id of model.replaced) {
    expect(pins.split("\n")).toContain(id);
    expect(() => git(real.local, "cat-file", "-e", id)).not.toThrow();
  }
  if (model.listed === null) return;
  // Before repo:tagStatus, which re-counts as it pages.
  if (compared) {
    const differs = oracleDiffers(model);
    expect(tagSourcesFor(real.db).store.attention("repo-1", ["origin"])).toEqual(
      differs > 0 ? { remote: "origin", differs } : undefined
    );
  }
  const page = await real.bus.dispatch("repo:tagStatus", { repoId: "repo-1", limit: 100 });
  if (!page.ok) throw new Error(page.error.message);
  const names = new Set([...model.local.keys(), ...model.listed.keys()]);
  expect(new Map(page.value.rows.map((row) => [row.name, row.status]))).toEqual(
    new Map([...names].map((name) => [name, oracleStatus(model, name)]))
  );
}

type Command = fc.AsyncCommand<Model, Real>;
const tagName = fc.constantFrom("v1", "v2", "v3");

class Recut implements Command {
  constructor(readonly name: string, readonly annotated: boolean, readonly advance: boolean) {}
  check = () => true;
  async run(model: Model, real: Real): Promise<void> {
    if (this.advance) {
      writeFileSync(join(real.publisher, "release.txt"), `${Math.random()}\n`);
      git(real.publisher, "commit", "-qam", "cut");
      git(real.publisher, "push", "-q", "origin", "main");
    }
    git(real.publisher, "tag", "-f", ...(this.annotated ? ["-a", "-m", `re-cut ${this.name}`] : []), this.name);
    git(real.publisher, "push", "-q", "-f", "origin", `refs/tags/${this.name}`);
    await check(model, real, true);
  }
  toString = () => `recut ${this.name}${this.annotated ? " annotated" : ""}${this.advance ? " after a commit" : ""}`;
}

class RemoteDelete implements Command {
  constructor(readonly name: string) {}
  check = () => true;
  async run(model: Model, real: Real): Promise<void> {
    if (git(real.publisher, "tag", "-l", this.name) !== "") {
      git(real.publisher, "push", "-q", "origin", `:refs/tags/${this.name}`);
      git(real.publisher, "tag", "-d", this.name);
    }
    await check(model, real, true);
  }
  toString = () => `origin deletes ${this.name}`;
}

class Sync implements Command {
  constructor(readonly how: "fetch" | "pull") {}
  check = () => true;
  async run(model: Model, real: Real): Promise<void> {
    const result = this.how === "fetch" ? await fetchRemote(systemGit, real.local) : await pullFastForward(systemGit, real.local);
    expect(result.ok).toBe(true);
    const after = localTags(real.local);
    for (const [name, id] of model.local) expect(after.get(name), `${this.how} moved ${name}`).toBe(id);
    model.local = after;
    // A sync never compares, so the stored count may lag until the next check.
    await check(model, real, false);
  }
  toString = () => this.how;
}

class Refresh implements Command {
  check = () => true;
  async run(model: Model, real: Real): Promise<void> {
    const result = await real.bus.dispatch("tag:refreshRemote", { repoId: "repo-1", mode: "explicit" });
    expect(result.ok).toBe(true);
    model.listed = originTags(real.origin);
    await check(model, real, true);
  }
  toString = () => "refresh";
}

/** Tags the Tags tab offers Take (differs) or Download (only on origin) for. */
const takeable = (model: Readonly<Model>) =>
  model.listed === null
    ? []
    : [...new Set([...model.local.keys(), ...model.listed.keys()])]
        .filter((name) => ["differs", "remote_only"].includes(oracleStatus(model as Model, name)))
        .sort();

class Take implements Command {
  constructor(readonly pick: number) {}
  check = (model: Readonly<Model>) => takeable(model).length > 0;
  async run(model: Model, real: Real): Promise<void> {
    const names = takeable(model);
    const name = names[this.pick % names.length]!;
    this.taken = name;
    const reviewed = model.listed!.get(name)!;
    const before = model.local.get(name) ?? null;
    const current = originTags(real.origin).get(name);
    const result = await real.bus.dispatch("tag:adoptRemote", {
      repoId: "repo-1",
      name,
      remote: "origin",
      expectedRemoteObjectId: reviewed,
      expectedLocalObjectId: before
    });
    if (current === reviewed) {
      expect(result.ok ? null : result.error.code).toBeNull();
      model.local.set(name, reviewed);
      model.keeps.delete(name);
      if (before !== null) model.replaced.push(before);
    } else {
      // origin moved or dropped it after the review: nothing changes.
      expect(result.ok ? "adopted" : result.error.code).toMatch(/^remote_tag_(changed|missing)$/);
    }
    await check(model, real, true);
  }
  taken = "";
  toString = () => `take ${this.taken || `#${this.pick}`}`;
}

const keepable = (model: Readonly<Model>) =>
  [...model.local.keys()].filter((name) => model.listed !== null && oracleStatus(model as Model, name) === "differs").sort();

class Keep implements Command {
  constructor(readonly pick: number) {}
  check = (model: Readonly<Model>) => keepable(model).length > 0;
  async run(model: Model, real: Real): Promise<void> {
    const names = keepable(model);
    const name = names[this.pick % names.length]!;
    this.kept = name;
    const pair = { local: model.local.get(name)!, remote: model.listed!.get(name)! };
    const result = await real.bus.dispatch("tag:keepLocal", {
      repoId: "repo-1", name, remote: "origin", localObjectId: pair.local, remoteObjectId: pair.remote, keep: true
    });
    expect(result.ok).toBe(true);
    model.keeps.set(name, pair);
    await check(model, real, true);
  }
  kept = "";
  toString = () => `keep local ${this.kept || `#${this.pick}`}`;
}

class CreateLocal implements Command {
  constructor(readonly name: string, readonly atRoot: boolean) {}
  check = (model: Readonly<Model>) => !model.local.has(this.name);
  async run(model: Model, real: Real): Promise<void> {
    const target = git(real.local, "rev-list", ...(this.atRoot ? ["--max-parents=0"] : ["-1"]), "HEAD");
    const result = await real.bus.dispatch("tag:create", { repoId: "repo-1", name: this.name, targetCommit: target, kind: "lightweight" });
    expect(result.ok).toBe(true);
    model.local.set(this.name, target);
    await check(model, real, true);
  }
  toString = () => `create local ${this.name}${this.atRoot ? " at the root" : ""}`;
}

class DeleteLocal implements Command {
  constructor(readonly name: string) {}
  check = (model: Readonly<Model>) => model.local.has(this.name);
  async run(model: Model, real: Real): Promise<void> {
    const result = await real.bus.dispatch("tag:deleteLocal", {
      repoId: "repo-1", name: this.name, expectedObjectId: model.local.get(this.name)!
    });
    expect(result.ok).toBe(true);
    model.local.delete(this.name);
    await check(model, real, true);
  }
  toString = () => `delete local ${this.name}`;
}

class Gc implements Command {
  check = (model: Readonly<Model>) => model.replaced.length > 0;
  async run(model: Model, real: Real): Promise<void> {
    git(real.local, "reflog", "expire", "--expire=now", "--all");
    git(real.local, "gc", "-q", "--prune=now");
    await check(model, real, true);
  }
  toString = () => "gc --prune=now";
}

const pick = fc.nat(5);
// Checks and decisions weigh double: they are what the model is about, and
// they need a re-cut and a check before them to have anything to act on.
const commands = [
  fc.tuple(tagName, fc.boolean(), fc.boolean()).map(([name, annotated, advance]) => new Recut(name, annotated, advance)),
  fc.tuple(tagName, fc.boolean(), fc.boolean()).map(([name, annotated, advance]) => new Recut(name, annotated, advance)),
  tagName.map((name) => new RemoteDelete(name)),
  fc.constantFrom("fetch" as const, "pull" as const).map((how) => new Sync(how)),
  fc.constant(new Refresh()),
  fc.constant(new Refresh()),
  pick.map((index) => new Take(index)),
  pick.map((index) => new Take(index)),
  pick.map((index) => new Keep(index)),
  fc.tuple(tagName, fc.boolean()).map(([name, atRoot]) => new CreateLocal(name, atRoot)),
  tagName.map((name) => new DeleteLocal(name)),
  fc.constant(new Gc())
];

/** origin.git with v1 (lightweight) and v2 (annotated); a publisher; the user's clone, behind a re-cut v2. */
beforeAll(() => {
  template = mkdtempSync(join(tmpdir(), "pwrgit-tag-model-"));
  git(template, "init", "-q", "--bare", "-b", "main", "origin.git");
  git(template, "clone", "-q", "origin.git", "publisher");
  const publisher = join(template, "publisher");
  setup(publisher);
  writeFileSync(join(publisher, "release.txt"), "cut 0\n");
  git(publisher, "add", ".");
  git(publisher, "commit", "-qm", "cut 0");
  git(publisher, "tag", "v1");
  git(publisher, "tag", "-a", "-m", "v2", "v2");
  git(publisher, "push", "-q", "origin", "main", "--tags");
  git(template, "clone", "-q", "origin.git", "local");
  setup(join(template, "local"));
  // First run: v2 was re-cut after the user cloned, so a mismatch exists
  // before PwrGit has ever checked.
  writeFileSync(join(publisher, "release.txt"), "cut 1\n");
  git(publisher, "commit", "-qam", "cut 1");
  git(publisher, "tag", "-f", "-a", "-m", "v2 re-cut", "v2");
  git(publisher, "push", "-q", "-f", "origin", "main", "refs/tags/v2");
});

/*
 * Budget: about 0.3s per run through the handlers on Linux, 12 runs in ~3.7s.
 * Real Git on the Windows runner is 6-13x slower (tag-source-handlers.test.ts:
 * 1.1s on Linux, 9-13s on Windows), so 12 runs there passed the 20s test
 * timeout. Windows runs 2: a platform smoke of the same model, which Linux
 * and macOS search properly.
 */

/** Windows may still hold a directory a moment after Git exits; afterAll retries. */
function removeRun(root: string): void {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // Left in `runs` for afterAll.
  }
}

afterAll(() => {
  for (const root of [template, ...runs]) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function start(): { model: Model; real: Real } {
  const root = mkdtempSync(join(tmpdir(), "pwrgit-tag-model-run-"));
  runs.push(root);
  cpSync(template, root, { recursive: true });
  const origin = join(root, "origin.git");
  const local = join(root, "local");
  const publisher = join(root, "publisher");
  git(publisher, "remote", "set-url", "origin", origin);
  git(local, "remote", "set-url", "origin", origin);
  const db = openDatabase(":memory:");
  db.prepare("INSERT INTO profiles (id, name, email) VALUES ('p1', 'P', 'p@example.com')").run();
  db.prepare("INSERT INTO repos (id, profile_id, name, path) VALUES ('repo-1', 'p1', 'proj', ?)").run(local);
  const bus = new CommandBus();
  const refresher = { refreshWorktree: vi.fn(async () => undefined), refreshRepoWorktrees: vi.fn() } satisfies WorktreeRefresher;
  registerRemoteHandlers(bus, db, refresher, new WorktreeOperationQueue());
  registerTagHandlers(bus, db);
  return {
    model: { local: localTags(local), listed: null, keeps: new Map(), replaced: [] },
    real: { bus, db, root, local, publisher, origin }
  };
}

describe("published tags against git", () => {
  it("statuses, the stored count, Take and Keep agree with git through any sequence of changes", async () => {
    await fc.assert(
      fc.asyncProperty(// A plain array, not fc.commands: at its default size fc.commands made
      // runs of about two steps, too short to re-cut, check and then decide.
      fc.array(fc.oneof(...commands), { minLength: 4, maxLength: 8 }), async (sequence) => {
        const { model, real } = start();
        try {
          await fc.asyncModelRun(() => ({ model, real }), sequence);
        } finally {
          real.db.close();
          removeRun(real.root);
        }
      }),
      { numRuns: process.platform === "win32" ? 2 : 12 }
    );
  });
});
