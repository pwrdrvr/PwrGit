// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Lens } from "@pwrgit/shared";
import { LensFilter } from "./LensFilter";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** The first-run shape: repos indexed, no per-repo state computed yet. */
const FRESH_SCAN: Record<Lens, number> = {
  Focused: 0,
  Pinned: 0,
  Behind: 0,
  Stale: 0,
  All: 120
};

function render(
  counts: Record<Lens, number>,
  lens: Lens,
  onChange: (next: Lens) => void = () => undefined
): void {
  act(() => {
    root.render(
      <LensFilter
        lens={lens}
        counts={counts}
        onChange={onChange}
        controlsId="tree"
      />
    );
  });
}

const chip = (lens: Lens): HTMLButtonElement => {
  const el = container.querySelector<HTMLButtonElement>(
    `[role="tab"][aria-label^="${lens}"]`
  );
  if (el === null) throw new Error(`no chip for ${lens}`);
  return el;
};

describe("LensFilter", () => {
  it("dims every lens a fresh scan cannot fill, and leaves All alone", () => {
    render(FRESH_SCAN, "All");
    for (const lens of ["Focused", "Pinned", "Behind", "Stale"] as Lens[]) {
      expect(chip(lens).getAttribute("aria-disabled"), lens).toBe("true");
      expect(chip(lens).className, lens).toContain("is-empty");
    }
    expect(chip("All").getAttribute("aria-disabled")).toBeNull();
    expect(chip("All").className).not.toContain("is-empty");
  });

  it("will not switch into a lens that has nothing in it", () => {
    const onChange = vi.fn();
    render(FRESH_SCAN, "All", onChange);
    act(() => chip("Behind").click());
    expect(onChange).not.toHaveBeenCalled();

    // …and still switches into one that does.
    render({ ...FRESH_SCAN, Pinned: 2, Focused: 2 }, "All", onChange);
    act(() => chip("Pinned").click());
    expect(onChange).toHaveBeenCalledWith("Pinned");
  });

  it("the lens you are standing in stays live after it empties", () => {
    const onChange = vi.fn();
    // Unpinning the last repo empties Pinned under the user's own focus.
    render(FRESH_SCAN, "Pinned", onChange);
    expect(chip("Pinned").getAttribute("aria-disabled")).toBeNull();
    expect(chip("Pinned").tabIndex).toBe(0);
    act(() => chip("Pinned").click());
    expect(onChange).toHaveBeenCalledWith("Pinned");
  });

  it("arrows skip the lenses that cannot be entered", () => {
    const onChange = vi.fn();
    render({ ...FRESH_SCAN, Stale: 3 }, "All", onChange);
    act(() => {
      chip("All").dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })
      );
    });
    // Right from the last chip wraps to the first one worth landing on —
    // Stale, not the empty Focused that leads the strip.
    expect(onChange).toHaveBeenCalledWith("Stale");
  });

  it("every chip explains itself, dimmed ones included", () => {
    render(FRESH_SCAN, "All");
    // An icon-only control with no label of its own: a chip nobody can read
    // is the whole reason this tooltip exists, and the dimmed chip — the one
    // that owes an explanation — must not be the one that stays silent.
    act(() => chip("All").focus());
    expect(document.body.textContent).toContain("Every indexed repo");

    act(() => chip("Stale").focus());
    expect(document.body.textContent).toContain("Nothing here yet");
    expect(document.body.textContent).toContain("prunable");
  });
});
