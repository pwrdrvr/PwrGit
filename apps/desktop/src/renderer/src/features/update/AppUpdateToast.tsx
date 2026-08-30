// The update surface outside Settings, adapted from PwrSnap's and PwrAgnt's
// AppUpdateBanner to PwrGit's toast stack.
//
// Two jobs, both driven from main and both deliberately non-modal:
//
//  - A downloaded update is actionable, so it gets a toast that stays until
//    it is acted on or dismissed, with Restart on it. This is the one the
//    user meets without asking — a background check found the update.
//  - A user-initiated Help → Check for Updates reports its outcome through
//    the ordinary auto-dismissing toast stack, replacing its own
//    "Checking for updates…" notice in place.
//
// Dismissal is per version: a newer update raises the toast again.

import { useEffect, useState } from "react";
import type { AppUpdateCheckResult, AppUpdateStatus } from "@pwrgit/shared";
import { dispatch, subscribe } from "../../lib/pwrgit";
import { showErrorToast, showInfoToast } from "../../lib/toast";

/** One menu check, one toast — see `Toast.key`. */
export const UPDATE_CHECK_TOAST_KEY = "app:updateCheckResult";

/** Wording for a menu check that has nothing to act on. Kept parallel to
 *  Settings → Updates, which answers the same results inline. */
export function updateCheckToastCopy(
  result: Exclude<AppUpdateCheckResult, { status: "downloaded" }>
): { title: string; message: string; isError: boolean } {
  if (result.status === "checking") {
    return {
      title: "Checking for updates",
      message: "Asking GitHub for the latest release…",
      isError: false
    };
  }
  if (result.status === "skipped") {
    return {
      title: "Updates unavailable",
      message: result.reason,
      isError: false
    };
  }
  if (result.status === "error") {
    return {
      title: "Update check failed",
      message: result.message,
      isError: true
    };
  }
  if (result.status === "no-update") {
    return {
      title: "PwrGit is up to date",
      message: `You’re running v${result.version}.`,
      isError: false
    };
  }
  return {
    title: "Update available",
    message: `PwrGit v${result.version} is downloading in the background.`,
    isError: false
  };
}

export function AppUpdateToast() {
  const [status, setStatus] = useState<AppUpdateStatus>({ status: "idle" });
  const [dismissedVersion, setDismissedVersion] = useState<
    string | undefined
  >();
  const [restarting, setRestarting] = useState(false);
  const [restartError, setRestartError] = useState<string | undefined>();

  // Read the current status once in case main reached `downloaded` before this
  // window mounted, and let any real event win that race.
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

  useEffect(
    () =>
      subscribe("app:updateCheckResult", (result) => {
        if (result.status === "downloaded") {
          // Asking again is asking to see the answer again: an update the user
          // dismissed earlier comes back rather than the check looking dead.
          setDismissedVersion(undefined);
          setStatus(result);
          return;
        }
        const copy = updateCheckToastCopy(result);
        if (copy.isError) {
          showErrorToast({
            key: UPDATE_CHECK_TOAST_KEY,
            title: copy.title,
            message: copy.message
          });
          return;
        }
        showInfoToast({
          key: UPDATE_CHECK_TOAST_KEY,
          title: copy.title,
          message: copy.message
        });
      }),
    []
  );

  const version = status.status === "downloaded" ? status.version : undefined;

  useEffect(() => {
    if (version === undefined || dismissedVersion === version) return;
    // A newly offered version arrives with a clean slate — a failed restart of
    // the previous one has nothing to say about this one.
    setRestartError(undefined);
    setRestarting(false);
  }, [dismissedVersion, version]);

  if (version === undefined || dismissedVersion === version) return null;

  const handleRestart = async (): Promise<void> => {
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
  };

  return (
    <aside className="app-toast" role="status" aria-live="polite">
      <div className="app-toast__content">
        <p className="app-toast__eyebrow app-toast__eyebrow--info">
          Update ready
        </p>
        <p className="app-toast__message">
          Restart to update to v{version}.
        </p>
        {restartError !== undefined && (
          <p className="app-toast__error" role="alert">
            {restartError}
          </p>
        )}
      </div>
      <div className="app-toast__actions">
        <button
          className="app-toast__button app-toast__button--primary"
          type="button"
          disabled={restarting}
          onClick={() => {
            void handleRestart();
          }}
        >
          {restarting ? "Restarting…" : "Restart"}
        </button>
        <button
          className="app-toast__button"
          type="button"
          disabled={restarting}
          aria-label="Dismiss update notification"
          onClick={() => setDismissedVersion(version)}
        >
          Dismiss
        </button>
      </div>
    </aside>
  );
}
