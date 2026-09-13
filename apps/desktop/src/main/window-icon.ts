import { posix } from "node:path";

/**
 * Where the icon a Linux window has to carry lives, or `null` on a platform
 * that does not need one handed to it.
 *
 * macOS reads the bundle's icon and Windows the executable's, but a Linux
 * desktop identifies a window by its WM_CLASS and takes the icon from the
 * matching installed `.desktop` file. A `pnpm dev` run is Electron's own
 * binary with no `.desktop` file installed, so nothing matches and the shell
 * falls back to its generic application tile — the gear Ubuntu shows in the
 * dock. Giving the window the icon directly (X11 `_NET_WM_ICON`) gives the
 * shell something to draw whether or not the app is installed.
 *
 * Packaged builds read it back out of `resources/`, where
 * `electron-builder.yml` stages the same master PNG the `.deb` installs into
 * the icon theme.
 *
 * Joined with `posix`, not `join`: this is a Linux path on every platform that
 * gets one, and the host separator is only the right answer by accident —
 * a Windows test runner computing the same Linux path got backslashes.
 */
export function linuxWindowIconPath(env: {
  platform: NodeJS.Platform;
  packaged: boolean;
  appPath: string;
  resourcesPath: string;
}): string | null {
  if (env.platform !== "linux") return null;
  return env.packaged
    ? posix.join(env.resourcesPath, "icon.png")
    : posix.join(env.appPath, "build", "icon.png");
}
