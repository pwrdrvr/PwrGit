import { join } from "node:path";

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
 */
export function linuxWindowIconPath(env: {
  platform: NodeJS.Platform;
  packaged: boolean;
  appPath: string;
  resourcesPath: string;
}): string | null {
  if (env.platform !== "linux") return null;
  return env.packaged
    ? join(env.resourcesPath, "icon.png")
    : join(env.appPath, "build", "icon.png");
}
