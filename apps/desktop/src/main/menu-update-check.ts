import type { AppUpdateCheckResult } from "@pwrgit/shared";
import { checkForAppUpdatesNow } from "./auto-updater";
import { emitEvent } from "./ipc";
import { logMain } from "./logs";

/**
 * Help → Check for Updates.
 *
 * The outcome goes to the windows as an event, not to a modal dialog. A modal
 * is the wrong shape twice over: "you're up to date" is not worth a box the
 * user has to dismiss, and a downloaded update is *actionable* — the toast
 * that reports it carries the Restart button, where the dialog could only
 * spell out a route to Settings. PwrSnap and PwrAgnt already answer a menu
 * check this way; PwrGit was the odd one out.
 *
 * The `checking` tick goes out first so the click has an immediate answer —
 * a release read can take a second, and a download rather longer. The
 * renderer replaces that toast in place with the result.
 */
export async function checkForAppUpdatesFromMenu(): Promise<void> {
  report({ status: "checking" });
  let result: AppUpdateCheckResult;
  try {
    result = await checkForAppUpdatesNow("menu");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logMain("warn", "updater", "menu update check failed", message);
    result = { status: "error", message };
  }
  report(result);
}

/** The only caller invokes this whole flow as `void`, and main has no
 *  process-level rejection handler — a window destroyed mid-broadcast must
 *  cost the user a toast, not an unhandled rejection with nothing logged. */
function report(result: AppUpdateCheckResult): void {
  try {
    emitEvent("app:updateCheckResult", result);
  } catch (err) {
    logMain(
      "warn",
      "updater",
      "failed to report menu update result",
      err instanceof Error ? err.message : String(err)
    );
  }
}
