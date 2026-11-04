import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import {
  EMPTY_MAINTENANCE_RUN_VIEW,
  foldMaintenanceProgress,
  type MaintenanceCurrent,
  type MaintenanceProgress,
  type MaintenanceRepoResult,
  type MaintenanceRunRecord,
  type MaintenanceRunView,
  type MaintenanceSummary
} from "@pwrgit/shared";
import { dispatch, subscribe } from "../../lib/pwrgit";

/** Whether a dialog opening now shows this run instead of its setup: a live
 *  run, or a finished one whose receipt no dialog has drawn. */
export function showsOnOpen(current: MaintenanceCurrent): boolean {
  return current !== null && (current.state === "running" || !current.seen);
}

/** Whether this window reopens Maintenance by itself after a reload. Only
 *  for a run it started: another window's run waits to be asked for. */
export function reopensAfterReload(current: MaintenanceCurrent): boolean {
  return showsOnOpen(current) && current!.run.ownWindow;
}

/** The receipt was drawn (or the run answered its own dialog). */
export function markMaintenanceSeen(profileId: string, operationId: string): void {
  void dispatch("maintenance:seen", { profileId, operationId }).catch(() => undefined);
}

/**
 * Reattach to this profile's maintenance run, if there is one to show.
 *
 * Subscribes before it asks, so no event is lost in between; an event that
 * arrives before the answer is held, then folded only if the snapshot does
 * not already hold it (`seq`). `claim` hears every answer, null included,
 * and says whether this caller draws it. A finished run, or a followed run
 * that finishes, is marked seen. Returns the detach.
 */
export function attachMaintenanceRun(
  profileId: string,
  handlers: {
    claim: (current: NonNullable<MaintenanceCurrent> | null) => boolean;
    /** `cancelling`: a cancel was already accepted before the reload. */
    running: (run: MaintenanceRunRecord, view: MaintenanceRunView, cancelling: boolean) => void;
    progress: (view: MaintenanceRunView) => void;
    /** Null summary: the run stopped on an error. */
    finished: (run: MaintenanceRunRecord, summary: MaintenanceSummary | null) => void;
  }
): () => void {
  let detached = false;
  let followed: { run: MaintenanceRunRecord; view: MaintenanceRunView } | null = null;
  const early: MaintenanceProgress[] = [];
  const stop = (): void => {
    if (detached) return;
    detached = true;
    off();
  };
  const finish = (run: MaintenanceRunRecord, summary: MaintenanceSummary | null): void => {
    stop();
    markMaintenanceSeen(profileId, run.operationId);
    handlers.finished(run, summary);
  };
  const take = (event: MaintenanceProgress): void => {
    if (followed === null || event.operationId !== followed.run.operationId) return;
    if (event.phase === "finished") {
      finish(followed.run, event.summary ?? null);
      return;
    }
    const next = foldMaintenanceProgress(followed.view, event);
    if (next === followed.view) return;
    followed.view = next;
    handlers.progress(next);
  };
  const off = subscribe("maintenance:progress", (event) => {
    if (detached || event.profileId !== profileId) return;
    if (followed === null) early.push(event);
    else take(event);
  });
  const settle = (current: MaintenanceCurrent): void => {
    if (detached) return;
    const shown = showsOnOpen(current) ? current : null;
    if (!handlers.claim(shown) || shown === null) {
      stop();
      return;
    }
    if (shown.state === "finished") {
      finish(shown.run, shown.summary);
      return;
    }
    followed = { run: shown.run, view: shown.view };
    handlers.running(shown.run, shown.view, shown.cancelling);
    for (const event of early.splice(0)) take(event);
  };
  void dispatch("maintenance:current", { profileId })
    .then((answer) => settle(answer.ok ? answer.value : null))
    .catch(() => settle(null));
  return stop;
}

/**
 * A run's view, plus the lookups the dialogs draw from. The view is the
 * fold main keeps too (`foldMaintenanceProgress`); keep run rows here, not
 * in hand-written state.
 */
export function useMaintenanceRunView(): {
  view: MaintenanceRunView;
  setView: Dispatch<SetStateAction<MaintenanceRunView>>;
  current: Set<string>;
  details: Map<string, string>;
  results: Map<string, MaintenanceRepoResult>;
} {
  const [view, setView] = useState<MaintenanceRunView>(EMPTY_MAINTENANCE_RUN_VIEW);
  const current = useMemo(() => new Set(view.running), [view.running]);
  const details = useMemo(() => new Map(Object.entries(view.details)), [view.details]);
  const results = useMemo(
    () => new Map(view.results.map((result) => [result.repo.id, result])),
    [view.results]
  );
  return { view, setView, current, details, results };
}

/**
 * A reload (or a renderer crash) loses the Maintenance dialog, not main's
 * run. Call `open` for a run this window started that is still live or
 * finished unseen; the dialog then reattaches (`attachMaintenanceRun`).
 */
export function useReopenMaintenanceAfterReload(profileId: string | undefined, open: () => void): void {
  useEffect(() => {
    if (profileId === undefined) return;
    let cancelled = false;
    void dispatch("maintenance:current", { profileId })
      .then((answer) => {
        if (!cancelled && answer?.ok === true && reopensAfterReload(answer.value)) open();
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // `open` only sets state; the question is asked once per profile.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId]);
}
