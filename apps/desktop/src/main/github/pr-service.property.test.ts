import { setImmediate } from "node:timers/promises";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import { ok, type PrSummary } from "@pwrgit/shared";
import { CommandBus } from "../command-bus";
import type { TokenForgeProvider } from "../forge/types";
import type { GitExec } from "../git/dugite";
import { openDatabase } from "../persistence/db";
import type { GitHubCommitAuthorIdentityService } from "./commit-author-identity";
import { registerGitHubHandlers } from "./github-handlers";
import { createGonePrRefresh } from "./gone-pr-refresh";
import { PrService } from "./pr-service";

const { emitEvent } = vi.hoisted(() => ({ emitEvent: vi.fn() }));
vi.mock("../ipc", () => ({ emitEvent }));
vi.mock("../logs", () => ({ logMain: vi.fn() }));

const origin = "https://forge.invalid/fixture/project.git";
const forgeRepo = { kind: "github", host: "forge.invalid", path: "fixture/project" } as const;
const pr: PrSummary = {
  number: 1, title: "Fixture", url: "https://forge.invalid/fixture/project/pulls/1",
  state: "open", isDraft: false
};
const branch = "feature/fixture";
const stdoutOk = (stdout: string) => ok({ stdout, stderr: "", exitCode: 0 });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => { resolve = finish; });
  return { promise, resolve };
}

function fixture(
  git: GitExec,
  fetchPrsForBranches: TokenForgeProvider["fetchPrsForBranches"],
  lookups: Partial<Pick<TokenForgeProvider, "fetchPrsForCommits" | "fetchPrsByNumbers">> = {}
) {
  const db = openDatabase(":memory:");
  db.exec(`
    INSERT INTO profiles (id, name, email) VALUES
      ('fixture', 'Fixture', 'test@fixture.invalid'),
      ('other', 'Other', 'other@fixture.invalid');
    INSERT INTO repos (id, profile_id, name, path) VALUES
      ('repo', 'fixture', 'Fixture', '/fixture'),
      ('other', 'other', 'Other', '/other');
  `);
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected forge query"); };
  const provider: TokenForgeProvider = {
    kind: "github",
    getToken: async () => "test-token",
    fetchPrsForBranches,
    fetchPrsForCommits: unexpected,
    fetchPrsByNumbers: unexpected,
    fetchOpenPrs: unexpected,
    ...lookups
  };
  let now = 1_000_000;
  const prs = new PrService(db, git, { resolveForge: () => ({ provider, repo: forgeRepo }), now: () => now });
  const bus = new CommandBus();
  const handlers = registerGitHubHandlers(bus, prs, {} as GitHubCommitAuthorIdentityService);
  emitEvent.mockClear();
  return {
    bus, db, handlers, prs,
    advance: (ms: number) => { now += ms; },
    close: () => { handlers.stop(); db.close(); }
  };
}

async function equivalentIpcBurst(callers: number, warm: boolean, refs: number, force = false): Promise<void> {
  const listing = [branch, ...Array.from({ length: refs - 1 }, (_, i) => `other/${i}`)].join("\n");
  const git = vi.fn<GitExec>(async (args, path) => {
    expect(path).toBe("/fixture");
    if (args[0] === "for-each-ref") {
      await Promise.resolve();
      return stdoutOk(listing);
    }
    if (args[0] === "remote") return stdoutOk(origin);
    throw new Error(`Unexpected Git command: ${args.join(" ")}`);
  });
  const fetch = vi.fn<TokenForgeProvider["fetchPrsForBranches"]>(async () => new Map([[branch, pr]]));
  const { bus, prs, close } = fixture(git, fetch);
  try {
    if (warm) {
      await prs.refreshRepo("repo", { branches: [branch] });
      git.mockClear();
      fetch.mockClear();
      emitEvent.mockClear();
    }
    const results = await Promise.all(Array.from({ length: callers }, (_, i) =>
      bus.dispatch("pr:refresh", { repoId: "repo", branches: i % 2 === 0 ? [branch] : [branch, branch], force })
    ));
    expect(results).toEqual(Array.from({ length: callers }, () => ok(null)));
    expect(prs.cachedBranchPr("repo", branch)).toEqual(pr);
    expect(prs.cachedBranchPr("other", branch)).toBeUndefined();
    expect(fetch.mock.calls.map(([, , names]) => names)).toEqual(warm && !force ? [] : [[branch]]);
    expect(emitEvent.mock.calls).toEqual(warm ? [] : [["pr:changed", { repoId: "repo", prs: { [branch]: pr } }]]);
    expect(git.mock.calls.filter(([args]) => args[0] === "for-each-ref")).toHaveLength(1);
    expect(git.mock.calls.filter(([args]) => args[1] === "get-url")).toHaveLength(warm && !force ? 0 : 1);
  } finally {
    close();
  }
}

it("uses one ref listing for two cold IPC requests for the same branch", async () => {
  await equivalentIpcBurst(2, false, 1);
});

it("bounds Git and forge work per equivalent burst and publishes each change once", async () => {
  await fc.assert(fc.asyncProperty(
    fc.integer({ min: 2, max: 16 }),
    fc.boolean(),
    fc.integer({ min: 1, max: 75 }),
    fc.boolean(),
    equivalentIpcBurst
  ), { numRuns: 25 });
});

it("lets the gone transition use the user TTL and publishes one delta with overlapping IPC", async () => {
  const git = vi.fn<GitExec>(async (args) => stdoutOk(args[0] === "for-each-ref" ? branch : origin));
  const started = deferred<void>();
  const reply = deferred<Map<string, PrSummary | null>>();
  const merged: PrSummary = { ...pr, state: "merged" };
  const fetch = vi.fn<TokenForgeProvider["fetchPrsForBranches"]>()
    .mockResolvedValueOnce(new Map([[branch, pr]]))
    .mockImplementationOnce(() => {
      started.resolve();
      return reply.promise;
    });
  const { bus, handlers, advance, close } = fixture(git, fetch);
  const refresh = vi.fn(handlers.refreshBranches);
  const gone = createGonePrRefresh(refresh);
  const request = { repoId: "repo", branches: [branch] };
  vi.useFakeTimers();
  try {
    expect(await bus.dispatch("pr:refresh", request)).toEqual(ok(null));
    advance(10_000);
    emitEvent.mockClear();

    gone.queue("repo", branch, false);
    await vi.advanceTimersByTimeAsync(250);
    await refresh.mock.results[0]?.value;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(emitEvent).not.toHaveBeenCalled();
    git.mockClear();

    gone.queue("repo", branch, true);
    await vi.advanceTimersByTimeAsync(250);
    await started.promise;
    const scheduled = bus.dispatch("pr:refresh", request);
    const user = bus.dispatch("pr:refresh", { ...request, trigger: "user" });
    reply.resolve(new Map([[branch, merged]]));
    await refresh.mock.results[1]?.value;
    expect(await Promise.all([scheduled, user])).toEqual([ok(null), ok(null)]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(git.mock.calls.filter(([args]) => args[0] === "for-each-ref")).toHaveLength(1);
    expect(emitEvent.mock.calls).toEqual([["pr:changed", { repoId: "repo", prs: { [branch]: merged } }]]);
  } finally {
    reply.resolve(new Map());
    gone.stop();
    vi.useRealTimers();
    close();
  }
});

it("discovers a branch created after an equivalent sweep took its ref snapshot", async () => {
  let listing = branch;
  const git = vi.fn<GitExec>(async (args) => stdoutOk(args[0] === "for-each-ref" ? listing : origin));
  const started = deferred<void>();
  const reply = deferred<Map<string, PrSummary | null>>();
  const late = "feature/late";
  const fetch = vi.fn<TokenForgeProvider["fetchPrsForBranches"]>()
    .mockImplementationOnce(() => {
      started.resolve();
      return reply.promise;
    })
    .mockResolvedValueOnce(new Map([[branch, pr], [late, { ...pr, number: 2 }]]));
  const { bus, close } = fixture(git, fetch);
  try {
    const request = { repoId: "repo" };
    const first = bus.dispatch("pr:refresh", request);
    await started.promise;
    listing = `${branch}\n${late}`;
    const next = bus.dispatch("pr:refresh", request);
    const disjoint = bus.dispatch("pr:refresh", { ...request, branches: [late] });
    reply.resolve(new Map([[branch, pr]]));

    expect(await Promise.all([first, next, disjoint])).toEqual([ok(null), ok(null), ok(null)]);
    expect(fetch.mock.calls.map(([, , names]) => names)).toEqual([[branch], [branch, late]]);
    expect(git.mock.calls.filter(([args]) => args[0] === "for-each-ref")).toHaveLength(2);
    expect(emitEvent.mock.calls).toEqual([
      ["pr:changed", { repoId: "repo", prs: { [branch]: pr } }],
      ["pr:changed", { repoId: "repo", prs: { [late]: { ...pr, number: 2 } } }]
    ]);
  } finally {
    reply.resolve(new Map());
    close();
  }
});

it("lets distinct targeted scopes run after the same blocked refresh", async () => {
  const next = "feature/next";
  const git = vi.fn<GitExec>(async (args) =>
    stdoutOk(args[0] === "for-each-ref" ? `${branch}\n${next}` : origin)
  );
  const started = deferred<void>();
  const release = deferred<void>();
  const fetch = vi.fn<TokenForgeProvider["fetchPrsForBranches"]>(async (_token, _repo, names) => {
    if (names.includes(branch)) {
      started.resolve();
      await release.promise;
    }
    return new Map(names.map((name) => [name, pr]));
  });
  const { bus, prs, close } = fixture(git, fetch);
  try {
    const submit = (name: string) => bus.dispatch("pr:refresh", { repoId: "repo", branches: [name] });
    const first = submit(branch);
    await started.promise;
    const queued = [submit(next), submit(branch), submit(next)];
    release.resolve();

    expect(await Promise.all([first, ...queued])).toEqual([ok(null), ok(null), ok(null), ok(null)]);
    expect(fetch.mock.calls.map(([, , names]) => names)).toEqual([[branch], [next]]);
    expect(git.mock.calls.filter(([args]) => args[0] === "for-each-ref")).toHaveLength(2);
    expect(prs.cachedBranchPr("repo", next)).toEqual(pr);
  } finally {
    release.resolve();
    close();
  }
});

it.each([4, 8, 16])("reads only requested cache rows for %i queued deleted branches", async (callers) => {
  const git = vi.fn<GitExec>(async (args) => stdoutOk(args[0] === "for-each-ref" ? branch : origin));
  const started = deferred<void>();
  const reply = deferred<Map<string, PrSummary | null>>();
  const fetch = vi.fn<TokenForgeProvider["fetchPrsForBranches"]>(() => {
    started.resolve();
    return reply.promise;
  });
  const { bus, db, close } = fixture(git, fetch);
  const deleted = Array.from({ length: callers }, (_, index) => `deleted/${index}`);
  const prepare = db.prepare.bind(db);
  const insert = prepare("INSERT INTO branch_pr (repo_id, branch, state, fetched_at) VALUES (?, ?, 'open', ?)");
  db.transaction(() => {
    const stale = new Date(0).toISOString();
    for (let index = 0; index < 4_000 - callers; index++) {
      insert.run("repo", `cached/${index}`, stale);
    }
    for (const name of deleted) {
      insert.run("repo", name, stale);
      insert.run("other", name, new Date(1_000_000).toISOString());
    }
  })();
  let rowsRead = 0;
  const countRows = vi.spyOn(db, "prepare").mockImplementation((sql) => {
    const statement = prepare(sql);
    if (/^SELECT branch, (?:state|fetched_at)(?:, (?:state|fetched_at))?\s+FROM branch_pr/i.test(sql.trim())) {
      const all = statement.all.bind(statement);
      statement.all = (...args) => {
        const rows = all(...args);
        rowsRead += rows.length;
        return rows;
      };
    }
    return statement;
  });
  try {
    const submit = (name: string, force = false) => bus.dispatch("pr:refresh", {
      repoId: "repo", branches: [name], trigger: "user", force
    });
    const first = submit(branch, true);
    await started.promise;
    const queued = deleted.map((name) => submit(name));
    reply.resolve(new Map([[branch, pr]]));
    expect(await Promise.all([first, ...queued])).toEqual(Array.from({ length: callers + 1 }, () => ok(null)));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(git.mock.calls.filter(([args]) => args[0] === "for-each-ref")).toHaveLength(callers + 1);
    expect(rowsRead).toBe(callers);
  } finally {
    reply.resolve(new Map());
    countRows.mockRestore();
    close();
  }
});

it("drops branch changes when a repository disappears during an attempt", async () => {
  const git: GitExec = async (args) => stdoutOk(args[0] === "for-each-ref" ? branch : origin);
  const started = deferred<void>();
  const reply = deferred<Map<string, PrSummary | null>>();
  const fetch = vi.fn<TokenForgeProvider["fetchPrsForBranches"]>(() => {
    started.resolve();
    return reply.promise;
  });
  const { bus, db, prs, close } = fixture(git, fetch);
  try {
    const request = { repoId: "repo", branches: [branch] };
    const first = bus.dispatch("pr:refresh", request);
    await started.promise;
    const follower = bus.dispatch("pr:refresh", request);
    db.prepare("DELETE FROM repos WHERE id = 'repo'").run();
    reply.resolve(new Map([[branch, pr]]));

    expect(await Promise.all([first, follower])).toEqual([ok(null), ok(null)]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(emitEvent).not.toHaveBeenCalled();
    expect(prs.cachedBranchPr("repo", branch)).toBeUndefined();
  } finally {
    reply.resolve(new Map());
    close();
  }
});

it("polls PR numbers during ref discovery and serializes branch and commit writes", async () => {
  const tip = "a".repeat(40);
  const refsStarted = deferred<void>();
  const releaseRefs = deferred<void>();
  const releaseStatus = deferred<void>();
  const tipStarted = deferred<void>();
  const releaseTip = deferred<void>();
  const calls: string[] = [];
  const open: PrSummary = { ...pr, headOid: tip };
  const merged: PrSummary = { ...open, state: "merged" };
  const git: GitExec = async (args) => {
    if (args[0] !== "for-each-ref") return stdoutOk(origin);
    calls.push("refs");
    refsStarted.resolve();
    await releaseRefs.promise;
    return stdoutOk(`${branch}\0${tip}\0\0\n`);
  };
  let numberCalls = 0;
  const { prs, close } = fixture(git, async () => {
    calls.push("branches");
    return new Map([[branch, null]]);
  }, {
    fetchPrsForCommits: async () => {
      calls.push("tip");
      tipStarted.resolve();
      await releaseTip.promise;
      return new Map([[tip, open]]);
    },
    fetchPrsByNumbers: async () => {
      calls.push("number");
      if (++numberCalls === 1) {
        await releaseStatus.promise;
      }
      return new Map([[pr.number, merged]]);
    }
  });

  const inFlight: Promise<unknown>[] = [];
  try {
    const refresh = prs.refreshRepo("repo");
    inFlight.push(refresh);
    await refsStarted.promise;
    const first = prs.refreshPrNumbers("repo", [pr.number]);
    inFlight.push(first);
    await setImmediate();
    expect(calls).toEqual(["refs", "number"]);

    releaseRefs.resolve();
    await setImmediate();
    expect(calls).toEqual(["refs", "number"]);
    releaseStatus.resolve();
    await first;
    await tipStarted.promise;
    const last = prs.refreshPrNumbers("repo", [pr.number]);
    inFlight.push(last);
    await setImmediate();
    expect(calls).toEqual(["refs", "number", "branches", "tip"]);
    releaseTip.resolve();

    expect((await refresh).get(branch)).toEqual(open);
    const final = await last;
    expect(final.branches.get(branch)).toMatchObject(merged);
    expect(final.commits.get(tip)).toMatchObject(merged);
    expect(calls).toEqual(["refs", "number", "branches", "tip", "number"]);
  } finally {
    releaseRefs.resolve();
    releaseStatus.resolve();
    releaseTip.resolve();
    await Promise.allSettled(inFlight);
    close();
  }
});
