import type { AppSettings } from "./settings/settings-service";

const KEYCHAIN_PROBE_TEXT = "PwrGit macOS keychain access check";

type SettingsStore = {
  get: () => AppSettings;
  update: (patch: Partial<AppSettings>) => AppSettings;
};

export type KeychainMessageBoxOptions = {
  type: "info" | "warning";
  title: string;
  message: string;
  detail: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
  noLink: boolean;
};

type MacKeychainAccessOptions = {
  platform: NodeJS.Platform;
  packaged: boolean;
  settings: SettingsStore;
  showMessageBox: (
    options: KeychainMessageBoxOptions
  ) => Promise<{ response: number }>;
  encryptString: (plainText: string) => Buffer;
  onAccessDenied?: () => void;
};

const INTRO_DIALOG: KeychainMessageBoxOptions = {
  type: "info",
  title: "A quick note about macOS Keychain",
  message: "PwrGit is about to ask for Keychain access",
  detail:
    "PwrGit uses its private “PwrGit Safe Storage” key to encrypt local app data, including browser cookies. The macOS request is for that PwrGit key—not permission to browse your passwords or other keychain items.\n\n" +
    "PwrGit needs to read the key whenever it starts. In the macOS prompt, enter your Mac login password and choose Always Allow to prevent this prompt on future launches.",
  buttons: ["Continue", "Quit PwrGit"],
  defaultId: 0,
  cancelId: 1,
  noLink: true
};

const DENIED_DIALOG: KeychainMessageBoxOptions = {
  type: "warning",
  title: "Keychain access is required",
  message: "PwrGit could not access its Safe Storage key",
  detail:
    "Without that key, PwrGit cannot safely open its local browser session. No other passwords or keychain items were requested.\n\n" +
    "Choose Try Again, then enter your Mac login password and select Always Allow in the macOS prompt.",
  buttons: ["Try Again", "Quit PwrGit"],
  defaultId: 0,
  cancelId: 1,
  noLink: true
};

/**
 * Explain Electron's macOS Safe Storage prompt before Chromium can trigger it,
 * then prove that the app can still read the same key. Returning false means
 * startup must stop before creating a BrowserWindow.
 */
export async function ensureMacKeychainAccess(
  options: MacKeychainAccessOptions
): Promise<boolean> {
  if (options.platform !== "darwin" || !options.packaged) return true;

  if (options.settings.get().macKeychainAccessExplained !== true) {
    const { response } = await options.showMessageBox(INTRO_DIALOG);
    if (response !== INTRO_DIALOG.defaultId) return false;
  }

  for (;;) {
    try {
      // A throw here is the only reliable signal Electron exposes when the
      // user denies access. The ciphertext is intentionally not persisted;
      // requesting it simply proves that Safe Storage can read its app key.
      options.encryptString(KEYCHAIN_PROBE_TEXT);
      options.settings.update({ macKeychainAccessExplained: true });
      return true;
    } catch {
      // A denial must cause the full explanation to return on the next launch,
      // even if the user quits instead of retrying now.
      options.settings.update({ macKeychainAccessExplained: false });
      options.onAccessDenied?.();
      const { response } = await options.showMessageBox(DENIED_DIALOG);
      if (response !== DENIED_DIALOG.defaultId) return false;
    }
  }
}
