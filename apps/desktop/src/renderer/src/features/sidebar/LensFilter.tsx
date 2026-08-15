import type { ReactNode } from "react";
import type { Lens } from "@pwrgit/shared";
import { formatLensCount, LENSES } from "./repo-view";

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
  Recent: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
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
  Stale: (
    <>
      <path d="M4 7h16v3H4z" />
      <path d="M6 10v9h12v-9" />
      <path d="M10 14h4" />
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
  Recent: "Recently active repos",
  Pinned: "Pinned repos — drag to arrange",
  Behind: "Repos with a worktree behind its upstream",
  Stale: "Repos with worktrees safe to prune",
  All: "Every indexed repo"
};

export function LensFilter({
  lens,
  counts,
  onChange
}: {
  lens: Lens;
  counts: Record<Lens, number>;
  onChange: (lens: Lens) => void;
}) {
  const activeCount = counts[lens];
  return (
    <div className="lens-filter" role="tablist" aria-label="Repo filter">
      {LENSES.map((l) => {
        const count = counts[l];
        const label = count > 0 ? `${l} (${count})` : l;
        return (
          <button
            key={l}
            type="button"
            role="tab"
            aria-selected={l === lens}
            aria-label={label}
            title={`${label} — ${DESCRIPTION[l]}`}
            className={`lens-chip${l === lens ? " is-active" : ""}`}
            onClick={() => onChange(l)}
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
            {/* Presence, not quantity — the number is in the accessible name.
                Recent is always 0 by design (it's the default view, not a
                filtered set), so it never carries a dot. */}
            {count > 0 && <span className="lens-chip__dot" aria-hidden="true" />}
          </button>
        );
      })}
      {activeCount > 0 && (
        <span
          className="lens-filter__count"
          title={
            formatLensCount(activeCount) === String(activeCount)
              ? undefined
              : `${activeCount}`
          }
        >
          {formatLensCount(activeCount)}
        </span>
      )}
    </div>
  );
}
