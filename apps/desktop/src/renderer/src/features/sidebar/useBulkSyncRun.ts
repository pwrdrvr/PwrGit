import { useCallback, useEffect, useRef, useState } from "react";
import type { BulkSyncMode, BulkSyncSummary, Repo } from "@pwrgit/shared";
import type { BulkSyncPresentation } from "./BulkSyncDialog";
import {
  readBulkSyncView,
  readFetchInterval,
  readFetchScope,
  readSyncVerb,
  writeBulkSyncView,
  writeFetchInterval,
  writeFetchScope,
  writeSyncVerb,
  type BulkSyncView,
  type FetchInterval,
  type FetchScope,
  type SyncVerb
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
 * - A finished run is replaced by a click. A timed tick skips while a
 *   finished run is still on screen, so it never closes what is being read.
 * - A recent run (fetch or pull) with nothing in the Focused list starts
 *   nothing.
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
  // A finished run still on screen is being read (a failure toast stays
  // until dismissed); a timed tick must not swap it for a hidden run.
  if (request.auto && current !== null && current.view !== "hidden") {
    return current;
  }
  const scope = request.scope;
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
  // Repositories, each counted once: a repository whose only remote failed
  // is in both the remote and the repository counts.
  const failed = summary.counts.repos.failed + summary.counts.repos.partial;
  return failed > 0
    ? `Last automatic fetch at ${time}: ${failed} ${failed === 1 ? "repository" : "repositories"} with failures.`
    : `Last automatic fetch at ${time}: all fetched.`;
}

/**
 * Fetch and Try pull, all or recent, for one sidebar: the run, the
 * remembered verb, scope, view and interval, and the interval's timer.
 * Timed runs only ever fetch: pulling on a timer would move checkouts under
 * the reader.
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
  const [verb, setVerb] = useState<SyncVerb>(readSyncVerb);
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

  /**
   * Remember a verb and scope as the face. It runs nothing: the menu is where
   * the button is set up, and the face is what runs it (0.45.0 ran each pick
   * and closed the menu, so changing two settings started a run).
   */
  const pick = useCallback((nextVerb: SyncVerb, nextScope: FetchScope) => {
    writeSyncVerb(nextVerb);
    writeFetchScope(nextScope);
    setVerb(nextVerb);
    setScope(nextScope);
  }, []);

  /** The face: run the remembered verb and scope. */
  const runFace = useCallback(() => {
    start(verb === "pull" ? "soft-pull" : "fetch");
  }, [start, verb]);

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
    verb,
    busy: run !== null && !run.finished,
    start,
    runFace,
    pick,
    pickInterval,
    setView,
    finish,
    close
  };
}
