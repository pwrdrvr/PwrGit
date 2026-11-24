import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import fc from "fast-check";
import { expect, test, vi } from "vitest";
import { ok, stackPositionForPr, type Repo } from "@pwrgit/shared";
import { CommandBus } from "../command-bus";
import type { GitExec } from "../git/dugite";
import { RepoIndexer } from "../git/repo-indexer";
import { NativeStackLocks } from "../git/stack-catalog-store";
import { registerStackReadHandlers } from "../git/stack-read-handlers";
import { StackReader, stackRunner } from "../git/stack-reader";
import { openDatabase, type DB } from "../persistence/db";
import { ProfileService } from "../profiles/profile-service";
import { resolveForge } from "../forge/providers";
import { registerChangeRequestHandlers } from "./change-request-handlers";
import { OpenPrService } from "./open-pr-service";
import { StackHistoryService } from "./stack-history-service";

const { emitEvent, fetchOpenPrs, getGitHubToken } = vi.hoisted(() => ({
  emitEvent: vi.fn(),
  fetchOpenPrs: vi.fn(async () => ({
    items: [{ number: 8, title: "Open PR", state: "open", isDraft: false, url: "https://github.com/example/orbit/pull/8" }],
    truncated: false,
  })),
  getGitHubToken: vi.fn(async () => "fixture"),
}));
vi.mock("../ipc", () => ({ emitEvent }));
vi.mock("../logs", () => ({ logMain: vi.fn() }));
vi.mock("./pr-client", async importOriginal => ({
  ...await importOriginal<typeof import("./pr-client")>(),
  getGitHubToken,
  fetchOpenPrs,
}));

const git: GitExec = async (args, cwd) => ok({
  stdout: args[0] === "remote" ? "origin\thttps://github.com/example/orbit.git (fetch)\n" :
    args[0] === "rev-parse" ? join(cwd, ".git") : "",
  stderr: "", exitCode: 0,
});

function stackPage(page: number, last: number, pr = 100 + page, etag = `"page-${page}"`): Response {
  return Response.json([{
    number: page, open: false, base: { ref: "main" },
    pull_requests: [{
      number: pr, state: "closed", head: { ref: `gone-${page}` },
      merged_at: "2026-11-12T10:00:00Z",
    }],
  }], { headers: {
    ETag: etag,
    ...(page < last ? { Link: `<https://api.github.com/repos/example/orbit/stacks?per_page=100&page=${page + 1}>; rel="next"` } : {}),
  } });
}

function pendingPage() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>(complete => { resolve = complete; });
  return { promise, resolve };
}

function startSession(db: DB, repos: readonly Repo[], now: () => number, enabled: () => boolean = () => true) {
  const openPrs = new OpenPrService(db, git, { now, resolveForge: url => enabled() ? resolveForge(url) : null });
  const bus = new CommandBus();
  registerChangeRequestHandlers(bus, openPrs);
  const history = new StackHistoryService(db, path => openPrs.forgeRemotes(path),
    scope => emitEvent("stack:changed", scope), enabled, now);
  const indexer = new RepoIndexer(db, git);
  indexer.onRepoDeleted(id => history.forgetRepo(id));
  const reader = new StackReader(stackRunner(git), new NativeStackLocks(() => { throw new Error("unexpected lock"); }),
    id => openPrs.list(id), () => undefined, repo => history.list(repo));
  registerStackReadHandlers(bus, id => repos.find(repo => repo.id === id) ?? null, reader);
  const readStacks = async (repo: Repo) => {
    const result = await bus.dispatch("stack:list", { repoId: repo.id, profileId: repo.profileId });
    if (!result.ok) throw new Error(result.error.message);
    return result.value.stacks;
  };
  return {
    bus, history, indexer, readStacks,
    deleteProfile: (profileId: string) => {
      db.prepare("DELETE FROM profiles WHERE id = ?").run(profileId);
      openPrs.invalidatePendingWrites();
      history.forgetProfile(profileId);
    },
    close: () => {
      for (const repo of repos) history.forgetProfile(repo.profileId);
      db.close();
      vi.unstubAllGlobals();
    },
  };
}

function fixture(dbPath = ":memory:", enabled?: () => boolean) {
  emitEvent.mockClear();
  fetchOpenPrs.mockClear();
  getGitHubToken.mockResolvedValue("fixture");
  const db = openDatabase(dbPath);
  const repo = (id: string, profileId: string): Repo => ({
    id, profileId, path: join(tmpdir(), `stack-history-${id}`), name: "orbit", pinned: false, worktrees: [],
  });
  const first = repo("repo", "p");
  const second = repo("other", "q");
  const third = repo("third", "q");
  for (const { profileId } of [first, second]) {
    db.prepare("INSERT INTO profiles (id, name, email) VALUES (?, ?, ?)").run(profileId, profileId, `${profileId}@example.invalid`);
  }
  for (const { id, profileId, path } of [first, second, third]) {
    db.prepare("INSERT INTO repos (id, profile_id, name, path) VALUES (?, ?, 'orbit', ?)").run(id, profileId, path);
  }
  let now = 0;
  return {
    ...startSession(db, [first, second, third], () => now, enabled),
    db, first, second, third,
    advance: (ms: number) => { now += ms; },
  };
}

test.each(["disabled", "retry-after", "exhausted"] as const)("queued refreshes pause for %s", async reason => {
  await fc.assert(fc.asyncProperty(
    fc.integer({ min: 90, max: 500 }),
    async seconds => {
      let enabled = true;
      const { advance, first, second, third, readStacks, close } = fixture(":memory:", () => enabled);
      const blocking = pendingPage();
      const other = pendingPage();
      const fetch = vi.fn<typeof globalThis.fetch>()
        .mockReturnValueOnce(blocking.promise)
        .mockReturnValueOnce(other.promise)
        .mockImplementation(async () => stackPage(1, 1, 333));
      vi.stubGlobal("fetch", fetch);
      getGitHubToken.mockClear();
      const flush = () => new Promise<void>(resolve => setImmediate(resolve));
      try {
        await readStacks(first);
        await readStacks(second);
        await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
        await readStacks(third);
        expect(fetch).toHaveBeenCalledTimes(2);

        const now = Math.floor(Date.now() / 1000) * 1000;
        const wallClock = vi.spyOn(Date, "now").mockReturnValue(now);
        try {
          if (reason === "disabled") {
            enabled = false;
            blocking.resolve(stackPage(1, 1, 111));
          } else {
            blocking.resolve(new Response(null, reason === "retry-after"
              ? { status: 429, headers: { "Retry-After": String(seconds) } }
              : { status: 403, headers: { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String(now / 1000 + seconds) } }));
          }
          await flush();
        } finally { wallClock.mockRestore(); }
        expect(fetch).toHaveBeenCalledTimes(2);

        if (reason === "disabled") {
          expect(getGitHubToken).toHaveBeenCalledTimes(2);
          enabled = true;
        } else {
          advance(seconds * 1000 - 1);
          await readStacks(third);
          await flush();
          expect(fetch).toHaveBeenCalledTimes(2);
          advance(1);
        }
        await readStacks(third);
        await vi.waitFor(() => expect(emitEvent).toHaveBeenCalledWith("stack:changed", {
          repoId: third.id, profileId: third.profileId,
        }));
        expect(fetch).toHaveBeenCalledTimes(3);
      } finally {
        blocking.resolve(stackPage(1, 1, 111));
        other.resolve(stackPage(1, 1, 222));
        close();
      }
    }), { numRuns: 3, examples: [[120]] });
});

test("removing a repository discards fresh and in-flight history before rediscovery", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), fc.boolean(), async (pruned, pending) => {
    const { advance, db, first, indexer, readStacks, close } = fixture();
    const obsolete = pendingPage();
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(stackPage(1, 1, 111))
      .mockImplementation(async () => stackPage(1, 1, 222));
    if (pending) fetch.mockReturnValueOnce(obsolete.promise);
    vi.stubGlobal("fetch", fetch);
    try {
      await readStacks(first);
      await vi.waitFor(() => expect(emitEvent).toHaveBeenCalledTimes(1));
      if (pending) {
        advance(10 * 60_000);
        await readStacks(first);
        await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
      }
      if (pruned) {
        db.prepare("UPDATE repos SET source = 'scan' WHERE id = ?").run(first.id);
        const profile = new ProfileService(db).get(first.profileId)!;
        expect(await indexer.rescanProfile(profile)).toEqual([]);
      } else {
        indexer.deleteRepo(first.id);
      }
      emitEvent.mockClear();
      db.prepare("INSERT INTO repos (id, profile_id, name, path) VALUES (?, ?, 'orbit', ?)").run(first.id, first.profileId, first.path);
      expect(await readStacks(first)).toEqual([]);
      if (pending) {
        expect(fetch.mock.calls[1][1]?.signal?.aborted).toBe(true);
        obsolete.resolve(stackPage(1, 1, 999));
      }
      await vi.waitFor(() => expect(emitEvent).toHaveBeenCalledTimes(1));
      expect((await readStacks(first)).map(stack => stack.layers[0].pr?.number)).toEqual([222]);
    } finally {
      obsolete.resolve(stackPage(1, 1, 999));
      close();
    }
  }), { numRuns: 4, examples: [[true, false], [true, true], [false, false], [false, true]] });
});

test("the open list publishes while a history page is pending", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 8 }), async heldPage => {
    const { bus, first, readStacks, close } = fixture();
    const page = pendingPage();
    const fetch = vi.fn(async (url: string) => {
      const number = Number(new URL(url).searchParams.get("page"));
      return number === heldPage ? page.promise : stackPage(number, heldPage);
    });
    vi.stubGlobal("fetch", fetch);
    let open: Promise<unknown> | undefined;
    try {
      expect(await readStacks(first)).toEqual([]);
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(heldPage));
      open = bus.dispatch("pr:openList", { repoId: first.id, refresh: true, wait: true });
      await vi.waitFor(() => expect(emitEvent).toHaveBeenCalledWith("pr:openChanged", { repoId: first.id }));
      expect(await open).toMatchObject({ ok: true, value: { entries: [{ pr: { number: 8 } }] } });
      expect(await readStacks(first)).toEqual([]);
      expect(fetch).toHaveBeenCalledTimes(heldPage);
      expect(emitEvent).toHaveBeenCalledTimes(1);

      page.resolve(stackPage(heldPage, heldPage));
      await vi.waitFor(() => expect(emitEvent).toHaveBeenCalledWith("stack:changed", { repoId: first.id, profileId: first.profileId }));
      const stacks = await readStacks(first);
      expect(stackPositionForPr(stacks, { number: 100 + heldPage, repoPath: "example/orbit" }))
        .toMatchObject({ index: 1, stack: { githubNumber: heldPage, closed: "merged" }, layer: { local: false } });
      expect(emitEvent).toHaveBeenCalledTimes(2);
    } finally {
      page.resolve(stackPage(heldPage, heldPage));
      await open;
      close();
    }
  }), { numRuns: 5, examples: [[7]] });
});

test("a fresh open list persisted across restart does not delay stack history", async ({ onTestFinished }) => {
  const dir = mkdtempSync(join(tmpdir(), "pwrgit-stack-restart-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "pwrgit.sqlite");
  const before = fixture(dbPath);
  const request = { repoId: before.first.id, refresh: true, wait: true } as const;
  const saved = await before.bus.dispatch("pr:openList", request).finally(before.close);
  expect(saved).toMatchObject({ ok: true, value: { fetchedAt: 0, entries: [{ pr: { number: 8 } }] } });
  expect(fetchOpenPrs).toHaveBeenCalledTimes(1);

  emitEvent.mockClear();
  const { bus, readStacks, close } = startSession(openDatabase(dbPath), [before.first], () => 30_000);
  const { first } = before;
  const page = pendingPage();
  const fetch = vi.fn(() => page.promise);
  vi.stubGlobal("fetch", fetch);
  try {
    expect(await bus.dispatch("pr:openList", request)).toEqual(saved);
    expect(fetchOpenPrs).toHaveBeenCalledTimes(1);
    expect(emitEvent).not.toHaveBeenCalled();

    expect(await readStacks(first)).toEqual([]);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    page.resolve(stackPage(1, 1));
    await vi.waitFor(() => expect(emitEvent.mock.calls).toEqual([
      ["stack:changed", { repoId: first.id, profileId: first.profileId }],
    ]));
    expect(stackPositionForPr(await readStacks(first), { number: 101, repoPath: "example/orbit" }))
      .toMatchObject({ stack: { closed: "merged" }, layer: { local: false } });
    expect(await bus.dispatch("pr:openList", request)).toEqual(saved);
    expect(fetchOpenPrs).toHaveBeenCalledTimes(1);
  } finally {
    page.resolve(stackPage(1, 1));
    close();
  }
});

test("a failed late page retains the last complete history and backs off independently", async () => {
  const { advance, bus, first, readStacks, close } = fixture();
  const fetch = vi.fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(stackPage(1, 2))
    .mockResolvedValueOnce(stackPage(2, 2))
    .mockResolvedValueOnce(stackPage(1, 2, 301, '"uncommitted"'))
    .mockResolvedValueOnce(new Response(null, { status: 429, headers: { "Retry-After": "120" } }))
    .mockResolvedValueOnce(new Response(null, { status: 304 }))
    .mockResolvedValueOnce(stackPage(2, 2, 202));
  vi.stubGlobal("fetch", fetch);
  const numbers = async () => (await readStacks(first)).map(stack => stack.layers[0].pr?.number);
  try {
    expect(await numbers()).toEqual([]);
    await vi.waitFor(() => expect(emitEvent).toHaveBeenCalledTimes(1));
    advance(60_000);
    await bus.dispatch("pr:openList", { repoId: first.id, refresh: true, wait: true });
    expect(await numbers()).toEqual([101, 102]);
    expect(fetch).toHaveBeenCalledTimes(2);
    emitEvent.mockClear();

    advance(9 * 60_000);
    expect(await numbers()).toEqual([101, 102]);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
    expect(await numbers()).toEqual([101, 102]);
    expect(emitEvent).not.toHaveBeenCalled();
    advance(119_999);
    expect(await numbers()).toEqual([101, 102]);
    expect(fetch).toHaveBeenCalledTimes(4);

    advance(1);
    expect(await numbers()).toEqual([101, 102]);
    await vi.waitFor(() => expect(emitEvent).toHaveBeenCalledTimes(1));
    expect(await numbers()).toEqual([101, 202]);
    const headers = fetch.mock.calls.slice(2).map(([, options]) => new Headers(options?.headers));
    expect(headers.map(header => header.get("Authorization"))).toEqual(Array(4).fill("Bearer fixture"));
    expect(headers.map(header => header.get("If-None-Match"))).toEqual(['"page-1"', '"page-2"', '"page-1"', '"page-2"']);
    expect(emitEvent).toHaveBeenCalledWith("stack:changed", { repoId: first.id, profileId: first.profileId });
  } finally {
    close();
  }
});

test("profiles sharing a forge repository have independent history and publication", async () => {
  const { advance, db, first, second, history, readStacks, deleteProfile, close } = fixture();
  const obsolete = pendingPage();
  const fetch = vi.fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(stackPage(1, 1, 111))
    .mockResolvedValueOnce(stackPage(1, 1, 222))
    .mockReturnValueOnce(obsolete.promise)
    .mockResolvedValueOnce(stackPage(1, 1, 333));
  vi.stubGlobal("fetch", fetch);
  const read = async (repo: Repo) => (await readStacks(repo)).map(stack => stack.layers[0].pr?.number);
  try {
    expect(await read(first)).toEqual([]);
    await vi.waitFor(() => expect(emitEvent).toHaveBeenCalledTimes(1));
    expect(await history.list({ ...first, profileId: second.profileId })).toEqual([]);
    expect(await read(second)).toEqual([]);
    await vi.waitFor(() => expect(emitEvent).toHaveBeenCalledTimes(2));
    expect(emitEvent.mock.calls).toEqual([
      ["stack:changed", { repoId: first.id, profileId: first.profileId }],
      ["stack:changed", { repoId: second.id, profileId: second.profileId }],
    ]);
    expect(new Headers(fetch.mock.calls[1][1]?.headers).has("If-None-Match")).toBe(false);
    expect(await read(first)).toEqual([111]);
    expect(await read(second)).toEqual([222]);

    advance(10 * 60_000);
    getGitHubToken.mockResolvedValue("rotated");
    expect(await read(first)).toEqual([111]);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    expect(new Headers(fetch.mock.calls[2][1]?.headers).has("If-None-Match")).toBe(false);
    deleteProfile(first.profileId);
    expect(fetch.mock.calls[2][1]?.signal?.aborted).toBe(true);
    db.prepare("INSERT INTO profiles (id, name, email) VALUES (?, 'Recreated', 'new@example.invalid')").run(first.profileId);
    db.prepare("INSERT INTO repos (id, profile_id, name, path) VALUES (?, ?, 'orbit', ?)").run(first.id, first.profileId, first.path);
    expect(await read(first)).toEqual([]);
    await vi.waitFor(() => expect(emitEvent).toHaveBeenCalledTimes(3));
    obsolete.resolve(stackPage(1, 1, 999));
    expect(await read(first)).toEqual([333]);
    expect(emitEvent).toHaveBeenCalledTimes(3);
  } finally {
    obsolete.resolve(stackPage(1, 1, 999));
    close();
  }
});

test("deleting a profile preserves another profile's cache and in-flight refresh", async () => {
  const { advance, first, second, readStacks, deleteProfile, close } = fixture();
  const deleted = pendingPage();
  const surviving = pendingPage();
  const fetch = vi.fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(stackPage(1, 1, 111))
    .mockResolvedValueOnce(stackPage(1, 1, 222))
    .mockReturnValueOnce(deleted.promise)
    .mockReturnValueOnce(surviving.promise);
  vi.stubGlobal("fetch", fetch);
  const read = async (repo: Repo) => (await readStacks(repo)).map(stack => stack.layers[0].pr?.number);
  try {
    await read(first);
    await vi.waitFor(() => expect(emitEvent).toHaveBeenCalledTimes(1));
    await read(second);
    await vi.waitFor(() => expect(emitEvent).toHaveBeenCalledTimes(2));
    emitEvent.mockClear();

    advance(10 * 60_000);
    expect(await read(first)).toEqual([111]);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    expect(await read(second)).toEqual([222]);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
    deleteProfile(first.profileId);
    expect(fetch.mock.calls[2][1]?.signal?.aborted).toBe(true);
    expect(fetch.mock.calls[3][1]?.signal?.aborted).toBe(false);
    expect(await read(second)).toEqual([222]);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(emitEvent).not.toHaveBeenCalled();

    deleted.resolve(stackPage(1, 1, 112));
    surviving.resolve(stackPage(1, 1, 223));
    await vi.waitFor(() => expect(emitEvent.mock.calls).toEqual([
      ["stack:changed", { repoId: second.id, profileId: second.profileId }],
    ]));
    expect(await read(second)).toEqual([223]);
  } finally {
    deleted.resolve(stackPage(1, 1, 112));
    surviving.resolve(stackPage(1, 1, 223));
    close();
  }
});
