// GitHub release metadata, cached. Ported from PwrAgent's
// `github-release-cache.ts`: a persisted ETag answer, a per-URL cooldown with
// failure backoff, and GitHub's rate-limit reset honoured across restarts.
// PwrAgent locks the state file across processes; PwrGit holds the
// single-instance lock, so one in-process queue serialises writers instead.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** A check Settings starts on open reuses an answer this fresh. */
export const RELEASE_TTL_MS = 6 * 60 * 60_000;
const FAILURE_BACKOFF_MS = 5 * 60_000;
const RATE_LIMIT_FALLBACK_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;

type Entry = {
  etag?: string;
  body?: string;
  lastSuccess?: number;
  nextAttempt?: number;
  failures?: number;
};

type State = { version: 1; rateLimitUntil?: number; entries: Record<string, Entry> };

export class ReleaseCheckDeferredError extends Error {
  constructor(readonly retryAt: number, readonly reason: "cooldown" | "rate-limit") {
    super(
      reason === "rate-limit"
        ? `GitHub’s rate limit for this network resets at ${new Date(retryAt).toLocaleTimeString()}.`
        : `Checked recently; the next check is at ${new Date(retryAt).toLocaleTimeString()}.`
    );
    this.name = "ReleaseCheckDeferredError";
  }
}

export type CachedAnswer = { body: string; fetchedAt: number; fromCache: boolean };

export type ReleaseCacheOptions = {
  directory: string;
  fetch?: typeof fetch;
  now?: () => number;
};

export class ReleaseMetadataCache {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly file: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: ReleaseCacheOptions) {
    this.file = join(options.directory, "release-cache.json");
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
  }

  private async read(): Promise<State> {
    try {
      const state = JSON.parse(await readFile(this.file, "utf8")) as State;
      if (state.version === 1 && typeof state.entries === "object" && state.entries !== null) return state;
    } catch {
      // Missing or unreadable: start over. A proxy's HTML never gets here,
      // because only parsed JSON bodies are stored.
    }
    return { version: 1, entries: {} };
  }

  private async write(state: State): Promise<void> {
    await mkdir(this.options.directory, { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
    await rename(temporary, this.file);
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** The stored answer for `url`, without asking GitHub. */
  cached(url: string): Promise<CachedAnswer | null> {
    return this.serial(async () => {
      const entry = (await this.read()).entries[url];
      return entry?.body !== undefined && entry.lastSuccess !== undefined
        ? { body: entry.body, fetchedAt: entry.lastSuccess, fromCache: true }
        : null;
    });
  }

  /**
   * GitHub's answer for `url`. Unforced, a fresh stored answer is returned
   * as is and a backed-off URL is deferred. Forced (Check now) skips the
   * cooldown but never GitHub's rate limit.
   */
  get(url: string, init: { force: boolean; signal?: AbortSignal; headers?: Record<string, string> }): Promise<CachedAnswer> {
    return this.serial(async () => {
      const state = await this.read();
      const now = this.now();
      const entry: Entry = state.entries[url] ?? {};
      if (now < (state.rateLimitUntil ?? 0)) throw new ReleaseCheckDeferredError(state.rateLimitUntil as number, "rate-limit");
      if (!init.force) {
        if (entry.body !== undefined && entry.lastSuccess !== undefined && now - entry.lastSuccess < RELEASE_TTL_MS && now >= entry.lastSuccess) {
          return { body: entry.body, fetchedAt: entry.lastSuccess, fromCache: true };
        }
        if (now < (entry.nextAttempt ?? 0)) throw new ReleaseCheckDeferredError(entry.nextAttempt as number, "cooldown");
      }
      const headers = new Headers(init.headers);
      if (entry.etag !== undefined && entry.body !== undefined) headers.set("If-None-Match", entry.etag);
      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          headers,
          signal: init.signal === undefined ? timeout : AbortSignal.any([init.signal, timeout])
        });
      } catch (error) {
        this.recordFailure(entry, now);
        state.entries[url] = entry;
        await this.write(state);
        throw error;
      }
      if (response.status === 304 && entry.body !== undefined) {
        entry.lastSuccess = now;
        entry.failures = 0;
        state.entries[url] = entry;
        await this.write(state);
        return { body: entry.body, fetchedAt: now, fromCache: false };
      }
      if (response.ok) {
        const body = await response.text();
        JSON.parse(body); // a captive portal's HTML is not a release list
        state.entries[url] = {
          body,
          lastSuccess: now,
          failures: 0,
          ...(response.headers.get("etag") ? { etag: response.headers.get("etag") as string } : {})
        };
        await this.write(state);
        return { body, fetchedAt: now, fromCache: false };
      }
      this.recordFailure(entry, now);
      state.entries[url] = entry;
      if (response.status === 403 || response.status === 429) {
        const reset = Number(response.headers.get("x-ratelimit-reset")) * 1000;
        const retry = response.headers.get("retry-after");
        const retryAt = retry !== null && /^\d+$/.test(retry) ? now + Number(retry) * 1000 : NaN;
        state.rateLimitUntil = Math.max(
          Number.isFinite(reset) && reset > now ? reset : now + RATE_LIMIT_FALLBACK_MS,
          Number.isFinite(retryAt) ? retryAt : 0
        );
      }
      await this.write(state);
      throw new Error(`GitHub answered HTTP ${response.status} for the release list`);
    });
  }

  private recordFailure(entry: Entry, now: number): void {
    entry.failures = Math.min((entry.failures ?? 0) + 1, 5);
    entry.nextAttempt = now + Math.min(RELEASE_TTL_MS, FAILURE_BACKOFF_MS * 2 ** (entry.failures - 1));
  }
}
