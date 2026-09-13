// The update surface outside Settings, adapted from PwrSnap's and PwrAgnt's
// AppUpdateBanner to PwrGit's toast stack.
//
// Three jobs, all driven from main and all deliberately non-modal:
//
//  - A user-initiated Help → Check for Updates gets a LIVE card for as long as
//    it is working: indeterminate while the release read is out, a real meter
//    with a Cancel button once bytes are moving. It is not on a countdown,
//    because the work it reports is not.
//  - When that check lands on something with nothing to act on — up to date,
//    unavailable, canceled, failed — it hands off to the ordinary
//    auto-dismissing toast stack, which is where a notice that has finished
//    talking belongs.
//  - A downloaded update is actionable, so it gets a toast that stays until it
//    is acted on or dismissed, with Restart on it. This is the one the user
//    meets without asking — a background check found the update.
//
// Background (startup/periodic) checks raise no card at all: they never emit
// `app:updateCheckResult`, and the live card is gated on having seen one. That
// gate is the whole reason this component listens to two channels instead of
// one — `app:updateStatus` alone cannot tell a check the user asked for from
// one the hour hand asked for.
//
// Dismissal is per version: a newer update raises the toast again.

import { useCallback, useEffect, useRef, useState } from "react";
import type { AppUpdateCheckResult } from "@pwrgit/shared";
import { dispatch, subscribe } from "../../lib/pwrgit";
import { dismissToastKey, showErrorToast, showInfoToast } from "../../lib/toast";
import { useAppUpdateStatus } from "./useAppUpdateStatus";
import { isUpdateCheckInProgress, updateProgressCopy } from "./update-progress";

/** One menu check, one toast — see `Toast.key`. */
export const UPDATE_CHECK_TOAST_KEY = "app:updateCheckResult";

/** Wording for a menu check that has finished and left nothing to act on.
 *  Kept parallel to Settings → Updates, which answers the same results
 *  inline. The in-flight statuses are not here: they are the live card's, and
 *  `updateProgressCopy` words those. */
export function updateCheckToastCopy(
  result: Exclude<AppUpdateCheckResult, { status: "downloaded" | "checking" }>
): { title: string; message: string; isError: boolean } {
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
  if (result.status === "canceled") {
    return {
      title: "Download canceled",
      message: `PwrGit v${result.version} is still available — check again to download it.`,
      isError: false
    };
  }
  if (result.status === "available") {
    // Only reachable when the download was already under way before this
    // check ran — a fresh offer arrives as `downloaded`, through the live
    // card and then the sticky one.
    return {
      title: "Update available",
      message: `PwrGit v${result.version} is downloading in the background.`,
      isError: false
    };
  }
  return {
    title: "PwrGit is up to date",
    message: `You’re running v${result.version}.`,
    isError: false
  };
}

export function AppUpdateToast() {
  const {
    status,
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
  // A check the user asked for is running. Only then does the live card show:
  // hourly background checks move the same statuses and must stay silent.
  const [watching, setWatching] = useState(false);
  const [canceling, setCanceling] = useState(false);
  // Read inside the subscription without making the status a dependency of it
  // — resubscribing on every progress tick would drop events between the
  // unsubscribe and the re-subscribe. Written during render rather than in an
  // effect so it is never a commit behind: the value is only ever read from an
  // event callback, never during render, so there is nothing to tear.
  const statusRef = useRef(status);
  statusRef.current = status;

  useEffect(
    () =>
      subscribe("app:updateCheckResult", (result) => {
        if (result.status === "checking") {
          // The only mid-flight tick on this channel; everything else on it is
          // an outcome. The live card takes it from here, driven by
          // `app:updateStatus`.
          //
          // Asking again is asking to see the answer again: an update the user
          // dismissed earlier comes back rather than the check looking dead,
          // and it comes back without the failed restart that preceded it.
          setWatching(true);
          setCanceling(false);
          setDismissedVersion(undefined);
          resetRestart();
          dismissToastKey(UPDATE_CHECK_TOAST_KEY);
          // This tick outruns the status event it mirrors, and a card rendered
          // from a stale `idle` would flash the wrong copy — but a check that
          // JOINED one already downloading is further along than `checking`,
          // and must not be walked backwards.
          if (!isUpdateCheckInProgress(statusRef.current)) setStatus(result);
          return;
        }
        // Everything below is an outcome, so the live card has nothing left to
        // report and must come down before the outcome is shown.
        setWatching(false);
        setCanceling(false);
        if (result.status === "downloaded") {
          // The sticky card below carries this one.
          dismissToastKey(UPDATE_CHECK_TOAST_KEY);
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

  const cancel = useCallback(() => {
    setCanceling(true);
    void dispatch("app:cancelUpdateDownload", undefined);
    // No state change on the reply: main answers the click with a check
    // result either way, and a `canceled: false` race means the download
    // finished — which is about to raise the Restart card, not un-press this.
  }, []);

  const progress =
    watching && isUpdateCheckInProgress(status)
      ? updateProgressCopy(status)
      : undefined;
  const offered = version !== undefined && dismissedVersion !== version;
  if (progress === undefined && !offered) return null;

  return (
    <>
      {progress !== undefined && (
        <aside className="app-toast" role="status" aria-live="polite">
          <div className="app-toast__content">
            <p className="app-toast__eyebrow app-toast__eyebrow--info">
              {progress.title}
            </p>
            {/* `role="status"` above makes this card a polite live region, so
                the eyebrow announces each phase — which is what a screen
                reader user wants to hear. The percent, the bar and the byte
                meter change about once a second, and announcing every tick
                would bury the phase changes in "42%… 44%… 47%". They opt out;
                the progressbar keeps its value for anyone who asks for it. */}
            <p className="app-toast__message" aria-live="off">
              {progress.message}
            </p>
            <div
              className={`app-toast__track${
                progress.percent === undefined
                  ? " app-toast__track--indeterminate"
                  : ""
              }`}
              role="progressbar"
              aria-live="off"
              aria-label={progress.title}
              aria-valuemin={progress.percent === undefined ? undefined : 0}
              aria-valuemax={progress.percent === undefined ? undefined : 100}
              aria-valuenow={progress.percent}
            >
              <span
                style={
                  progress.percent === undefined
                    ? undefined
                    : { width: `${progress.percent}%` }
                }
              />
            </div>
            {progress.meter !== undefined && (
              <p className="app-toast__meter" aria-live="off">
                {progress.meter}
              </p>
            )}
          </div>
          {/* Rendered only when there is an action: `.app-toast` is a two
              column grid, and an empty second column still spends its gap. */}
          {progress.cancelable && (
            <div className="app-toast__actions">
              {/* aria-disabled, never `disabled` (styles/AGENTS.md): Chromium
                  blurs an element the moment it becomes disabled, which would
                  throw focus to <body> at the instant the user asked to
                  stop. The handler guards instead. */}
              <button
                className="app-toast__button"
                type="button"
                aria-disabled={canceling}
                onClick={() => {
                  if (canceling) return;
                  cancel();
                }}
              >
                {canceling ? "Canceling…" : "Cancel"}
              </button>
            </div>
          )}
        </aside>
      )}
      {offered && (
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
      )}
    </>
  );
}
