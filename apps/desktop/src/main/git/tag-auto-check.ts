import { TAG_SOURCE_SYNC_TTL_MS, TAG_SOURCE_VIEW_TTL_MS } from "@pwrgit/shared";
import { emitEvent } from "../ipc";
import { logMain } from "../logs";
import type { DB } from "../persistence/db";
import { limitConcurrency } from "../util/map-limit";
import { execGit, sanitizeGitLogDetail, type GitExec } from "./dugite";
import { controlledGit } from "./git-service";
import { tagSourcesFor, wasStopped, type TagSources } from "./tag-sources";

/** Automatic listings at once across all repositories: a bulk sync of 100
 *  repositories queues its checks rather than opening 100 connections. */
export const TAG_CHECK_CONCURRENCY = 2;
/** One automatic listing's own limit; a tracked operation stops it sooner. */
export const TAG_CHECK_TIMEOUT_MS = 20_000;
/** A remote that failed is not listed again automatically for this long. */
export const TAG_CHECK_RETRY_MS = 2 * 60_000;

type RepoRow = { path: string; profileId: string };

export type TagAutoCheckOptions = {
  /** The sync menu's "Check tags after sync" (`general.tagCheckAfterSync`). */
  enabledAfterSync?: () => boolean;
  /** True while a repository must not be listed: the network is known to be
   *  down, or the user's own remote operation on it is live. */
  paused?: (repoId: string) => boolean;
  git?: GitExec;
  sources?: Pick<TagSources, "source" | "refresh" | "recountPublisher" | "store">;
  now?: () => number;
  concurrency?: number;
  timeoutMs?: number;
};

/**
 * The automatic published-tag checks: the Tags tab's (stale after 10 min) and
 * the one after a Fetch or Pull from any path (stale after 1 h, behind the
 * sync menu's switch). Background checks, as the tip checker: untracked,
 * their own timeout, no repository lock (`ls-remote` writes no ref; the
 * snapshot is SQLite), and stopped by `yield` when the user starts an
 * operation on the repository. A `--no-tags` remote is never listed here.
 */
export class TagAutoChecks {
  private readonly sources: NonNullable<TagAutoCheckOptions["sources"]>;
  private readonly git: GitExec;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private enabledAfterSync: () => boolean;
  private paused: (repoId: string) => boolean;
  private readonly aborts = new Map<string, Set<AbortController>>();
  private readonly failedAt = new Map<string, number>();
  /** One check per repository and TTL at a time; a second asker shares it,
   *  so a Fetch and a bulk sync of one repository list once, and no check
   *  can pass the back-off while another's failure is landing. */
  private readonly running = new Map<string, Promise<boolean>>();
  /** After-sync checks only: the Tags tab's check never queues behind a bulk sync's. */
  private readonly queuedAfterSync: (repoId: string) => Promise<void>;

  constructor(private readonly db: DB, options: TagAutoCheckOptions = {}) {
    this.sources = options.sources ?? tagSourcesFor(db);
    this.git = options.git ?? execGit;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? TAG_CHECK_TIMEOUT_MS;
    this.enabledAfterSync = options.enabledAfterSync ?? (() => true);
    this.paused = options.paused ?? (() => false);
    this.queuedAfterSync = limitConcurrency(
      (repoId: string) => this.runAfterSync(repoId),
      options.concurrency ?? TAG_CHECK_CONCURRENCY
    );
  }

  /** The remote handlers own both signals: network down, and a live
   *  tracked operation (so a check that waited for a slot never starts in
   *  the middle of the user's Fetch, Pull or Push; `yield` only reaches
   *  checks already running). */
  pauseWhile(paused: (repoId: string) => boolean): void {
    this.paused = paused;
  }

  /** `index.ts` binds the sync menu's switch (the setting). */
  afterSyncWhen(enabled: () => boolean): void {
    this.enabledAfterSync = enabled;
  }

  /** A user's own operation outranks every automatic check on its repository. */
  yield(repoId: string): void {
    for (const controller of this.aborts.get(repoId) ?? []) controller.abort("superseded by a remote operation");
  }

  /** An explicit listing succeeded: the back-off no longer applies. */
  clearFailure(repoId: string, remote: string): void {
    this.failedAt.delete(`${repoId}\0${remote}`);
  }

  /** The Tags tab opened. True when it listed. Not behind the sync switch. */
  view(repoId: string): Promise<boolean> {
    return this.list(repoId, TAG_SOURCE_VIEW_TTL_MS, "view");
  }

  /**
   * A Fetch or Pull fetched this repository. Never awaited by the caller and
   * never fails it. Lists hourly at most; otherwise re-counts against the
   * stored listing (local name + id, no network), because local tags may have
   * moved since the sidebar's count was stored (a `git tag -f` in a terminal).
   */
  afterSync(repoId: string): void {
    if (!this.enabledAfterSync()) return;
    void this.queuedAfterSync(repoId).catch((cause) =>
      logMain("warn", "tag", `automatic tag check failed: ${sanitizeGitLogDetail(cause)}`)
    );
  }

  private async runAfterSync(repoId: string): Promise<void> {
    // Read again: the switch may have gone off while this waited for a slot.
    if (!this.enabledAfterSync()) return;
    if (await this.list(repoId, TAG_SOURCE_SYNC_TTL_MS, "after sync")) return;
    const repo = this.repoOf(repoId);
    if (repo === null) return;
    const moved = await this.sources.recountPublisher(this.git, repoId, repo.path);
    if (moved.ok && moved.value) this.announce(repoId, repo, true);
  }

  private list(repoId: string, ttlMs: number, reason: string): Promise<boolean> {
    const key = `${repoId}\0${ttlMs}`;
    const running = this.running.get(key);
    if (running !== undefined) return running;
    const run = this.listOnce(repoId, ttlMs, reason).finally(() => {
      if (this.running.get(key) === run) this.running.delete(key);
    });
    this.running.set(key, run);
    return run;
  }

  private async listOnce(repoId: string, ttlMs: number, reason: string): Promise<boolean> {
    const repo = this.repoOf(repoId);
    if (repo === null) return false;
    const source = await this.sources.source(this.git, repoId, repo.path, ttlMs);
    if (!source.ok) return false;
    const { state } = source.value;
    if (state.primary === null || state.tagOpt === "no-tags" || !state.stale) return false;
    // Read just before listing: the user may have started an operation on
    // this repository while the check waited for a slot or read its config.
    if (this.paused(repoId)) return false;
    const failedKey = `${repoId}\0${state.primary}`;
    if ((this.failedAt.get(failedKey) ?? 0) > this.now() - TAG_CHECK_RETRY_MS) return false;
    const controller = new AbortController();
    const aborts = this.aborts.get(repoId) ?? new Set();
    aborts.add(controller);
    this.aborts.set(repoId, aborts);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(this.timeoutMs)]);
    const startedAt = this.now();
    try {
      const refreshed = await this.sources.refresh(controlledGit(this.git, { signal }), repoId, repo.path, state.primary);
      if (!refreshed.ok) {
        // Yielding to the user's own operation is not a failure. Our own
        // timeout is: `refresh` leaves stopped listings unrecorded, so say it.
        if (!controller.signal.aborted) {
          this.failedAt.set(failedKey, this.now());
          if (wasStopped(refreshed.error)) {
            this.sources.store.recordFailure(repoId, state.primary, `Listing ${state.primary}'s tags timed out`, this.now());
          }
        }
        logMain("debug", "tag", `automatic tag check (${reason}) of ${state.primary} unavailable for ${repo.path}: ${sanitizeGitLogDetail(refreshed.error.message)}`);
        return false;
      }
      this.failedAt.delete(failedKey);
      logMain("info", "tag", `listed ${state.primary}'s tags for ${repo.path} (${reason}, ${((this.now() - startedAt) / 1000).toFixed(1)}s)`);
      this.announce(repoId, repo, refreshed.value);
      return true;
    } finally {
      aborts.delete(controller);
      if (aborts.size === 0) this.aborts.delete(repoId);
    }
  }

  private repoOf(repoId: string): RepoRow | null {
    return (
      (this.db
        .prepare("SELECT path, profile_id AS profileId FROM repos WHERE id = ?")
        .get(repoId) as RepoRow | undefined) ?? null
    );
  }

  /** The sidebar re-reads its count and rows; the lineage only when a moved tag came or went. */
  private announce(repoId: string, repo: RepoRow, movedSetChanged: boolean): void {
    emitEvent("repo:changed", { profileId: repo.profileId, repoIds: [repoId] });
    if (movedSetChanged) emitEvent("graph:changed", { repoId });
  }
}

const checks = new WeakMap<DB, TagAutoChecks>();

/**
 * One scheduler per database, shared by the remote and bulk-sync handlers,
 * so the concurrency ceiling and the failure back-off are one.
 */
export function tagAutoChecksFor(db: DB): TagAutoChecks {
  let found = checks.get(db);
  if (found === undefined) {
    found = new TagAutoChecks(db);
    checks.set(db, found);
  }
  return found;
}
