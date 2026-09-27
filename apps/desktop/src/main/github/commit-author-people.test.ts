import { beforeEach, describe, expect, it } from "vitest";
import type {
  CommitAuthorPerson,
  GitHubCommitAuthorIdentityLookup
} from "@pwrgit/shared";
import type { ForgeRepo } from "../forge/types";
import {
  CommitAuthorPeopleStore,
  PEOPLE_RECHECK_MS,
  PEOPLE_RETRY_BASE_MS,
  PEOPLE_SETTLE_MS,
  PEOPLE_TICK_SPACING_MS,
  PEOPLE_VISITS_PER_TICK
} from "./commit-author-people";

const GITHUB: ForgeRepo = { kind: "github", host: "github.com", path: "octo-org/example" };
const ADA_1 = "a".repeat(40);
const ADA_2 = "b".repeat(40);
const GRACE_1 = "c".repeat(40);
const ADA = { name: "Ada Lovelace", email: "Ada@Example.test", commitHashes: [ADA_1, ADA_2] };
const GRACE = { name: "Grace Hopper", email: "grace@example.test", commitHashes: [GRACE_1] };
const PROVEN: GitHubCommitAuthorIdentityLookup = {
  identity: { login: "ada", avatarUrl: "pwrgit-avatar://thumbnail/ada?v=1" },
  cacheState: "fresh",
  refreshState: "idle",
  refreshedAt: 500
};
const MISS: GitHubCommitAuthorIdentityLookup = { cacheState: "miss", refreshState: "idle" };

let now: number;
let calls: Array<{ worktreeId: string; commitHash: string; cacheOnly: boolean }>;
/** What a local read of each commit answers. */
let cached: Map<string, GitHubCommitAuthorIdentityLookup>;
/** What asking the forge about each commit answers, and then caches. */
let forge: Map<string, GitHubCommitAuthorIdentityLookup>;
let forgeRepo: ForgeRepo | null;
let published: Array<{ worktreeId: string; people: Record<string, CommitAuthorPerson> }>;
let timers: Array<{ delay: number; run: () => void; cleared: boolean }>;
let store: CommitAuthorPeopleStore;

beforeEach(() => {
  now = 1_000_000;
  calls = [];
  cached = new Map();
  forge = new Map();
  forgeRepo = GITHUB;
  published = [];
  timers = [];
  store = createStore();
});

function createStore(): CommitAuthorPeopleStore {
  return new CommitAuthorPeopleStore({
    identities: {
      request: (input) => {
        const cacheOnly = input.cacheOnly === true;
        calls.push({ worktreeId: input.worktreeId, commitHash: input.commitHash, cacheOnly });
        if (!cacheOnly) {
          const answer = forge.get(input.commitHash) ?? { ...MISS, refreshState: "backing-off" };
          cached.set(input.commitHash, answer);
          return { lookup: MISS, completion: Promise.resolve(answer) };
        }
        return {
          lookup: MISS,
          completion: Promise.resolve(cached.get(input.commitHash) ?? MISS)
        };
      },
      worktreeForge: async () => forgeRepo
    },
    publish: (worktreeId, people) => published.push({ worktreeId, people }),
    now: () => now,
    setTimer: ((run: () => void, delay: number) => {
      const timer = { delay, run, cleared: false };
      timers.push(timer);
      return timer;
    }) as unknown as typeof globalThis.setTimeout,
    clearTimer: ((timer: { cleared: boolean }) => {
      timer.cleared = true;
    }) as unknown as typeof globalThis.clearTimeout
  });
}

const networkCalls = (): typeof calls => calls.filter((call) => !call.cacheOnly);
const pendingTimer = (): { delay: number } | undefined =>
  timers.filter((timer) => !timer.cleared).at(-1);

describe("CommitAuthorPeopleStore", () => {
  it("answers a registration from cache and never asks the forge to do it", async () => {
    cached.set(ADA_2, PROVEN);

    await expect(store.replace("window:1", "wt-1", [ADA, GRACE])).resolves.toEqual({
      "ada@example.test": {
        state: "proven",
        identity: PROVEN.identity,
        profileUrl: "https://github.com/ada",
        forge: "github",
        checkedAt: 500
      },
      "grace@example.test": { state: "pending", forge: "github" }
    });
    expect(networkCalls()).toEqual([]);
  });

  it("asks about a new author on its own clock, after a settle, and publishes what changed", async () => {
    await store.replace("window:1", "wt-1", [GRACE]);
    expect(pendingTimer()?.delay).toBe(PEOPLE_SETTLE_MS);
    expect(networkCalls()).toEqual([]);

    now += PEOPLE_SETTLE_MS;
    forge.set(GRACE_1, {
      identity: { login: "grace" },
      cacheState: "fresh",
      refreshState: "idle",
      refreshedAt: now
    });
    await store.tick();

    expect(networkCalls()).toEqual([
      { worktreeId: "wt-1", commitHash: GRACE_1, cacheOnly: false }
    ]);
    expect(published).toEqual([{
      worktreeId: "wt-1",
      people: {
        "grace@example.test": {
          state: "proven",
          identity: { login: "grace" },
          profileUrl: "https://github.com/grace",
          forge: "github",
          checkedAt: now
        }
      }
    }]);
  });

  it("leaves an author the cache already answers for until the recheck", async () => {
    cached.set(ADA_1, PROVEN);
    await store.replace("window:1", "wt-1", [ADA]);

    now += PEOPLE_SETTLE_MS;
    await store.tick();
    expect(networkCalls()).toEqual([]);
    expect(pendingTimer()?.delay).toBe(PEOPLE_RECHECK_MS - PEOPLE_SETTLE_MS);
  });

  it("cannot be hurried: registering again, however often, brings no visit forward", async () => {
    forge.set(GRACE_1, { cacheState: "fresh", refreshState: "idle", refreshedAt: now });
    await store.replace("window:1", "wt-1", [GRACE]);
    now += PEOPLE_SETTLE_MS;
    await store.tick();
    expect(networkCalls()).toHaveLength(1);

    for (let i = 0; i < 20; i += 1) {
      now += PEOPLE_TICK_SPACING_MS;
      await store.replace("window:1", "wt-1", [GRACE]);
      await store.replace("window:2", "wt-1", [GRACE]);
      await store.tick();
    }
    expect(networkCalls()).toHaveLength(1);

    // Nor does withdrawing and re-registering reset the schedule.
    store.releaseReasons(["window:1", "window:2"]);
    await store.replace("window:3", "wt-1", [GRACE]);
    now += PEOPLE_SETTLE_MS;
    await store.tick();
    expect(networkCalls()).toHaveLength(1);
  });

  it("moves to the author's next commit when the forge cannot see one, and backs off", async () => {
    await store.replace("window:1", "wt-1", [ADA]);
    now += PEOPLE_SETTLE_MS;
    await store.tick();
    expect(networkCalls().map((call) => call.commitHash)).toEqual([ADA_1]);

    // Not yet: the retry waits out the base backoff.
    now += PEOPLE_RETRY_BASE_MS - 1;
    await store.tick();
    expect(networkCalls()).toHaveLength(1);

    forge.set(ADA_2, PROVEN);
    now += 1;
    await store.tick();
    expect(networkCalls().map((call) => call.commitHash)).toEqual([ADA_1, ADA_2]);
    expect(published.at(-1)?.people["ada@example.test"]?.state).toBe("proven");
  });

  it("doubles the wait after each unsettled visit, up to the recheck", async () => {
    const visitsAt: number[] = [];
    await store.replace("window:1", "wt-1", [GRACE]);
    now += PEOPLE_SETTLE_MS;
    for (let minute = 0; minute < 24 * 60; minute += 1) {
      const before = networkCalls().length;
      await store.tick();
      if (networkCalls().length > before) visitsAt.push(now);
      now += 60_000;
    }
    const gaps = visitsAt.slice(1).map((at, index) => at - (visitsAt[index] ?? at));
    expect(gaps.slice(0, 4)).toEqual([
      PEOPLE_RETRY_BASE_MS,
      2 * PEOPLE_RETRY_BASE_MS,
      4 * PEOPLE_RETRY_BASE_MS,
      8 * PEOPLE_RETRY_BASE_MS
    ]);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(PEOPLE_RECHECK_MS);
    expect(visitsAt.length).toBeLessThan(12);
  });

  it("spends a bounded number of visits per tick, oldest registration first", async () => {
    const authors = Array.from({ length: PEOPLE_VISITS_PER_TICK + 3 }, (_, index) => ({
      name: `Author ${index}`,
      email: `author-${index}@example.test`,
      commitHashes: [index.toString(16).padStart(40, "0")]
    }));
    await store.replace("window:1", "wt-1", authors);
    now += PEOPLE_SETTLE_MS;
    await store.tick();

    expect(networkCalls().map((call) => call.commitHash)).toEqual(
      authors.slice(0, PEOPLE_VISITS_PER_TICK).map((author) => author.commitHashes[0])
    );
    expect(pendingTimer()?.delay).toBe(PEOPLE_TICK_SPACING_MS);
  });

  it("stops visiting once no window shows an author", async () => {
    await store.replace("window:1", "wt-1", [GRACE]);
    store.releaseReasons(["window:1"]);
    expect(pendingTimer()).toBeUndefined();

    now += PEOPLE_SETTLE_MS;
    await store.tick();
    expect(networkCalls()).toEqual([]);

    await store.replace("window:1", "wt-1", [GRACE]);
    await store.replace("window:1", "wt-1", []);
    now += PEOPLE_SETTLE_MS;
    await store.tick();
    expect(networkCalls()).toEqual([]);
  });

  it("publishes nothing when a visit learns nothing new", async () => {
    await store.replace("window:1", "wt-1", [GRACE]);
    now += PEOPLE_SETTLE_MS;
    await store.tick();
    expect(published).toEqual([]);
  });

  it("keeps one worktree's people out of another's deltas", async () => {
    // Two profiles' worktrees can show the same address.
    await store.replace("window:1", "profile-a-wt", [GRACE]);
    await store.replace("window:2", "profile-b-wt", [GRACE]);
    forge.set(GRACE_1, {
      identity: { login: "grace" },
      cacheState: "fresh",
      refreshState: "idle",
      refreshedAt: now
    });
    now += PEOPLE_SETTLE_MS;
    await store.tick();

    expect(networkCalls().map((call) => call.worktreeId)).toEqual([
      "profile-a-wt",
      "profile-b-wt"
    ]);
    expect(published.map((delta) => delta.worktreeId)).toEqual([
      "profile-a-wt",
      "profile-b-wt"
    ]);
  });

  it("calls an origin no forge can prove unsupported, and leaves it alone", async () => {
    forgeRepo = null;
    cached.set(GRACE_1, { cacheState: "miss", refreshState: "not-eligible" });
    await expect(store.replace("window:1", "wt-1", [GRACE])).resolves.toEqual({
      "grace@example.test": { state: "unsupported" }
    });
    now += PEOPLE_SETTLE_MS;
    await store.tick();
    expect(networkCalls()).toEqual([]);
  });

  it("ignores authors with no usable commits and caps what one reason registers", async () => {
    const known = await store.replace("window:1", "wt-1", [
      { name: "No commits", email: "none@example.test", commitHashes: ["not-a-sha"] },
      { name: "Blank", email: "  ", commitHashes: [GRACE_1] },
      GRACE
    ]);
    expect(Object.keys(known)).toEqual(["grace@example.test"]);
  });
});
