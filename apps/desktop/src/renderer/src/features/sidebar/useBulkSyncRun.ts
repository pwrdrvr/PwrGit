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
  /** A finished run reopened from Sync options: the dialog draws this
   *  summary and starts nothing. */
  replay?: BulkSyncSummary;
};

/** The newest finished run, kept so Sync options can show it again. */
export type LastBulkSyncRun = {
  summary: BulkSyncSummary;
  mode: BulkSyncMode;
  scope: FetchScope;
  auto: boolean;
  at: Date;
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
export function describeAutoRun(
  summary: BulkSyncSummary | null,
  at: Date,
  mode: BulkSyncMode = "fetch"
): string {
  const time = at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const what = mode === "soft-pull" ? "pull" : "fetch";
  if (summary === null) return `The automatic ${what} at ${time} could not run.`;
  const { failed, partial, skipped } = summary.counts.repos;
  const repos = (n: number) => `${n} ${n === 1 ? "repository" : "repositories"}`;
  if (mode === "fetch") {
    // Repositories, each counted once: a repository whose only remote failed
    // is in both the remote and the repository counts, and is `partial`.
    const withFailures = failed + partial;
    return withFailures > 0
      ? `Last automatic fetch at ${time}: ${repos(withFailures)} with failures.`
      : `Last automatic fetch at ${time}: all fetched.`;
  }
  // A pull's partial and skipped repositories were held back (local changes,
  // diverged), not failed; calling them failures cried wolf every tick.
  const heldBack = partial + skipped;
  const parts = [
    failed > 0 ? `${repos(failed)} with failures` : null,
    heldBack > 0 ? `${repos(heldBack)} held back` : null
  ].filter((part) => part !== null);
  return parts.length > 0
    ? `Last automatic pull at ${time}: ${parts.join(", ")}.`
    : `Last automatic pull at ${time}: all pulled.`;
}

/**
 * Fetch and Try pull, all or recent, for one sidebar: the run, the
 * remembered verb, scope, view and interval, and the interval's timer.
 * A timed run runs the face: its verb and scope. 0.45.0 always fetched,
 * so a face set to Pull never pulled on the timer.
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
  const [lastAutoRun, setLastAutoRun] = useState<string | undefined>();
  const [lastRun, setLastRun] = useState<LastBulkSyncRun | null>(null);
  const lastRunRef = useRef(lastRun);
  lastRunRef.current = lastRun;
  const keyRef = useRef(0);
  const runRef = useRef(run);
  runRef.current = run;
  const latest = useRef({ repos, recentRepos, scope, verb });
  latest.current = { repos, recentRepos, scope, verb };

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
    if (summary !== null) {
      setLastRun({
        summary,
        mode: current.mode,
        scope: current.scope,
        auto: current.auto,
        at: new Date()
      });
    }
    if (current.auto) {
      setLastAutoRun(describeAutoRun(summary, new Date(), current.mode));
    }
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

  /**
   * Sync options' "Show": the run going now (a timed one is hidden), or the
   * last one's results. A timed run never raises a toast by itself, and a
   * finished toast leaves; this is how either is read afterwards.
   */
  const showRun = useCallback(() => {
    const current = runRef.current;
    if (current !== null && !current.finished) {
      const next = { ...current, view: "dialog" as const, autoMinimize: false };
      runRef.current = next;
      setRun(next);
      return;
    }
    const last = lastRunRef.current;
    if (last === null) return;
    keyRef.current += 1;
    const next: BulkSyncRun = {
      key: keyRef.current,
      mode: last.mode,
      scope: last.scope,
      repos: [],
      view: "dialog",
      autoMinimize: false,
      auto: last.auto,
      finished: true,
      replay: last.summary
    };
    runRef.current = next;
    setRun(next);
  }, []);

  // A run belongs to the profile that started it, and so does its record.
  useEffect(
    () => () => {
      close();
      setLastRun(null);
    },
    [close, profileId]
  );

  useEffect(() => {
    if (interval === 0 || profileId === null) return;
    // Read at each tick, so changing the face doesn't restart the timer.
    const timer = window.setInterval(
      () =>
        start(latest.current.verb === "pull" ? "soft-pull" : "fetch", {
          auto: true
        }),
      interval * 60_000
    );
    return () => window.clearInterval(timer);
  }, [interval, profileId, start]);

  return {
    run,
    scope,
    interval,
    lastAutoRun,
    lastRun,
    verb,
    busy: run !== null && !run.finished,
    start,
    runFace,
    pick,
    pickInterval,
    setView,
    finish,
    close,
    showRun
  };
}
