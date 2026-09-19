export function SelectionBar({
  count,
  onSquash,
  onReorder,
  onTidy,
  onOpenRebaseTool,
  onClear
}: {
  count: number;
  onSquash: () => void;
  onReorder: () => void;
  /** Absent where there is no agent path to offer (tests, older callers). */
  onTidy?: () => void;
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
      {onTidy !== undefined && (
        <button
          className="selection-bar__btn selection-bar__btn--agent"
          onClick={onTidy}
        >
          <span aria-hidden="true">✦ </span>Tidy…
        </button>
      )}
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
