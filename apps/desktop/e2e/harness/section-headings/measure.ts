/**
 * What "a heading fits" means, measured the way the pixels are drawn.
 *
 * Truncation is never read from `scrollWidth`: it is a whole number, and
 * Chromium ellipsizes text a fraction of a pixel too wide while both widths
 * read the same. Each text is laid out again off-screen in its own computed
 * font, and that natural width is compared with the box it was given.
 */

let probe: HTMLSpanElement | null = null;

/** The width `el`'s text takes when nothing constrains it. */
export function naturalTextWidth(el: Element): number {
  if (probe === null) {
    probe = document.createElement("span");
    probe.setAttribute("aria-hidden", "true");
    Object.assign(probe.style, {
      position: "fixed",
      left: "-10000px",
      top: "0",
      visibility: "hidden",
      whiteSpace: "pre",
      padding: "0",
      border: "0"
    });
    document.body.append(probe);
  }
  const style = getComputedStyle(el);
  Object.assign(probe.style, {
    font: style.font,
    letterSpacing: style.letterSpacing,
    wordSpacing: style.wordSpacing,
    textTransform: style.textTransform,
    fontKerning: style.fontKerning,
    fontFeatureSettings: style.fontFeatureSettings,
    fontVariantNumeric: style.fontVariantNumeric
  });
  probe.textContent = textOf(el);
  return probe.getBoundingClientRect().width;
}

/** An element's own text, not its descendants' (a chip holds only text). */
function textOf(el: Element): string {
  return [...el.childNodes]
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent ?? "")
    .join("");
}

function contentWidth(el: Element): number {
  const style = getComputedStyle(el);
  return (
    el.getBoundingClientRect().width -
    (parseFloat(style.paddingLeft) || 0) -
    (parseFloat(style.paddingRight) || 0) -
    (parseFloat(style.borderLeftWidth) || 0) -
    (parseFloat(style.borderRightWidth) || 0)
  );
}

function contentRight(el: Element): number {
  const style = getComputedStyle(el);
  return (
    el.getBoundingClientRect().right -
    (parseFloat(style.paddingRight) || 0) -
    (parseFloat(style.borderRightWidth) || 0)
  );
}

/** On screen: laid out, and not the visually-hidden 1px clip. */
function shown(el: Element): boolean {
  if (el.getClientRects().length === 0) return false;
  const style = getComputedStyle(el);
  if (style.visibility === "hidden") return false;
  if (style.clipPath === "inset(50%)") return false;
  if (el.closest(".a11y-sr-only") !== null) return false;
  // Inside a visually hidden label (the stepped-away words).
  for (let up = el.parentElement; up !== null; up = up.parentElement) {
    if (getComputedStyle(up).clipPath === "inset(50%)") return false;
  }
  return true;
}

/** Elements that draw text of their own. */
function textLeaves(root: Element): Element[] {
  return [root, ...root.querySelectorAll("*")].filter(
    (el) => textOf(el).trim() !== "" && shown(el)
  );
}

/** How many line boxes `el`'s own text occupies. */
function lineCount(el: Element): number {
  const tops = new Set<number>();
  for (const node of el.childNodes) {
    if (node.nodeType !== Node.TEXT_NODE || (node.textContent ?? "").trim() === "") {
      continue;
    }
    const range = document.createRange();
    range.selectNodeContents(node);
    for (const rect of range.getClientRects()) tops.add(Math.round(rect.top));
  }
  return tops.size;
}

/** The boxes laid side by side in a row: its items and the disclosure's. */
function rowItems(row: Element): Element[] {
  const items: Element[] = [];
  for (const child of row.children) {
    if (!shown(child)) continue;
    if (
      child.matches(".ref-section__head, .wt-section__toggle, .ref-section__chips")
    ) {
      for (const inner of child.children) if (shown(inner)) items.push(inner);
    } else {
      items.push(child);
    }
  }
  return items;
}

const describe = (el: Element): string =>
  `${el.className || el.tagName.toLowerCase()} "${(el.textContent ?? "").trim()}"`;

/** Everything wrong with one heading row; empty when it fits. */
export function headingRowProblems(row: HTMLElement): string[] {
  const problems: string[] = [];
  const right = contentRight(row);
  const items = rowItems(row).sort(
    (a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left
  );
  for (let i = 1; i < items.length; i++) {
    const prev = items[i - 1]!.getBoundingClientRect();
    const next = items[i]!.getBoundingClientRect();
    // A zero-width item (the spacer) cannot overlap anything.
    if (prev.width === 0 || next.width === 0) continue;
    if (next.left < prev.right - 0.5) {
      problems.push(
        `overlap: ${describe(items[i]!)} starts ${(prev.right - next.left).toFixed(1)}px inside ${describe(items[i - 1]!)}`
      );
    }
  }
  for (const leaf of textLeaves(row)) {
    // "on main" is the one leftover item; it may ellipsize, then leave.
    if (leaf.closest(".ref-section__on") !== null) continue;
    if (lineCount(leaf) > 1) problems.push(`wrapped: ${describe(leaf)}`);
    const natural = naturalTextWidth(leaf);
    const box = contentWidth(leaf);
    if (natural > box + 0.01) {
      problems.push(
        `cut: ${describe(leaf)} needs ${natural.toFixed(2)}px, has ${box.toFixed(2)}px`
      );
    }
    const overshoot = leaf.getBoundingClientRect().right - right;
    if (overshoot > 0.5) {
      problems.push(`clipped: ${describe(leaf)} runs ${overshoot.toFixed(1)}px past the row`);
    }
  }
  return problems;
}

/** The repository row: the name may be cut only after both steps. */
export function repoRowProblems(row: HTMLElement): string[] {
  const problems: string[] = [];
  const name = row.querySelector<HTMLElement>(".repo-row__name");
  if (name !== null) {
    const cut = naturalTextWidth(name) > contentWidth(name) + 0.01;
    const stepped =
      row.classList.contains("rr-no-marks") && row.classList.contains("rr-short-count");
    if (cut && !stepped) problems.push(`name cut before both row steps: ${row.className}`);
  }
  const star = row.querySelector(".pin");
  if (star === null || !shown(star)) problems.push("the star left the row");
  const right = contentRight(row);
  for (const leaf of textLeaves(row)) {
    if (leaf.matches(".repo-row__name")) continue;
    if (lineCount(leaf) > 1) problems.push(`wrapped: ${describe(leaf)}`);
    if (naturalTextWidth(leaf) > contentWidth(leaf) + 0.01) {
      problems.push(`cut: ${describe(leaf)}`);
    }
    if (leaf.getBoundingClientRect().right > right + 0.5) {
      problems.push(`clipped: ${describe(leaf)}`);
    }
  }
  return problems;
}
