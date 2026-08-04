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
      <span style={{ flex: 1 }} />
      <button className="selection-bar__rebase" onClick={onOpenRebaseTool}>
        Open rebase tool →
      </button>
      <button className="selection-bar__x" onClick={onClear} aria-label="Clear">
        ×
      </button>
    </div>
  );
}
