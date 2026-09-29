/**
 * Keyboard model for the refs browser's rows (Branches, Pull requests, Tags).
 *
 * A row is a focus stop of its own (`data-refs-row`, `tabIndex={-1}`), so the
 * list is reachable the way the sidebar's is: Tab into the filter, ↓ into the
 * first row, ↑/↓ between rows, ↑ off the first back to the filter. On a row,
 * Space pins the branch and Enter runs the row's primary action — the two verbs
 * that were mouse-only. Tab from a row still walks its own buttons.
 *
 * Space cannot pin from the filter field: there it types a space, and a branch
 * filter has no reason to swallow one. The row is where the key is free.
 */

const ROW = "[data-refs-row]";

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
    const primary = row.querySelector<HTMLButtonElement>(
      ".refs-row-slot--primary button:not(:disabled)"
    );
    if (primary === null) return;
    event.preventDefault();
    if (primary.getAttribute("aria-disabled") !== "true") primary.click();
  }
}
