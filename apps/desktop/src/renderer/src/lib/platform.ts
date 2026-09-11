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

/** A path's non-empty segments, accepting POSIX, drive-letter, mixed, and UNC
 *  input regardless of the machine rendering it. Runs of separators collapse,
 *  so callers that rebuild a path from these do not reproduce them. */
function pathSegments(path: string): string[] {
  return path.split(/[\\/]+/).filter(Boolean);
}

/** A path's final non-empty segment. */
export function pathLeaf(path: string): string {
  return pathSegments(path).pop() ?? path;
}

/** Compact path label using the target platform's separator. Normalizing the
 *  input first keeps Git's C:/... output and native C:\\... / UNC paths equal. */
export function pathTail(
  path: string,
  segmentCount = 2,
  platform: string = currentPlatform()
): string {
  const parts = pathSegments(path);
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

/** Widest a path may be before `elidePathMiddle` starts dropping segments. A
 *  native tooltip is one line that does not wrap until it is very wide, so a
 *  full worktree path spills out of the 320px sidebar and across the pane
 *  beside it. */
const PATH_TOOLTIP_MAX_CHARS = 48;

/** How much width an elision has to buy before it is worth a hidden name. */
const MIN_ELISION_SAVING_CHARS = 8;

/**
 * Drop whole segments from the middle of a path so a tooltip stays a readable
 * width, keeping the root and as many trailing segments as fit.
 *
 * On the paths this is for — `<worktree root>/<repo>/<folder>` — that leaves
 * the two names that identify a checkout and drops the home directory, which
 * is the same on every row and is what made the string long. A deeper path
 * keeps its deepest segments instead; nothing here decides that one segment
 * matters more than another.
 *
 * Whole segments only, and only when the "…" earns its place: it must stand
 * for at least one real segment and buy real width, so a path with no
 * droppable middle — or one that only just overflows — comes back untouched
 * rather than trading a name for a character.
 *
 * For display only: it collapses runs of separators and drops a trailing one,
 * and the exact path stays one "Copy path" away in the row's ⋯ menu.
 */
export function elidePathMiddle(
  path: string,
  maxChars: number = PATH_TOOLTIP_MAX_CHARS
): string {
  if (path.length <= maxChars) return path;
  const segments = pathSegments(path);
  // Fewer than three and there is no middle: the root and the leaf are it.
  if (segments.length < 3) return path;
  // Kept verbatim so a UNC path stays a UNC path ("\\\\server\\share"). The
  // fallbacks are what satisfy `exec`'s nullable return: both patterns match
  // every string that reaches here. A drive letter has no prefix but still
  // has separators, so the two are read independently — the path's own
  // separator, never the platform's, since mixing them in one string invents
  // a shape neither OS writes.
  const prefix = /^[\\/]*/.exec(path)?.[0] ?? "";
  const separator = /[\\/]/.exec(path)?.[0] ?? "/";
  const head = `${prefix}${segments[0]}`;
  const assemble = (tail: string[]): string =>
    [head, "…", ...tail].join(separator);
  let tail = segments.slice(-1);
  for (let i = segments.length - 2; i > 0; i--) {
    const wider = [segments[i], ...tail];
    if (assemble(wider).length > maxChars) break;
    tail = wider;
  }
  // The "…" has to be standing in for something. Runs of separators collapse
  // in `pathSegments`, so a path can be over budget on width the segments do
  // not account for and reach here with every one of them still in hand — an
  // ellipsis there would claim a name had been hidden when none was.
  if (tail.length + 1 >= segments.length) return path;
  const elided = assemble(tail);
  // A "…" standing in for one short segment is no narrower than the segment
  // was: it would hide a real folder name and buy nothing. A path that only
  // just overflows keeps every name it has.
  return path.length - elided.length >= MIN_ELISION_SAVING_CHARS
    ? elided
    : path;
}
