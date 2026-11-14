import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import {
  hoverTooltip,
  useViewportTooltip,
  type ViewportTooltip
} from "../../lib/useViewportTooltip";

/** Indent level for a tree row. The stylesheet turns it into padding and one
 *  guide line per ancestor folder ("File tree" in app.css). */
export const treeDepthStyle = (depth: number): CSSProperties =>
  ({ "--tree-depth": depth }) as CSSProperties;

export function filesCount(count: number): string {
  return `${count} file${count === 1 ? "" : "s"}`;
}

/**
 * A folder row in any rail file list: chevron, folder glyph, its label (one
 * segment or a compacted chain) and how many files sit beneath it. The
 * Changes tab adds its Stage and Discard buttons through `actions`, which
 * share the row's tooltip.
 */
export function TreeFolderRow({
  dir,
  label,
  depth,
  count,
  open,
  onToggleOpen,
  onContextMenu,
  actions
}: {
  /** Full path, for the tooltip and labels that must say which folder. */
  dir: string;
  label: string;
  depth: number;
  /** Every file beneath the folder, at any depth. */
  count: number;
  open: boolean;
  onToggleOpen: () => void;
  onContextMenu?: (event: ReactMouseEvent) => void;
  actions?: (tip: ViewportTooltip) => ReactNode;
}) {
  const tip = useViewportTooltip();
  return (
    <div
      className="folder-row"
      style={treeDepthStyle(depth)}
      onClick={onToggleOpen}
      {...(onContextMenu === undefined ? {} : { onContextMenu })}
    >
      <button
        className="folder-row__twisty"
        onClick={(e) => {
          e.stopPropagation();
          onToggleOpen();
        }}
        {...hoverTooltip(tip, open ? "Hide files" : "Show files")}
        aria-label={`${open ? "Hide" : "Show"} the files in ${dir}`}
        aria-expanded={open}
      >
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
          <path d={open ? "m6 9 6 6 6-6" : "m9 18 6-6-6-6"} />
        </svg>
      </button>
      <span className="folder-row__icon" aria-hidden="true">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
        </svg>
      </span>
      <span className="folder-row__path" {...hoverTooltip(tip, `${dir}/ — ${filesCount(count)}`)}>
        {label}
      </span>
      <span className="folder-row__count">{count}</span>
      {actions !== undefined && <span className="file-row__actions">{actions(tip)}</span>}
      {tip.tooltipNode}
    </div>
  );
}
