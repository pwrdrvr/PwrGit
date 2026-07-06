import type { CommitRowVM } from "./graph-view";
import { shortWhen } from "./graph-view";

export function CommitRow({
  row,
  index,
  total,
  selected,
  onToggle
}: {
  row: CommitRowVM;
  index: number;
  total: number;
  selected: boolean;
  onToggle: () => void;
}) {
  const topColor = index > 0 ? "#5b4025" : "transparent";
  const botColor = index < total - 1 ? "#5b4025" : "transparent";
  const dotFill = row.isBase ? "#0e0d0b" : row.isMine ? "#e8743a" : "#4a443b";
  const dotStroke = row.isBase ? "#e8743a" : row.isMine ? "#0e0d0b" : "#3a352e";

  return (
    <div
      className={`commit-row${selected ? " is-selected" : ""}`}
      onClick={onToggle}
    >
      <div className="commit-rail">
        <svg
          width="46"
          height="100%"
          viewBox="0 0 46 66"
          preserveAspectRatio="none"
        >
          <line x1="23" y1="0" x2="23" y2="33" stroke={topColor} strokeWidth="2" />
          <line x1="23" y1="33" x2="23" y2="66" stroke={botColor} strokeWidth="2" />
          {row.isMerge && (
            <>
              <path
                d="M41 66 C 41 48, 32 40, 23 33"
                fill="none"
                stroke="#7a5f3f"
                strokeWidth="2"
              />
              <circle cx="41" cy="60" r="4" fill="#7a5f3f" />
            </>
          )}
          <circle
            cx="23"
            cy="33"
            r="6"
            fill={dotFill}
            stroke={dotStroke}
            strokeWidth="2.5"
          />
        </svg>
      </div>

      <span className={`commit-check${selected ? " is-checked" : ""}`}>
        {selected && (
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#1a0d05" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round">
            <path d="m20 6-11 11-5-5" />
          </svg>
        )}
      </span>

      <div className="commit-body">
        <div className="commit-line">
          <span className={`commit-msg${row.isMine ? "" : " is-other"}`}>
            {row.subject}
          </span>
          <span className="commit-time">{shortWhen(row.committedAt)}</span>
        </div>
        <div className="commit-meta">
          <span className={`commit-author${row.isMine ? "" : " is-other"}`}>
            {row.isMine ? "you" : row.authorName}
          </span>
          <span className="commit-hash">{row.shortHash}</span>
          {row.isMerge && <span className="commit-tag">merge</span>}
          {row.isBase && (
            <span className="commit-tag commit-tag--base">branch root</span>
          )}
        </div>
      </div>
    </div>
  );
}
