import type { Commit } from "@pwrgit/shared";
import type { LaneRow } from "./lane-layout";
import { shortWhen } from "./graph-view";

export const LANE_W = 15;
const ROW_H = 64;

// Lane colors — the default/first lane gets the accent; others cycle through a
// small, dark-theme-legible palette. Kept modest (this graph stays quiet).
const LANE_COLORS = [
  "#e8743a",
  "#6dba7e",
  "#7aa2f7",
  "#c9a36b",
  "#b58cd6",
  "#e0687f"
];
export const laneColor = (i: number): string =>
  LANE_COLORS[i % LANE_COLORS.length] ?? "#e8743a";

const cx = (lane: number): number => lane * LANE_W + LANE_W / 2;

export type GraphRowVM = {
  commit: Commit;
  row: LaneRow;
  refs: string[];
  isHead: boolean;
  isMine: boolean;
  defaultBranch: string;
};

export function GraphRow({
  vm,
  laneCount,
  selected,
  onToggle,
  onOpen
}: {
  vm: GraphRowVM;
  laneCount: number;
  selected: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const { commit, row, refs, isHead, isMine } = vm;
  const width = Math.max(1, laneCount) * LANE_W;
  const color = laneColor(row.lane);

  return (
    <div
      className={`graph-row${selected ? " is-selected" : ""}`}
      onClick={onOpen}
      title="View this commit's changes"
      style={{ height: ROW_H }}
    >
      <svg
        className="graph-lanes"
        width={width}
        height={ROW_H}
        viewBox={`0 0 ${width} ${ROW_H}`}
      >
        {row.top.map((s, i) => (
          <line
            key={`t${i}`}
            x1={cx(s.from)}
            y1={0}
            x2={cx(s.to)}
            y2={ROW_H / 2}
            stroke={laneColor(s.from)}
            strokeWidth={2}
          />
        ))}
        {row.bottom.map((s, i) => (
          <line
            key={`b${i}`}
            x1={cx(s.from)}
            y1={ROW_H / 2}
            x2={cx(s.to)}
            y2={ROW_H}
            stroke={laneColor(s.to)}
            strokeWidth={2}
          />
        ))}
        {isHead && (
          <circle
            cx={cx(row.lane)}
            cy={ROW_H / 2}
            r={7.5}
            fill="none"
            stroke={color}
            strokeWidth={1.5}
            opacity={0.5}
          />
        )}
        <circle
          cx={cx(row.lane)}
          cy={ROW_H / 2}
          r={isHead ? 5 : 4}
          fill={isMine ? color : "#0e0d0b"}
          stroke={isMine ? "#0e0d0b" : color}
          strokeWidth={2}
        />
      </svg>

      <span
        className={`commit-check${selected ? " is-checked" : ""}`}
        role="checkbox"
        aria-checked={selected}
        title={selected ? "Deselect for rebase" : "Select for rebase"}
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
      >
        {selected && (
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#1a0d05" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round">
            <path d="m20 6-11 11-5-5" />
          </svg>
        )}
      </span>

      <div className="commit-body">
        <div className="commit-line">
          {refs.map((name) => (
            <span
              key={name}
              className={`ref-chip${name === vm.defaultBranch ? " ref-chip--default" : ""}`}
              title={name === vm.defaultBranch ? "Default branch" : "Branch tip"}
            >
              {name}
            </span>
          ))}
          <span className={`commit-msg${isMine ? "" : " is-other"}`}>
            {commit.subject}
          </span>
          <span className="commit-time">{shortWhen(commit.committedAt)}</span>
        </div>
        <div className="commit-meta">
          {isHead && <span className="commit-tag commit-tag--head">HEAD</span>}
          <span className={`commit-author${isMine ? "" : " is-other"}`}>
            {isMine ? "you" : commit.authorName}
          </span>
          <span className="commit-hash">{commit.shortHash}</span>
          {commit.isMerge && <span className="commit-tag">merge</span>}
        </div>
      </div>
    </div>
  );
}
