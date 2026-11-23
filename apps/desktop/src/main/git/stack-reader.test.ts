import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import fc from "fast-check";
import { expect, test, vi } from "vitest";
import { stackPositionForPr, type ChangeRequestEntry, type ChangeRequestList, type PrSummary, type Repo } from "@pwrgit/shared";
import { parseGitHubStacks } from "../github/stack-client";
import { CommandBus } from "../command-bus";
import { openDatabase } from "../persistence/db";
import { ProfileService } from "../profiles/profile-service";
import { RepoIndexer } from "./repo-indexer";
import { registerStackReadHandlers } from "./stack-read-handlers";
import { StackReader, stackRunner } from "./stack-reader";
import { NativeStackLocks } from "./stack-catalog-store";
import { commit, git, gitEnvironment, runner, withStack } from "./stack-engine/fixture.test-support";

import { createSystemGit } from "./test-support/system-git";

test("read health follows real common-dir refs, scoped to the requesting profile", () => withStack(async ({ cwd, initial, commonDir, base, top }) => {
  const db = openDatabase(":memory:");
  try {
    const profiles = new ProfileService(db);
    profiles.ensureSeed({ name: "First", email: "first@example.invalid", roots: [] });
    const first = profiles.getActiveId()!;
    const second = profiles.create({ name: "Second", email: "second@example.invalid", roots: [] }).id;
    const insert = db.prepare("INSERT INTO repos(id, profile_id, name, path) VALUES (?, ?, ?, ?)");
    insert.run("here", first, "Orbit", cwd);
    insert.run("elsewhere", second, "Other", join(cwd, "other"));
    const indexer = new RepoIndexer(db, vi.fn());
    await writeFile(join(commonDir, "gh-stack"), JSON.stringify(initial));
    const next = await commit(cwd, "trunk.txt", "advance");
    const linked = join(cwd, "linked");
    await git(cwd, "worktree", "add", "-q", linked, "top");
    const open: ChangeRequestList = { forge: "github", fetchedAt: null, truncated: false, remotes: [], entries: [] };
    const reader = new StackReader(runner, new NativeStackLocks(() => { throw new Error("read-only view invoked the helper"); }),
      async () => open, () => undefined);
    const bus = new CommandBus();
    registerStackReadHandlers(bus, id => indexer.getRepo(id), reader);
    expect((await bus.dispatch("stack:list", { profileId: first, repoId: "elsewhere" })).ok).toBe(false);
    expect((await bus.dispatch("stack:list", { profileId: second, repoId: "here" })).ok).toBe(false);
    const view = await bus.dispatch("stack:list", { profileId: first, repoId: "here" });
    const repo: Repo = { ...indexer.getRepo("here")!, path: linked };
    expect(view).toMatchObject({ ok: true, value: { stacks: [{
      source: "tracked", trunk: { branch: "main", head: next },
      layers: [{ base, health: { needsRestack: true } }, { head: top, health: { inSync: true } }],
    }] } });
    if (view.ok) expect(await reader.list(repo)).toEqual(view.value);
  } finally { db.close(); }
}));

const forgeRepo = "github.com/example/orbit-deploy";
const listRemote = (key: string, truncated: boolean, fetchedAt = 100) => ({
  name: key === forgeRepo ? "origin" : "mirror", forge: "github" as const, forgeRepo: key,
  path: key.slice("github.com/".length), truncated, fetchedAt,
});
const openPr = (number: number, head: string, base: string, headOid?: string, key = forgeRepo): ChangeRequestEntry => ({
  forgeRepo: key, remote: listRemote(key, false).name, location: { kind: "local", branch: head },
  pr: { number, title: head, url: "", state: "open", isDraft: false, headRefName: head,
    baseRefName: base, host: "github.com", repoPath: listRemote(key, false).path, ...(headOid ? { headOid } : {}) },
});
const testRepo = (path: string, id = "here"): Repo => ({
  id, name: id, path, profileId: "profile", pinned: false, worktrees: [],
});
const locks = new NativeStackLocks(() => { throw new Error("read-only view invoked the helper"); });

test("tracked PR identity is independent of ordering and the newest observation of that PR wins", () =>
  withStack(async ({ cwd, commonDir, initial }) => {
    initial.stacks[0].branches[0].pullRequest = { number: 17 };
    await writeFile(join(commonDir, "gh-stack"), JSON.stringify(initial));
    const tracked = openPr(17, "bottom", "main");
    const unrelated = openPr(99, "bottom", "release");
    let entries: ChangeRequestEntry[] = [];
    let observation: { fetchedAt: number; pr: PrSummary } | undefined;
    const reader = new StackReader(runner, locks, async () => ({
      forge: "github", fetchedAt: 100, truncated: false, remotes: [listRemote(forgeRepo, false)], entries,
    }), (_, branch) => branch === "bottom" ? observation : undefined);
    await fc.assert(fc.asyncProperty(fc.boolean(), fc.boolean(), fc.boolean(), fc.boolean(),
      async (otherFirst, sameNumber, newer, trackedListed) => {
        entries = !trackedListed ? [unrelated] : otherFirst ? [unrelated, tracked] : [tracked, unrelated];
        const pr: PrSummary = { ...(sameNumber ? tracked.pr : unrelated.pr), state: "merged" };
        observation = { pr, fetchedAt: newer ? 200 : 50 };
        const { layers } = (await reader.list(testRepo(cwd))).stacks[0];
        const merged = sameNumber && (newer || !trackedListed);
        expect(layers[0].pr?.number).toBe(trackedListed || sameNumber ? 17 : undefined);
        expect(layers[1].health.parentMerged).toBe(merged);
      }), { numRuns: 16 });
  }));

test("inference needs complete input for each remote independently", () =>
  withStack(async ({ cwd }) => {
    const mirror = "github.com/example/mirror";
    const entries = [
      openPr(1, "a", "main"), openPr(2, "b", "a"),
      openPr(3, "c", "main", undefined, mirror), openPr(4, "d", "c", undefined, mirror),
    ];
    await fc.assert(fc.asyncProperty(fc.boolean(), fc.boolean(), async (originTruncated, mirrorTruncated) => {
      const reader = new StackReader(runner, locks, async () => ({
        forge: "github", fetchedAt: 100, truncated: originTruncated || mirrorTruncated, entries,
        remotes: [listRemote(forgeRepo, originTruncated), listRemote(mirror, mirrorTruncated)],
      }), () => undefined);
      const snapshot = await reader.list(testRepo(cwd));
      expect(snapshot.stacks.map(stack => stack.layers[0].branch).sort())
        .toEqual([...(originTruncated ? [] : ["a"]), ...(mirrorTruncated ? [] : ["c"])]);
    }), { numRuns: 8 });
  }));

test("a read against a partial clone leaves a cached, missing PR commit absent", () =>
  withStack(async ({ cwd, top }) => {
    await git(cwd, "config", "uploadpack.allowFilter", "true");
    await git(cwd, "config", "uploadpack.allowAnySHA1InWant", "true");
    const clone = join(cwd, "partial");
    await git(cwd, "clone", "-q", "--no-local", "--filter=blob:none", cwd, clone);
    await git(cwd, "switch", "-qc", "new-head", top);
    const missing = await commit(cwd, "remote.txt", "remote only");
    const execute = createSystemGit({ env: gitEnvironment });
    const exists = async () => {
      const result = await execute(["cat-file", "-e", missing], clone, { env: { GIT_NO_LAZY_FETCH: "1" } });
      return result.ok && result.value.exitCode === 0;
    };
    expect(await exists()).toBe(false);
    const reader = new StackReader(stackRunner(execute), locks, async () => ({
      forge: "github", fetchedAt: 100, truncated: false, remotes: [listRemote(forgeRepo, false)],
      entries: [openPr(1, "new-head", "main", missing), openPr(2, "top", "new-head", top)],
    }), () => undefined);
    expect((await reader.list(testRepo(clone))).stacks).toHaveLength(1);
    expect(await exists()).toBe(false);
  }));

test("stack reads across independent repositories share a main-process concurrency ceiling", async () => {
  await fc.assert(fc.asyncProperty(fc.scheduler(), fc.integer({ min: 6, max: 14 }), async (scheduler, count) => {
    const bus = new CommandBus();
    let active = 0, peak = 0;
    registerStackReadHandlers(bus, id => testRepo("/unused", id), {
      async list(repo) {
        active++;
        peak = Math.max(peak, active);
        await scheduler.schedule(Promise.resolve(), repo.id);
        active--;
        return { schemaVersion: 1, readOnly: false, stacks: [] };
      },
    });
    const reads = Array.from({ length: count }, (_, index) =>
      bus.dispatch("stack:list", { repoId: String(index), profileId: "profile" }));
    await scheduler.waitFor(Promise.all(reads));
    expect(peak).toBe(4);
    expect(active).toBe(0);
  }), { numRuns: 15 });
});

test("GitHub's ordered stack response identifies a remote-only stack and its merged member", () =>
  withStack(async ({ cwd, top, bottom }) => {
    const topPr = openPr(8, "top", "bottom", top);
    topPr.pr.checkState = "failing";
    const reader = new StackReader(runner, locks, async () => ({
      forge: "github", fetchedAt: 100, truncated: false, entries: [topPr],
      remotes: [listRemote(forgeRepo, false)],
    }), () => undefined, (_repo, scope) => scope === forgeRepo ? parseGitHubStacks([{
      number: 4235, open: true, base: { ref: "main" },
      pull_requests: [
        { number: 7, head: { ref: "bottom", sha: bottom }, state: "closed", merged_at: "2026-10-12T10:00:00Z" },
        { number: 8, head: { ref: "top", sha: top }, state: "open", draft: false },
      ]
    }], "example", "orbit-deploy") : []);
    const { stacks } = await reader.list(testRepo(cwd));
    expect(stacks).toMatchObject([{
      githubNumber: 4235, githubUrl: "https://github.com/example/orbit-deploy/stack/4235", source: "inferred",
      trunk: { branch: "main" },
      layers: [
        { branch: "bottom", pr: { number: 7, state: "merged" } },
        { branch: "top", pr: { number: 8, state: "open", checkState: "failing" }, health: { parentMerged: true } },
      ],
    }]);
  }));

test("an externally rebased child exposes the same invalid boundary the planner rejects", () =>
  withStack(async ({ cwd, commonDir, initial, engine, bottom }) => {
    await writeFile(join(commonDir, "gh-stack"), JSON.stringify(initial));
    await git(cwd, "switch", "-q", "bottom");
    const amended = await commit(cwd, "bottom.txt", "amended parent\n", true);
    await git(cwd, "rebase", "--onto", amended, bottom, "top");
    const reader = new StackReader(runner, locks, async () => ({
      forge: null, fetchedAt: null, truncated: false, remotes: [], entries: [],
    }), () => undefined);
    const snapshot = await reader.list(testRepo(cwd));
    expect(snapshot.stacks[0].layers[1]).toMatchObject({ baseIsAncestor: false, health: { needsRestack: true } });
    await expect(engine.plan({ kind: "restack", root: "bottom", from: "top" })).rejects.toThrow("outside its history");
  }));

test("R9 API membership, position and closure survive any missing branch refs", () =>
  withStack(async ({ cwd, base, commonDir, initial }) => {
    const presence = fc.record({ local: fc.boolean(), remote: fc.boolean() });
    const stack = fc.record({
      state: fc.constantFrom("open", "merged", "closed"),
      members: fc.array(fc.tuple(presence, fc.boolean()), { minLength: 2, maxLength: 4 }),
    });
    await fc.assert(fc.asyncProperty(fc.array(stack, { minLength: 1, maxLength: 4 }), async specs => {
      const commands: string[] = [];
      const cachedTitles = new Map<number, string>();
      const rows = specs.map(({ state, members }, stackIndex) => ({
        number: 4231 + stackIndex, open: state === "open", base: { ref: "main" },
        pull_requests: members.map(([{ local, remote }, cached], index) => {
          const branch = `history-${stackIndex}-${index}`;
          const number = 4200 + stackIndex * 10 + index;
          if (cached) cachedTitles.set(number, `Cached title ${number}`);
          for (const [ref, present] of [[`refs/heads/${branch}`, local], [`refs/remotes/origin/${branch}`, remote]] as const) {
            commands.push(present ? `update ${ref} ${base}` : `delete ${ref}`);
          }
          return {
            number,
            state: state === "open" && index === members.length - 1 ? "open" : "closed",
            merged_at: state === "merged" || index === 0 ? "2026-11-12T10:00:00Z" : null,
            head: { ref: branch, sha: base },
          };
        }),
      }));
      const update = await runner.run(cwd, ["update-ref", "--stdin"], { stdin: commands.join("\n") + "\n" });
      expect(update.exitCode, update.stderr).toBe(0);
      // A stale local catalog has only the bottom PR of the first stack.
      const bottom = rows[0].pull_requests[0];
      initial.stacks = [{
        number: rows[0].number, trunk: { branch: "main" },
        branches: [{ branch: bottom.head.ref, pullRequest: { number: bottom.number } }],
      }];
      await writeFile(join(commonDir, "gh-stack"), JSON.stringify(initial));
      const reader = new StackReader(runner, locks, async () => ({
        forge: "github", fetchedAt: 100, truncated: false, entries: [],
        remotes: [listRemote(forgeRepo, false)],
      }), () => undefined, () => parseGitHubStacks(rows, "example", "orbit-deploy"),
      (repoId, scope) => repoId === "here" && scope === forgeRepo ? cachedTitles : new Map());
      const snapshot = await reader.list(testRepo(cwd));
      for (const [stackIndex, row] of rows.entries()) {
        for (const [index, member] of row.pull_requests.entries()) {
          const position = stackPositionForPr(snapshot.stacks, { number: member.number, repoPath: "example/orbit-deploy" });
          expect(position?.index).toBe(index + 1);
          expect(position?.stack.layers).toHaveLength(row.pull_requests.length);
          expect(position?.stack.githubNumber).toBe(row.number);
          expect(position?.stack.githubUrl).toBe(`https://github.com/example/orbit-deploy/stack/${row.number}`);
          expect(position?.stack.closed).toBe(row.open ? undefined : specs[stackIndex].state);
          if (!row.open) {
            expect(Object.values(position!.layer.health)).not.toContain(true);
            expect(position?.layer.pr?.title).toBe(cachedTitles.get(member.number) ?? member.head.ref);
          }
          expect(stackPositionForPr(snapshot.stacks, { number: member.number, repoPath: "example/other" })).toBeUndefined();
        }
      }
    }), { numRuns: 18, examples: [[[{
      state: "merged", members: [[{ local: false, remote: false }, true], [{ local: false, remote: false }, false]],
    }, {
      state: "open", members: [[{ local: false, remote: false }, false], [{ local: true, remote: true }, false]],
    }]]] });
  }));

test("a tracked stack keeps unpublished work and uses GitHub merge observations", () =>
  withStack(async ({ cwd, commonDir, initial, bottom, top }) => {
    await git(cwd, "merge", "--ff-only", "bottom");
    await git(cwd, "branch", "unpublished", top);
    const tracked = initial.stacks[0];
    tracked.number = 4231;
    tracked.branches[0].pullRequest = { number: 81 };
    tracked.branches[1].pullRequest = { number: 82 };
    tracked.branches.push({ branch: "unpublished", head: top, base: top });
    await writeFile(join(commonDir, "gh-stack"), JSON.stringify(initial));

    await fc.assert(fc.asyncProperty(fc.boolean(), async closed => {
      const row = {
        number: 4231, open: !closed, base: { ref: "main" },
        pull_requests: [
          { number: 81, state: "closed", merged_at: "2026-11-12T10:00:00Z", head: { ref: "bottom", sha: bottom } },
          { number: 82, state: closed ? "closed" : "open", merged_at: closed ? "2026-11-12T10:00:00Z" : null, head: { ref: "top", sha: top } },
        ],
      };
      const reader = new StackReader(runner, locks, async () => ({
        forge: "github", fetchedAt: 100, truncated: false, entries: [],
        remotes: [listRemote(forgeRepo, false)],
      }), () => undefined, () => parseGitHubStacks([row], "example", "orbit-deploy"));
      const snapshot = await reader.list(testRepo(cwd));
      const local = snapshot.stacks.find(stack => stack.source === "tracked");
      expect(local?.layers.map(layer => layer.branch)).toEqual(["bottom", "top", "unpublished"]);
      expect(local?.closed).toBeUndefined();
      expect(snapshot.stacks.find(stack => stack.githubNumber === 4231)?.closed).toBe(closed ? "merged" : undefined);
      if (!closed) expect(local?.layers[1]).toMatchObject({ syncReady: true, health: { parentMerged: true } });
    }), { numRuns: 2, examples: [[true], [false]] });
  }));
