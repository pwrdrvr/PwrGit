import { dialog, shell } from "electron";
import { err, ok, pwrGitError, type Result } from "@pwrgit/shared";
import { logMain } from "./logs";

export function isSafeExternalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

/** One safe, awaited boundary for every renderer- and menu-originated link. */
export async function openExternalUrl(
  url: string,
  open: (target: string) => Promise<void> = (target) => shell.openExternal(target)
): Promise<Result<null>> {
  if (!isSafeExternalUrl(url)) {
    return err(
      pwrGitError(
        "validation",
        "invalid_external_url",
        "PwrGit can only open HTTP or HTTPS links without embedded credentials."
      )
    );
  }

  try {
    await open(url);
    return ok(null);
  } catch (cause) {
    return err(
      pwrGitError(
        "unknown",
        "external_open_failed",
        "Unable to open the link in your default browser. Check your connection or copy the address and try again.",
        cause
      )
    );
  }
}

/** Native menus have no renderer to paint an error, so failures get a dialog. */
export async function openExternalUrlFromMenu(
  label: string,
  url: string
): Promise<void> {
  const result = await openExternalUrl(url);
  if (result.ok) return;

  logMain(
    "warn",
    "external-link",
    `failed to open ${label}:`,
    result.error.message,
    url
  );
  try {
    await dialog.showMessageBox({
      type: "error",
      buttons: ["OK"],
      defaultId: 0,
      title: "PwrGit Help",
      message: `Unable to open ${label}`,
      detail: `${result.error.message}\n\n${url}`
    });
  } catch (cause) {
    logMain("warn", "external-link", "failed to show link error", cause);
  }
}
