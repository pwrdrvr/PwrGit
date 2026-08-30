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
import type { AppUpdateCheckResult } from "@pwrgit/shared";
import { subscribe } from "../../lib/pwrgit";
import { dismissToastKey, showErrorToast, showInfoToast } from "../../lib/toast";
import { useAppUpdateStatus } from "./useAppUpdateStatus";

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
  const {
    downloadedVersion: version,
    restarting,
    restartError,
    restart,
    resetRestart,
    setStatus
  } = useAppUpdateStatus();
  const [dismissedVersion, setDismissedVersion] = useState<
    string | undefined
  >();

  useEffect(
    () =>
      subscribe("app:updateCheckResult", (result) => {
        if (result.status === "downloaded") {
          // The sticky toast below carries this outcome, so the transient
          // notice has said all it is going to say — leaving it to run out its
          // countdown claims a check is still in flight after it finished.
          dismissToastKey(UPDATE_CHECK_TOAST_KEY);
          // Asking again is asking to see the answer again: an update the user
          // dismissed earlier comes back rather than the check looking dead,
          // and it comes back without the failed restart that preceded it.
          setDismissedVersion(undefined);
          resetRestart();
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
    [resetRestart, setStatus]
  );

  if (version === undefined || dismissedVersion === version) return null;

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
            void restart();
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
