import { useRef, type ReactNode } from "react";
import type { Lens } from "@pwrgit/shared";
import { useViewportTooltip } from "../../lib/useViewportTooltip";
import { formatLensCount, LENSES, selectableLenses } from "./repo-view";
import { tablistKeyHandler } from "../../lib/tablistKeys";

/**
 * Icon-only lens switch, following PwrAgnt's #1425.
 *
 * The text version was a five-track grid whose own CSS note recorded that
 * "Pinned 13" cleared by ~0.5px at a 320px sidebar — it could not survive one
 * notch of the `--sidebar-title-size` axis, let alone a sixth lens. Icons
 * decouple the control from the type scale entirely.
 *
 * What the labels used to carry is preserved rather than dropped: the exact
 * count lives in each button's accessible name and tooltip, a dot marks the
 * lenses that currently have something in them (so "3 repos are behind" is
 * still glanceable without reading a number), and the active lens spells its
 * count out in the space the icons freed.
 */
const ICONS: Record<Lens, ReactNode> = {
  Focused: (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
    </>
  ),
  Pinned: <path d="M12 3l2.6 6 6.4.3-5 4.3 1.8 6.4L12 16.6 6.2 20l1.8-6.4-5-4.3 6.4-.3Z" />,
  Behind: (
    <>
      <path d="M12 4v11" />
      <path d="M7.5 10.5 12 15l4.5-4.5" />
      <path d="M5 20h14" />
    </>
  ),
  // An hourglass, not the archive box this used to draw. At 15px with a 1.7
  // stroke the lid-plus-body read as a trash can, which in a row of *filters*
  // promises a destructive action. Time-passing is the honest metaphor for
  // "old enough to prune", and the angular form doesn't collide with the round
  // clock two chips to the left.
  Stale: (
    <>
      <path d="M6 3h12" />
      <path d="M6 21h12" />
      <path d="M7.5 3v3.2L12 12l4.5-5.8V3" />
      <path d="M7.5 21v-3.2L12 12l4.5 5.8V21" />
    </>
  ),
  All: (
    <>
      <path d="M4 7h16" />
      <path d="M4 12h16" />
      <path d="M4 17h16" />
    </>
  )
};

/** What each lens answers, for the tooltip — an icon needs its noun spelled out. */
const DESCRIPTION: Record<Lens, string> = {
  Focused: "Current, pinned, viewed, changed, or committed in the last 30 days",
  Pinned: "Pinned repos — drag to arrange",
  Behind: "Repos with a worktree behind its upstream",
  Stale: "Repos with worktrees safe to prune",
  All: "Every indexed repo"
};

/**
 * What would put something in an empty lens, for the chip that can't be
 * entered. "Unavailable" is not an answer anybody can act on — and three of
 * these read as empty on a fresh scan for a reason the user has no way to
 * guess, which is that PwrGit hasn't looked at those repos yet.
 */
const WHEN_EMPTY: Record<Lens, string> = {
  Focused: "Nothing here yet. Open or pin a repo and it lands in Focused.",
  Pinned: "Nothing pinned yet. Star a repo to keep it here.",
  Behind: "Nothing here yet. PwrGit compares a repo with its upstream once you open its row.",
  Stale: "Nothing here yet. PwrGit works out what's prunable once you open a repo's row.",
  // All is never unavailable — it is the lens everything else falls back to.
  All: ""
};

export function LensFilter({
  lens,
  counts,
  onChange,
  controlsId
}: {
  lens: Lens;
  counts: Record<Lens, number>;
  onChange: (lens: Lens) => void;
  /** The repo tree these tabs filter, for `aria-controls`. */
  controlsId: string;
}) {
  const activeCount = counts[lens];
  // An in-app tooltip, not `title`. These five icons are the only label the
  // control has, so the explanation cannot be left to a native tooltip that a
  // dimmed chip would not show at all — a `disabled` button receives no
  // pointer events, so the one chip most in need of explaining itself would be
  // the one that stayed silent. This is the same primitive the repo rows use.
  const tip = useViewportTooltip();
  // role="tablist" promises one Tab stop with the arrows moving inside it.
  // Every chip used to be its own stop and the arrows did nothing, so reaching
  // the repo list from the sidebar search meant tabbing past all six.
  const chipRefs = useRef<Partial<Record<Lens, HTMLButtonElement>>>({});
  // Arrows travel over the lenses that can be entered, so the strip never
  // selects its way into a view that is empty by construction.
  const reachable = selectableLenses(counts, lens);
  const onKeyDown = tablistKeyHandler(reachable, lens, (next) => {
    onChange(next);
    chipRefs.current[next]?.focus();
  });
  return (
    <div
      className="lens-filter"
      role="tablist"
      aria-label="Repo filter"
      onKeyDown={onKeyDown}
    >
      {LENSES.map((l) => {
        const count = counts[l];
        const label = count > 0 ? `${l} (${count})` : l;
        const available = reachable.includes(l);
        const tooltip = `${label}\n${available ? DESCRIPTION[l] : WHEN_EMPTY[l]}`;
        return (
          <button
            key={l}
            type="button"
            role="tab"
            ref={(element) => {
              if (element === null) delete chipRefs.current[l];
              else chipRefs.current[l] = element;
            }}
            // Roving tab stop: the strip is one stop, arrows move within it.
            tabIndex={l === lens ? 0 : -1}
            aria-selected={l === lens}
            aria-controls={controlsId}
            aria-label={label}
            // aria-disabled rather than `disabled`, so the chip keeps its
            // hover and its tooltip: "why is this one grey" is exactly the
            // question it has to be able to answer.
            aria-disabled={available ? undefined : true}
            className={`lens-chip${l === lens ? " is-active" : ""}${
              available ? "" : " is-empty"
            }`}
            onMouseEnter={(e) => tip.show(e.currentTarget, tooltip)}
            onMouseLeave={tip.hide}
            onFocus={(e) => tip.show(e.currentTarget, tooltip)}
            onBlur={tip.hide}
            onClick={() => {
              if (!available) return;
              tip.hide();
              onChange(l);
            }}
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              {ICONS[l]}
            </svg>
            {/* Presence, not quantity — the number is in the accessible name. */}
            {count > 0 && <span className="lens-chip__dot" aria-hidden="true" />}
          </button>
        );
      })}
      {/* Decorative here, and deliberately so: a `tablist` may only own tabs,
          and this count is already in the active tab's own accessible name
          ("Pinned (14)"), so exposing it a second time would both break the
          role structure and read the same number twice. */}
      {activeCount > 0 && (
        <span
          className="lens-filter__count"
          aria-hidden="true"
          title={
            formatLensCount(activeCount) === String(activeCount)
              ? undefined
              : `${activeCount}`
          }
        >
          {formatLensCount(activeCount)}
        </span>
      )}
      {tip.tooltipNode}
    </div>
  );
}
