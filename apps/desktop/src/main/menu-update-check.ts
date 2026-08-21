import { dialog, type MessageBoxOptions } from "electron";
import type { AppUpdateCheckResult } from "@pwrgit/shared";
import { checkForAppUpdatesNow } from "./auto-updater";
import { logMain } from "./logs";

export function appUpdateCheckDialogOptions(
  result: AppUpdateCheckResult
): MessageBoxOptions {
  const common: Pick<
    MessageBoxOptions,
    "buttons" | "defaultId" | "title"
  > = {
    buttons: ["OK"],
    defaultId: 0,
    title: "PwrGit Updates"
  };

  if (result.status === "skipped") {
    return {
      ...common,
      type: "info",
      message: "Updates are unavailable",
      detail: result.reason
    };
  }
  if (result.status === "error") {
    return {
      ...common,
      type: "error",
      message: "Unable to check for updates",
      detail: result.message
    };
  }
  if (result.status === "checking") {
    return {
      ...common,
      type: "info",
      message: "Checking for updates…"
    };
  }
  if (result.status === "no-update") {
    return {
      ...common,
      type: "info",
      message: "PwrGit is up to date",
      detail: `You’re running v${result.version}.`
    };
  }
  if (result.status === "downloaded") {
    return {
      ...common,
      type: "info",
      message: "Update ready to install",
      detail: `PwrGit v${result.version} is ready. Open Settings → Updates to restart and install.`
    };
  }
  return {
    ...common,
    type: "info",
    message: "Update available",
    detail: `PwrGit v${result.version} is downloading in the background.`
  };
}

export async function checkForAppUpdatesFromMenu(): Promise<void> {
  let result: AppUpdateCheckResult;
  try {
    result = await checkForAppUpdatesNow("menu");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logMain("warn", "updater", "menu update check failed", message);
    result = { status: "error", message };
  }

  try {
    await dialog.showMessageBox(appUpdateCheckDialogOptions(result));
  } catch (err) {
    logMain(
      "warn",
      "updater",
      "failed to show menu update result",
      err instanceof Error ? err.message : String(err)
    );
  }
}
