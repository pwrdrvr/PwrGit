import { useRef, useState, type ReactNode } from "react";
import { ContextMenu, type MenuItem } from "../shell/ContextMenu";
import { hoverTooltip, useViewportTooltip } from "../../lib/useViewportTooltip";

/**
 * The `⋮` at the end of every refs row (Branches, Pull requests, Tags): the
 * verbs that are not the row's one or two everyday actions. It is the same
 * kebab the sidebar rows use, opening the house `ContextMenu` back over the row
 * (`align="end"`) rather than out across the pane.
 *
 * `label` names the row ("Actions for main"), because a screen reader arrowing
 * a column of identical kebabs otherwise hears the same word forty times.
 */
export function RefRowMenu({
  label,
  items
}: {
  label: string;
  items: MenuItem[];
}) {
  const tip = useViewportTooltip();
  const btnRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  return (
    <>
      <button
        ref={btnRef}
        className="kebab__btn refs-row-menu"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        {...hoverTooltip(tip, "More actions")}
        onClick={(e) => {
          e.stopPropagation();
          if (anchor !== null) {
            setAnchor(null);
            return;
          }
          const r = btnRef.current?.getBoundingClientRect();
          if (r) setAnchor({ x: r.right, y: r.bottom + 4 });
        }}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="12" cy="5" r="2.3" />
          <circle cx="12" cy="12" r="2.3" />
          <circle cx="12" cy="19" r="2.3" />
        </svg>
        {tip.tooltipNode}
      </button>
      {anchor !== null && (
        <ContextMenu
          x={anchor.x}
          y={anchor.y}
          align="end"
          label={label}
          items={items}
          triggerRef={btnRef}
          onClose={() => setAnchor(null)}
        />
      )}
    </>
  );
}

/**
 * One row's actions in three fixed slots — primary, secondary, `⋮` — so the
 * same verb lands in the same place on every row, whichever of them a row
 * happens to offer. An empty slot still holds its width: that, not the button
 * count, is what keeps the columns to its left from shifting (see
 * `--refs-actions-w` in app.css, which is these three widths plus their gaps).
 */
export function RefRowActions({
  primary,
  secondary,
  menu
}: {
  primary?: ReactNode;
  secondary?: ReactNode;
  menu: ReactNode;
}) {
  return (
    <div className="refs-row-actions">
      <span className="refs-row-slot refs-row-slot--primary">{primary}</span>
      <span className="refs-row-slot refs-row-slot--secondary">{secondary}</span>
      <span className="refs-row-slot refs-row-slot--menu">{menu}</span>
    </div>
  );
}
