// The update state a window needs, in one place.
//
// PwrGit shows an offered update on two surfaces — the toast in every profile
// window and the Updates pane in Settings — and each had grown its own copy of
// the same three things: the subscribe-plus-initial-read race, the derived
// downloaded version, and the Restart call with its busy/error states. Two
// copies of a race is one too many: getting it wrong shows a stale status, and
// a correction to either copy leaves the other subscriber wrong.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { AppUpdateStatus } from "@pwrgit/shared";
import { dispatch, subscribe } from "../../lib/pwrgit";

export type AppUpdateStatusHandle = {
  status: AppUpdateStatus;
  /** The version waiting to install, or undefined when nothing is offered. */
  downloadedVersion: string | undefined;
  /** A Restart is in flight. Stays true through a successful one: main is
   *  quitting to install, and the window goes away rather than settling. */
  restarting: boolean;
  restartError: string | undefined;
  restart: () => Promise<void>;
  /** Drop a failed Restart, so the offer is presented clean again. */
  resetRestart: () => void;
  /** Push a status the caller already knows — the answer to a check it made
   *  itself — ahead of the event that will confirm it. */
  setStatus: (next: AppUpdateStatus) => void;
};

export function useAppUpdateStatus(): AppUpdateStatusHandle {
  const [status, setStatus] = useState<AppUpdateStatus>({ status: "idle" });
  const [restarting, setRestarting] = useState(false);
  const [restartError, setRestartError] = useState<string | undefined>();

  // Read the current status once, in case main reached `downloaded` before
  // this window mounted, and let any real event win that race.
  useEffect(() => {
    let canceled = false;
    let receivedEvent = false;
    const unsubscribe = subscribe("app:updateStatus", (next) => {
      receivedEvent = true;
      if (!canceled) setStatus(next);
    });
    void dispatch("app:readUpdateStatus", undefined).then((result) => {
      if (!canceled && !receivedEvent && result.ok) setStatus(result.value);
    });
    return () => {
      canceled = true;
      unsubscribe();
    };
  }, []);

  const downloadedVersion =
    status.status === "downloaded" ? status.version : undefined;

  const resetRestart = useCallback(() => {
    setRestartError(undefined);
    setRestarting(false);
  }, []);

  // A newly offered version arrives with a clean slate — a failed restart of
  // the previous one has nothing to say about this one.
  useEffect(() => {
    if (downloadedVersion === undefined) return;
    resetRestart();
  }, [downloadedVersion, resetRestart]);

  const restart = useCallback(async () => {
    setRestarting(true);
    setRestartError(undefined);
    const result = await dispatch("app:installUpdate", undefined);
    if (!result.ok) {
      setRestartError(result.error.message);
      setRestarting(false);
      return;
    }
    if (result.value.status === "error") {
      setRestartError(result.value.message);
      setRestarting(false);
    }
    // `restarting` — main is quitting to install; the window goes away.
  }, []);

  // Memoized so the handle is safe to name as an effect dependency: a fresh
  // object each render would resubscribe every caller's effects on every
  // render. `setStatus` is React's own setter and `restart`/`resetRestart` are
  // useCallback-stable, so this only ever changes when the state does.
  return useMemo(
    () => ({
      status,
      downloadedVersion,
      restarting,
      restartError,
      restart,
      resetRestart,
      setStatus
    }),
    [downloadedVersion, resetRestart, restart, restartError, restarting, status]
  );
}
