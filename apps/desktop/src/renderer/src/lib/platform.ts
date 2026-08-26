/** Renderer platform helpers. The preload bridge is authoritative: Chromium's
 *  navigator fields can be reduced or report compatibility values. */
export function currentPlatform(): string {
  return typeof window === "undefined" ? "linux" : window.pwrgit.platform;
}

export function isMacPlatform(platform: string = currentPlatform()): boolean {
  return platform === "darwin";
}

export type Shortcut = {
  key: string;
  alt?: boolean;
  shift?: boolean;
};

const KEY_GLYPHS: Readonly<Record<string, string>> = {
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  Enter: "↵"
};

/** Format a primary-modifier shortcut as compact macOS glyphs or a readable
 *  Ctrl chord everywhere else. */
export function shortcutLabel(
  shortcut: Shortcut,
  platform: string = currentPlatform()
): string {
  const key = KEY_GLYPHS[shortcut.key] ?? shortcut.key;
  if (isMacPlatform(platform)) {
    return `${shortcut.alt === true ? "⌥" : ""}${
      shortcut.shift === true ? "⇧" : ""
    }⌘${key}`;
  }
  return [
    "Ctrl",
    ...(shortcut.alt === true ? ["Alt"] : []),
    ...(shortcut.shift === true ? ["Shift"] : []),
    key
  ].join("+");
}

/** Whether an event carries the primary modifier advertised for this OS. */
export function hasPrimaryModifier(
  event: { metaKey: boolean; ctrlKey: boolean },
  platform: string = currentPlatform()
): boolean {
  return isMacPlatform(platform) ? event.metaKey : event.ctrlKey;
}

/** Native wording for revealing a path in the platform file manager. */
export function revealPathLabel(platform: string = currentPlatform()): string {
  if (isMacPlatform(platform)) return "Reveal in Finder";
  if (platform === "win32") return "Show in Explorer";
  return "Show in folder";
}

/** A path's final non-empty segment, accepting POSIX, drive-letter, mixed, and
 *  UNC input regardless of the machine rendering it. */
export function pathLeaf(path: string): string {
  return path.split(/[\\/]+/).filter(Boolean).pop() ?? path;
}

/** Compact path label using the target platform's separator. Normalizing the
 *  input first keeps Git's C:/... output and native C:\\... / UNC paths equal. */
export function pathTail(
  path: string,
  segmentCount = 2,
  platform: string = currentPlatform()
): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  if (segmentCount <= 0) return "";
  const separator = platform === "win32" ? "\\" : "/";
  return parts.slice(-segmentCount).join(separator);
}

/** Join a child name for display using the same separator semantics as the
 * target platform's `path.join()`. A backslash is an ordinary filename
 * character on POSIX, so path contents cannot safely identify the platform. */
export function joinDisplayPath(
  parent: string,
  child: string,
  platform: string = currentPlatform()
): string {
  if (platform === "win32") {
    const normalizedParent = parent.replaceAll("/", "\\").replace(/\\+$/, "");
    return `${normalizedParent}\\${child}`;
  }
  return `${parent.replace(/\/+$/, "")}/${child}`;
}
