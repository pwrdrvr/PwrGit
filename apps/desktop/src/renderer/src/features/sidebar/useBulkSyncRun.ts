import { useCallback, useEffect, useRef, useState } from "react";
import type { BulkSyncMode, BulkSyncSummary, Repo } from "@pwrgit/shared";
import type { BulkSyncPresentation } from "./BulkSyncDialog";
import {
  readBulkSyncView,
  readFetchInterval,
  readFetchScope,
  writeBulkSyncView,
  writeFetchInterval,
  writeFetchScope,
  type BulkSyncView,
  type FetchInterval,
  type FetchScope
} from "./bulk-sync-prefs";

export type BulkSyncRun = {
  /** Remounts the run component, so each run is its own operation. */
  key: number;
  mode: BulkSyncMode;
  scope: FetchScope;
  repos: Repo[];
  repoIds?: string[];
  view: BulkSyncPresentation;
  /** The first run ever: the dialog minimises itself once. */
  autoMinimize: boolean;
  /** Started by the interval, not by a click. */
  auto: boolean;
  finished: boolean;
};

/**
 * Decides how a new request meets the run already there. Pure, so the
 * one-run-at-a-time rules are tested without a timer or a DOM.
 *
 * - A live run is never doubled. A click on a live run that nobody can see
 *   shows it in the remembered view; a timed tick leaves it alone.
 * - A finished run is replaced.
 * - Fetch recent with nothing in the Focused list starts nothing.
 */
export function nextBulkSyncRun(
  current: BulkSyncRun | null,
  request: {
    mode: BulkSyncMode;
    scope: FetchScope;
    auto: boolean;
    repos: Repo[];
    recentRepos: Repo[];
    remembered: BulkSyncView | null;
    key: number;
  }
): BulkSyncRun | null {
  if (current !== null && !current.finished) {
    if (request.auto || current.view !== "hidden") return current;
    return { ...current, view: request.remembered ?? "dialog" };
  }
  const scope = request.mode === "fetch" ? request.scope : "all";
  const repos = scope === "recent" ? request.recentRepos : request.repos;
  if (repos.length === 0) return current;
  return {
    key: request.key,
    mode: request.mode,
    scope,
    repos,
    ...(scope === "recent" ? { repoIds: repos.map((repo) => repo.id) } : {}),
    view: request.auto ? "hidden" : (request.remembered ?? "dialog"),
    autoMinimize: !request.auto && request.remembered === null,
    auto: request.auto,
    finished: false
  };
}

/** The tooltip line a timed run leaves behind. */
export function describeAutoFetch(
  summary: BulkSyncSummary | null,
  at: Date
): string {
  const time = at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (summary === null) return `The automatic fetch at ${time} could not run.`;
  const failed = summary.counts.remotes.failed + summary.counts.repos.failed;
  return failed > 0
    ? `Last automatic fetch at ${time}: ${failed} failed.`
    : `Last automatic fetch at ${time}: all fetched.`;
}

/**
 * Fetch all, Fetch recent and Try pull all for one sidebar: the run, the
 * remembered scope, view and interval, and the interval's timer.
 * Design: `design/Fetch Toast and Scope - UX Review.dc.html`.
 */
export function useBulkSyncRun({
  profileId,
  repos,
  recentRepos
}: {
  profileId: string | null;
  repos: Repo[];
  recentRepos: Repo[];
}) {
  const [scope, setScope] = useState<FetchScope>(readFetchScope);
  const [interval, setIntervalMinutes] =
    useState<FetchInterval>(readFetchInterval);
  const [run, setRun] = useState<BulkSyncRun | null>(null);
  const [lastAutoFetch, setLastAutoFetch] = useState<string | undefined>();
  const keyRef = useRef(0);
  const runRef = useRef(run);
  runRef.current = run;
  const latest = useRef({ repos, recentRepos, scope });
  latest.current = { repos, recentRepos, scope };

  const start = useCallback(
    (mode: BulkSyncMode, options: { scope?: FetchScope; auto?: boolean } = {}) => {
      keyRef.current += 1;
      const next = nextBulkSyncRun(runRef.current, {
        mode,
        scope: options.scope ?? latest.current.scope,
        auto: options.auto === true,
        repos: latest.current.repos,
        recentRepos: latest.current.recentRepos,
        remembered: readBulkSyncView(),
        key: keyRef.current
      });
      runRef.current = next;
      setRun(next);
    },
    []
  );

  const pickScope = useCallback(
    (next: FetchScope) => {
      writeFetchScope(next);
      setScope(next);
      start("fetch", { scope: next });
    },
    [start]
  );

  const pickInterval = useCallback((minutes: FetchInterval) => {
    writeFetchInterval(minutes);
    setIntervalMinutes(minutes);
  }, []);

  const setView = useCallback((view: BulkSyncView) => {
    writeBulkSyncView(view);
    setRun((current) =>
      current === null ? null : { ...current, view, autoMinimize: false }
    );
  }, []);

  const finish = useCallback((summary: BulkSyncSummary | null) => {
    const current = runRef.current;
    if (current === null) return;
    if (current.auto) setLastAutoFetch(describeAutoFetch(summary, new Date()));
    // A timed run nobody opened has nothing left to show.
    const next =
      current.view === "hidden" ? null : { ...current, finished: true };
    runRef.current = next;
    setRun(next);
  }, []);

  const close = useCallback(() => {
    runRef.current = null;
    setRun(null);
  }, []);

  // A run belongs to the profile that started it.
  useEffect(() => close, [close, profileId]);

  useEffect(() => {
    if (interval === 0 || profileId === null) return;
    const timer = window.setInterval(
      () => start("fetch", { auto: true }),
      interval * 60_000
    );
    return () => window.clearInterval(timer);
  }, [interval, profileId, start]);

  return {
    run,
    scope,
    interval,
    lastAutoFetch,
    fetchBusy: run !== null && !run.finished && run.mode === "fetch",
    start,
    pickScope,
    pickInterval,
    setView,
    finish,
    close
  };
}
