import { CloseGlyph } from "../../lib/CloseGlyph";

export function SelectionBar({
  count,
  onSquash,
  onReorder,
  onOpenRebaseTool,
  onClear
}: {
  count: number;
  onSquash: () => void;
  onReorder: () => void;
  onOpenRebaseTool: () => void;
  onClear: () => void;
}) {
  return (
    <div className="selection-bar">
      <span className="selection-bar__count">
        {count} commit{count === 1 ? "" : "s"} selected
      </span>
      <span className="selection-bar__sep" />
      <button className="selection-bar__btn" onClick={onSquash}>
        Squash
      </button>
      <button className="selection-bar__btn" onClick={onReorder}>
        Reorder
      </button>
      {/* One unit, so a narrow pane wraps the primary action and Clear onto
          the next line together; Clear alone at the start of a line reads as
          clearing something else. */}
      <span className="selection-bar__end">
        <button className="selection-bar__rebase" onClick={onOpenRebaseTool}>
          Open rebase tool →
        </button>
        <button className="selection-bar__x" onClick={onClear} aria-label="Clear">
          <CloseGlyph size={12} />
        </button>
      </span>
    </div>
  );
}
