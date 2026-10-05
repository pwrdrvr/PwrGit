/**
 * Keyboard and pointer model for the refs browser's rows (Branches, Pull
 * requests, Tags, and each remote's branches on Remotes).
 *
 * A row is a focus stop of its own (`data-refs-row`, `tabIndex={-1}`), so the
 * list is reachable the way the sidebar's is: Tab into the filter, ↓ into the
 * first row, ↑/↓ between rows, Home/End to the ends, ↑ off the first back to
 * the filter. On a row, Space pins the branch and Enter runs the row's primary
 * action; double-click runs that same action, as it does on a sidebar row.
 * Tab from a row still walks its own buttons.
 *
 * The primary action is whichever button sits inside `data-refs-primary` —
 * `RefRowActions`' first slot, which every one of those rows draws.
 *
 * Space cannot pin from the filter field: there it types a space, and a branch
 * filter has no reason to swallow one. The row is where the key is free.
 */

const ROW = "[data-refs-row]";

/**
 * A double-click on one of these is that control's own gesture, not the row's.
 * A `CopyTarget` that defers its copy (`deferForDoubleClick`, which stamps
 * `data-defers-double-click`) is left out on purpose: it is the row's name, the
 * widest target on it, and its copy waits for the second click so a
 * double-click activates the row without touching the clipboard — as the
 * sidebar's branch name does. One that copies at once stays its own gesture.
 */
const OWN_GESTURE =
  'button, a[href], input, select, textarea, [role="button"]:not([data-defers-double-click]), [role="menuitem"]';

/** The row's primary action, or null when it has none or it is unavailable. */
function primaryAction(row: HTMLElement): HTMLButtonElement | null {
  const primary = row.querySelector<HTMLButtonElement>(
    "[data-refs-primary] button:not(:disabled)"
  );
  if (primary === null || primary.getAttribute("aria-disabled") === "true") {
    return null;
  }
  return primary;
}

function rows(scope: HTMLElement): HTMLElement[] {
  return Array.from(scope.querySelectorAll<HTMLElement>(ROW));
}

/** ↓ in the filter field: focus the first row. Returns whether one took it. */
export function focusFirstRefsRow(scope: HTMLElement | null): boolean {
  const first = scope === null ? undefined : rows(scope)[0];
  if (first === undefined) return false;
  first.focus();
  return true;
}

/**
 * Keydown delegated from the rows' container. Acts only on a keystroke aimed at
 * the row itself — the buttons inside keep their own activation (SC 2.1.1).
 */
export function handleRefsRowKey(
  event: {
    key: string;
    target: EventTarget;
    currentTarget: EventTarget;
    preventDefault: () => void;
  },
  scope: HTMLElement,
  backToFilter: () => void
): void {
  const row = event.target as HTMLElement;
  if (!row.matches?.(ROW)) return;
  const all = rows(scope);
  const index = all.indexOf(row);
  if (index === -1) return;
  if (event.key === "ArrowDown") {
    event.preventDefault();
    all[Math.min(index + 1, all.length - 1)]?.focus();
  } else if (event.key === "Home") {
    event.preventDefault();
    all[0]?.focus();
  } else if (event.key === "End") {
    event.preventDefault();
    all.at(-1)?.focus();
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    if (index === 0) backToFilter();
    else all[index - 1]?.focus();
  } else if (event.key === " ") {
    // Only rows that can be pinned carry the control.
    const pin = row.querySelector<HTMLButtonElement>("[data-refs-pin]");
    if (pin === null) return;
    event.preventDefault();
    pin.click();
  } else if (event.key === "Enter") {
    if (row.querySelector("[data-refs-primary] button:not(:disabled)") === null) {
      return;
    }
    // Taken even when the action is busy, so Enter cannot fall through to
    // anything else while it runs.
    event.preventDefault();
    primaryAction(row)?.click();
  }
}

/**
 * Double-click delegated from the rows' container: run the primary action
 * Enter runs. A double-click on a control inside the row stays that control's.
 */
export function handleRefsRowDoubleClick(
  event: { target: EventTarget },
  scope: HTMLElement
): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const row = target.closest<HTMLElement>(ROW);
  if (row === null || !scope.contains(row)) return;
  const control = target.closest(OWN_GESTURE);
  if (control !== null && row.contains(control)) return;
  primaryAction(row)?.click();
}
