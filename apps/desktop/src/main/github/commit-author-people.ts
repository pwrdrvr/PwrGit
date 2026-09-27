import {
  commitAuthorPersonKey,
  type CommitAuthorPerson,
  type GitHubCommitAuthorIdentityLookup
} from "@pwrgit/shared";
import { forgeOrigin, type ForgeRepo } from "../forge/types";
import { mapLimit } from "../util/map-limit";
import type { GitHubCommitAuthorIdentityService } from "./commit-author-identity";

/** Most authors one interest reason may register; the rest are ignored. */
export const PEOPLE_MAX_AUTHORS_PER_REASON = 200;
/** Commits kept per author. The newest is asked first; the rest are fallbacks
 *  for a commit the forge cannot see (not pushed yet, or rewritten). */
export const PEOPLE_MAX_COMMITS_PER_AUTHOR = 3;
/** Forge visits one tick may spend. The identity service queues the proofs
 *  themselves two at a time; this bounds how much one tick can queue. */
export const PEOPLE_VISITS_PER_TICK = 4;
/** Closest two ticks may run, however much is due. */
export const PEOPLE_TICK_SPACING_MS = 15_000;
/** How long a newly registered author waits before its first visit, so
 *  flicking through graphs registers people without asking about them. */
export const PEOPLE_SETTLE_MS = 2_000;
/** How often a settled author is looked at again. A visit to a fresh cache
 *  is a local read; the forge is asked only once a persisted TTL runs out
 *  (7 days for a proof, 24 hours for "no account", 30 days for an avatar). */
export const PEOPLE_RECHECK_MS = 6 * 60 * 60 * 1000;
/** First wait after a visit that left an author unsettled; doubles per
 *  consecutive unsettled visit, up to `PEOPLE_RECHECK_MS`. */
export const PEOPLE_RETRY_BASE_MS = 10 * 60 * 1000;
/** Authors no window references any more whose schedule is still remembered,
 *  so closing and reopening a graph cannot reset anyone's clock. */
const MAX_REMEMBERED_AUTHORS = 5_000;
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;
/** Local cache reads one registration may run at once (each is SQLite plus a
 *  thumbnail `stat`; the `git remote` behind them is coalesced per worktree). */
const READ_CONCURRENCY = 8;

type IdentityLookups = Pick<
  GitHubCommitAuthorIdentityService,
  "request" | "worktreeForge"
>;

export type CommitAuthorPeopleStoreDeps = {
  identities: IdentityLookups;
  /** A targeted delta for one worktree; only authors whose value changed. */
  publish: (worktreeId: string, people: Record<string, CommitAuthorPerson>) => void;
  now?: () => number;
  setTimer?: typeof globalThis.setTimeout;
  clearTimer?: typeof globalThis.clearTimeout;
};

export type CommitAuthorInterest = {
  name: string;
  email: string;
  commitHashes: readonly string[];
};

type AuthorRecord = {
  worktreeId: string;
  key: string;
  name: string;
  email: string;
  commitHashes: string[];
  /** Which of `commitHashes` the next forge visit proves with. */
  commitIndex: number;
  /** Unsettled visits in a row; drives the retry backoff. */
  unsettledVisits: number;
  nextVisitAt: number;
  /** Registration order, the tie-break between authors due at once. */
  order: number;
  person?: CommitAuthorPerson;
  reading?: Promise<LocalRead> | undefined;
};

type LocalRead = {
  person: CommitAuthorPerson;
  /** The cache has nothing a visit could add until a TTL runs out. */
  settled: boolean;
};

type Reason = { worktreeId: string; recordKeys: string[] };

/**
 * Main's store of commit authors, and the only thing that decides when to ask
 * a forge about one.
 *
 * Windows register interest in the authors they show — a replace-style reason
 * per window and monitor, as the PR monitors do — and are answered from cache
 * at once. Asking the forge happens here, on this store's own clock: a few
 * authors per tick, never-seen authors first, each settled author looked at
 * again every few hours. Whether a look reaches the network is the identity
 * cache's persisted TTL and backoff to decide, so registering again, opening
 * a card, or reloading a graph can never make a request happen sooner.
 */
export class CommitAuthorPeopleStore {
  private readonly identities: IdentityLookups;
  private readonly publish: CommitAuthorPeopleStoreDeps["publish"];
  private readonly now: () => number;
  private readonly setTimer: typeof globalThis.setTimeout;
  private readonly clearTimer: typeof globalThis.clearTimeout;
  private readonly reasons = new Map<string, Reason>();
  /** Insertion-ordered, so the oldest unreferenced author is dropped first. */
  private readonly records = new Map<string, AuthorRecord>();
  private nextOrder = 0;
  private timer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private timerAt = Number.POSITIVE_INFINITY;
  private lastTickAt = Number.NEGATIVE_INFINITY;
  private ticking = false;
  private stopped = false;

  constructor(deps: CommitAuthorPeopleStoreDeps) {
    this.identities = deps.identities;
    this.publish = deps.publish;
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? globalThis.setTimeout;
    this.clearTimer = deps.clearTimer ?? globalThis.clearTimeout;
  }

  /**
   * Replace one reason's authors and answer with what is known about each.
   * A reason is one window's one surface; an empty list withdraws it.
   */
  async replace(
    reasonId: string,
    worktreeId: string,
    authors: readonly CommitAuthorInterest[]
  ): Promise<Record<string, CommitAuthorPerson>> {
    if (this.stopped) return {};
    const now = this.now();
    const registered: AuthorRecord[] = [];
    const seen = new Set<string>();
    for (const author of authors) {
      if (registered.length >= PEOPLE_MAX_AUTHORS_PER_REASON) break;
      const key = commitAuthorPersonKey(author.email);
      if (key === "" || seen.has(key)) continue;
      const commitHashes = boundedHashes(author.commitHashes);
      if (commitHashes.length === 0) continue;
      seen.add(key);
      registered.push(this.register(worktreeId, key, author, commitHashes, now));
    }

    if (registered.length === 0) this.reasons.delete(reasonId);
    else {
      this.reasons.set(reasonId, {
        worktreeId,
        recordKeys: registered.map((record) => recordKey(record.worktreeId, record.key))
      });
    }
    this.forgetUnreferenced();
    this.schedule();

    const answered: Record<string, CommitAuthorPerson> = {};
    await mapLimit(registered, READ_CONCURRENCY, async (record) => {
      answered[record.key] = await this.known(record);
    });
    // A tick may have visited someone while the others were read, and already
    // published it; answer with that, not with what was known before it.
    for (const record of registered) {
      if (record.person !== undefined) answered[record.key] = record.person;
    }
    return answered;
  }

  /** Drop every reason one window held (it closed, or navigated away). */
  releaseReasons(reasonIds: Iterable<string>): void {
    for (const reasonId of reasonIds) this.reasons.delete(reasonId);
    this.forgetUnreferenced();
    this.schedule();
  }

  /** Run one tick now. Tests drive the clock through this. */
  async tick(): Promise<void> {
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    this.clearScheduled();
    const now = this.now();
    this.lastTickAt = now;
    try {
      const due = this.referenced()
        .filter((record) => record.nextVisitAt <= now)
        .sort((a, b) => a.nextVisitAt - b.nextVisitAt || a.order - b.order)
        .slice(0, PEOPLE_VISITS_PER_TICK);
      const changed = new Map<string, Record<string, CommitAuthorPerson>>();
      await Promise.all(due.map(async (record) => {
        const before = record.person;
        const after = await this.visit(record);
        if (before !== undefined && samePerson(before, after)) return;
        const people = changed.get(record.worktreeId) ?? {};
        people[record.key] = after;
        changed.set(record.worktreeId, people);
      }));
      if (this.stopped) return;
      for (const [worktreeId, people] of changed) this.publish(worktreeId, people);
    } finally {
      this.ticking = false;
      this.schedule();
    }
  }

  stop(): void {
    this.stopped = true;
    this.clearScheduled();
    this.reasons.clear();
    this.records.clear();
  }

  private register(
    worktreeId: string,
    key: string,
    author: CommitAuthorInterest,
    commitHashes: string[],
    now: number
  ): AuthorRecord {
    const id = recordKey(worktreeId, key);
    const existing = this.records.get(id);
    if (existing !== undefined) {
      // The newest registration describes what is on screen now. Its schedule
      // is untouched: that is the point of remembering it.
      existing.name = author.name;
      existing.email = author.email;
      if (!sameHashes(existing.commitHashes, commitHashes)) {
        existing.commitHashes = commitHashes;
        existing.commitIndex = 0;
      }
      // Refresh recency so a live author is the last one forgotten.
      this.records.delete(id);
      this.records.set(id, existing);
      return existing;
    }
    const record: AuthorRecord = {
      worktreeId,
      key,
      name: author.name,
      email: author.email,
      commitHashes,
      commitIndex: 0,
      unsettledVisits: 0,
      nextVisitAt: now + PEOPLE_SETTLE_MS,
      order: this.nextOrder++
    };
    this.records.set(id, record);
    return record;
  }

  /** What the store knows now: memory, or a local read for someone new. */
  private async known(record: AuthorRecord): Promise<CommitAuthorPerson> {
    if (record.person !== undefined) return record.person;
    record.reading ??= this.read(record).finally(() => {
      record.reading = undefined;
    });
    const { person, settled } = await record.reading;
    // A visit that finished while this read ran knows more; keep it.
    if (record.person !== undefined) return record.person;
    record.person = person;
    // An author the cache already fully answers for waits for the ordinary
    // recheck rather than being visited as soon as it settles.
    if (settled) {
      record.nextVisitAt = Math.max(record.nextVisitAt, this.now() + PEOPLE_RECHECK_MS);
      this.schedule();
    }
    return person;
  }

  /** Strictly local: the best cached answer across this author's commits. */
  private async read(record: AuthorRecord): Promise<LocalRead> {
    const [forge, lookups] = await Promise.all([
      this.identities.worktreeForge(record.worktreeId).catch(() => undefined),
      Promise.all(record.commitHashes.map(async (commitHash) =>
        await this.lookup(record, commitHash, true)
      ))
    ]);
    const best = bestLookup(lookups);
    return { person: personFrom(best, forge), settled: isSettled(best) };
  }

  /** One forge visit — only as far as the identity cache says is due. */
  private async visit(record: AuthorRecord): Promise<CommitAuthorPerson> {
    const commitHash =
      record.commitHashes[record.commitIndex % record.commitHashes.length] ??
      record.commitHashes[0];
    const lookup = commitHash === undefined
      ? unavailable()
      : await this.lookup(record, commitHash, false);
    const now = this.now();
    if (isSettled(lookup)) {
      record.unsettledVisits = 0;
      record.nextVisitAt = now + PEOPLE_RECHECK_MS;
    } else {
      record.unsettledVisits += 1;
      // The forge could not see this commit, or could not be reached; the
      // next visit proves with the author's next commit instead.
      if (lookup.identity === undefined && lookup.cacheState === "miss") {
        record.commitIndex += 1;
      }
      const backoff = Math.min(
        PEOPLE_RECHECK_MS,
        PEOPLE_RETRY_BASE_MS * 2 ** Math.min(16, record.unsettledVisits - 1)
      );
      record.nextVisitAt = Math.max(
        now + backoff,
        lookup.nextRetryAt ?? 0,
        lookup.avatarCache?.nextRetryAt ?? 0
      );
    }
    const { person } = await this.read(record);
    record.person = person;
    return person;
  }

  private async lookup(
    record: AuthorRecord,
    commitHash: string,
    cacheOnly: boolean
  ): Promise<GitHubCommitAuthorIdentityLookup> {
    try {
      const request = this.identities.request({
        worktreeId: record.worktreeId,
        commitHash,
        authorName: record.name,
        authorEmail: record.email,
        cacheOnly
      });
      return (await request.completion) ?? request.lookup;
    } catch {
      return unavailable();
    }
  }

  private referenced(): AuthorRecord[] {
    const ids = new Set<string>();
    for (const reason of this.reasons.values()) {
      for (const id of reason.recordKeys) ids.add(id);
    }
    const records: AuthorRecord[] = [];
    for (const id of ids) {
      const record = this.records.get(id);
      if (record !== undefined) records.push(record);
    }
    return records;
  }

  private forgetUnreferenced(): void {
    if (this.records.size <= MAX_REMEMBERED_AUTHORS) return;
    const live = new Set<string>();
    for (const reason of this.reasons.values()) {
      for (const id of reason.recordKeys) live.add(id);
    }
    for (const id of this.records.keys()) {
      if (this.records.size <= MAX_REMEMBERED_AUTHORS) return;
      if (!live.has(id)) this.records.delete(id);
    }
  }

  private schedule(): void {
    if (this.stopped || this.ticking) return;
    let soonest = Number.POSITIVE_INFINITY;
    for (const record of this.referenced()) {
      soonest = Math.min(soonest, record.nextVisitAt);
    }
    if (soonest === Number.POSITIVE_INFINITY) {
      this.clearScheduled();
      return;
    }
    const at = Math.max(soonest, this.lastTickAt + PEOPLE_TICK_SPACING_MS);
    if (this.timer !== null && this.timerAt <= at) return;
    this.clearScheduled();
    this.timerAt = at;
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.timerAt = Number.POSITIVE_INFINITY;
      void this.tick();
    }, Math.min(MAX_TIMER_DELAY_MS, Math.max(0, at - this.now())));
    this.timer.unref?.();
  }

  private clearScheduled(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.timerAt = Number.POSITIVE_INFINITY;
  }
}

function recordKey(worktreeId: string, key: string): string {
  return `${worktreeId}\0${key}`;
}

function boundedHashes(hashes: readonly string[]): string[] {
  const unique: string[] = [];
  for (const hash of hashes) {
    const normalized = hash.trim().toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(normalized) || unique.includes(normalized)) continue;
    unique.push(normalized);
    if (unique.length >= PEOPLE_MAX_COMMITS_PER_AUTHOR) break;
  }
  return unique;
}

function sameHashes(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((hash, index) => hash === b[index]);
}

function unavailable(): GitHubCommitAuthorIdentityLookup {
  return { cacheState: "miss", refreshState: "backing-off" };
}

/**
 * Nothing left for a visit to do until a TTL runs out: a fresh answer with a
 * fresh avatar, or an author no forge can prove.
 */
function isSettled(lookup: GitHubCommitAuthorIdentityLookup): boolean {
  if (lookup.refreshState === "not-eligible") return true;
  return lookup.refreshState === "idle" &&
    lookup.cacheState === "fresh" &&
    lookup.avatarCache === undefined;
}

/**
 * The strongest answer across one author's commits: an account, fresh before
 * stale, then an authoritative "no account", then whatever the newest commit
 * said. Ties keep the newer commit.
 */
function bestLookup(
  lookups: readonly GitHubCommitAuthorIdentityLookup[]
): GitHubCommitAuthorIdentityLookup {
  const rank = (lookup: GitHubCommitAuthorIdentityLookup): number => {
    if (lookup.identity !== undefined) {
      return (lookup.cacheState === "fresh" ? 4 : 3) +
        (lookup.identity.avatarUrl === undefined ? 0 : 0.5);
    }
    if (lookup.cacheState !== "miss") return 2;
    return lookup.refreshState === "not-eligible" ? 1 : 0;
  };
  let best = lookups[0] ?? unavailable();
  for (const lookup of lookups.slice(1)) {
    if (rank(lookup) > rank(best)) best = lookup;
  }
  return best;
}

function personFrom(
  lookup: GitHubCommitAuthorIdentityLookup,
  forge: ForgeRepo | null | undefined
): CommitAuthorPerson {
  const forgeField = forge == null ? {} : { forge: forge.kind };
  if (forge === null || lookup.refreshState === "not-eligible") {
    return { state: "unsupported", ...forgeField };
  }
  const checkedAt = lookup.refreshedAt === undefined ? {} : { checkedAt: lookup.refreshedAt };
  if (lookup.identity !== undefined) {
    return {
      state: "proven",
      identity: lookup.identity,
      ...(forge === undefined
        ? {}
        : { profileUrl: `${forgeOrigin(forge)}/${encodeURIComponent(lookup.identity.login)}` }),
      ...forgeField,
      ...checkedAt
    };
  }
  if (lookup.cacheState !== "miss") return { state: "none", ...forgeField, ...checkedAt };
  return { state: "pending", ...forgeField };
}

function samePerson(a: CommitAuthorPerson, b: CommitAuthorPerson): boolean {
  return a.state === b.state &&
    a.identity?.login === b.identity?.login &&
    a.identity?.avatarUrl === b.identity?.avatarUrl &&
    a.profileUrl === b.profileUrl &&
    a.forge === b.forge &&
    a.checkedAt === b.checkedAt;
}
