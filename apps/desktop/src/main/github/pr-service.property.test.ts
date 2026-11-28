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

it("hands off between PR-number refreshes and branch tip associations in write order", async () => {
  const tip = "a".repeat(40);
  const firstStatus = deferred<void>();
  const releaseStatus = deferred<void>();
  const tipStarted = deferred<void>();
  const releaseTip = deferred<void>();
  const calls: string[] = [];
  const open: PrSummary = { ...pr, headOid: tip };
  const merged: PrSummary = { ...open, state: "merged" };
  const git: GitExec = async (args) => {
    if (args[0] !== "for-each-ref") return stdoutOk(origin);
    calls.push("refs");
    return stdoutOk(`${branch}\0${tip}\0\0\n`);
  };
  let numberCalls = 0;
  const { prs, close } = fixture(git, async () => new Map([[branch, null]]), {
    fetchPrsForCommits: async () => {
      calls.push("tip");
      tipStarted.resolve();
      await releaseTip.promise;
      return new Map([[tip, open]]);
    },
    fetchPrsByNumbers: async () => {
      calls.push("number");
      if (++numberCalls === 1) {
        firstStatus.resolve();
        await releaseStatus.promise;
      }
      return new Map([[pr.number, merged]]);
    }
  });

  try {
    const first = prs.refreshPrNumbers("repo", [pr.number]);
    await firstStatus.promise;
    const refresh = prs.refreshRepo("repo");
    await Promise.resolve();
    expect(calls).toEqual(["number"]);
    releaseStatus.resolve();
    await first;
    await tipStarted.promise;
    const last = prs.refreshPrNumbers("repo", [pr.number]);
    await Promise.resolve();
    expect(calls).toEqual(["number", "refs", "tip"]);
    releaseTip.resolve();

    expect((await refresh).get(branch)).toEqual(open);
    const final = await last;
    expect(final.branches.get(branch)).toMatchObject(merged);
    expect(final.commits.get(tip)).toMatchObject(merged);
    expect(calls).toEqual(["number", "refs", "tip", "number"]);
  } finally {
    releaseStatus.resolve();
    releaseTip.resolve();
    close();
  }
});
