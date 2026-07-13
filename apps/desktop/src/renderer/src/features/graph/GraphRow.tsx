import type { Commit, LaneBranchInfo } from "@pwrgit/shared";
import { PrChip } from "../sidebar/PrChip";
import type { LaneRow } from "./lane-layout";
import { shortWhen } from "./graph-view";

export const LANE_W = 16;
const ROW_H = 64;
const MID = ROW_H / 2;

/** The gutter viewport shows at most this many lanes; wider graphs scroll
 *  horizontally inside it so commit text never gets pushed off-screen. */
export const MAX_GUTTER_LANES = 10;
/** Most branch-tip chips shown on one row; the rest collapse into "+N". */
const MAX_REF_CHIPS = 2;
export const gutterWidth = (laneCount: number): number =>
  Math.min(Math.max(1, laneCount), MAX_GUTTER_LANES) * LANE_W;

// Lane palette tuned for the dark warm background. Lane 0 (the default-branch
// spine) is the app accent; the rest rotate through legible, distinct hues.
const LANE_COLORS = [
  "#e8743a",
  "#62c882",
  "#7aa2f7",
  "#e5b566",
  "#bd8ff0",
  "#ef7f95",
  "#58cfc0",
  "#a9b665"
];
export const laneColor = (i: number): string =>
  LANE_COLORS[i % LANE_COLORS.length] ?? "#e8743a";

const cx = (lane: number): number => lane * LANE_W + LANE_W / 2;

// Curved lane transitions with vertical tangents at both ends — adjacent rows
// meet with matching (vertical) slopes, so a multi-row swerve reads as one
// continuous ribbon instead of a chain of straight diagonals.
const curveTop = (from: number, to: number): string =>
  `M ${cx(from)} 0 C ${cx(from)} ${MID * 0.5}, ${cx(to)} ${MID * 0.5}, ${cx(to)} ${MID}`;
const curveBottom = (from: number, to: number): string =>
  `M ${cx(from)} ${MID} C ${cx(from)} ${MID + MID * 0.5}, ${cx(to)} ${MID + MID * 0.5}, ${cx(to)} ${ROW_H}`;

export type GraphRowVM = {
  commit: Commit;
  row: LaneRow;
  refs: string[];
  isHead: boolean;
  isMine: boolean;
  defaultBranch: string;
};

function BranchGlyph() {
  return (
    <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 3v12" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="6" r="3" />
      <path d="M18 9c0 6-6 6-6 12" />
    </svg>
  );
}

export function GraphRow({
  vm,
  laneCount,
  selected,
  flashing,
  branchInfo,
  onToggle,
  onOpen,
  onRevealWorktree
}: {
  vm: GraphRowVM;
  laneCount: number;
  selected: boolean;
  /** One-shot attention pulse after a locate/worktree switch. */
  flashing: boolean;
  /** branch name → PR / worktree adornments for tip chips. */
  branchInfo?: Record<string, LaneBranchInfo>;
  onToggle: () => void;
  onOpen: () => void;
  /** Jump to the worktree a tip branch is checked out in. */
  onRevealWorktree?: (worktreeId: string) => void;
}) {
  const { commit, row, refs, isHead, isMine } = vm;
  const width = Math.max(1, laneCount) * LANE_W;
  const color = laneColor(row.lane);
  const isTip = refs.length > 0;
  const x = cx(row.lane);

  // A lane that runs straight through both halves of the row is drawn as ONE
  // full-height line (no half-line seam at the vertical midpoint).
  const passThrough = new Set<number>();
  for (const t of row.top) {
    if (
      t.from === t.to &&
      row.bottom.some((b) => b.from === b.to && b.from === t.from)
    ) {
      passThrough.add(t.from);
    }
  }

  return (
    <div
      className={`graph-row${selected ? " is-selected" : ""}${
        isHead ? " graph-row--head" : ""
      }${flashing ? " is-flash" : ""}`}
      data-hash={commit.hash}
      onClick={onOpen}
      title="View this commit's changes"
      style={{ height: ROW_H }}
    >
      <div className="graph-lanes-clip" style={{ width: gutterWidth(laneCount) }}>
        <svg
          className="graph-lanes"
          width={width}
          height={ROW_H}
          viewBox={`0 0 ${width} ${ROW_H}`}
        >
        {[...passThrough].map((k) => (
          <line
            key={`p${k}`}
            x1={cx(k)}
            y1={0}
            x2={cx(k)}
            y2={ROW_H}
            stroke={laneColor(k)}
            strokeWidth={2}
          />
        ))}
        {row.top
          .filter((s) => !(s.from === s.to && passThrough.has(s.from)))
          .map((s, i) =>
            s.from === s.to ? (
              <line
                key={`t${i}`}
                x1={cx(s.from)}
                y1={0}
                x2={cx(s.to)}
                y2={MID}
                stroke={laneColor(s.from)}
                strokeWidth={2}
              />
            ) : (
              <path
                key={`t${i}`}
                d={curveTop(s.from, s.to)}
                fill="none"
                stroke={laneColor(s.from)}
                strokeWidth={2}
                strokeLinecap="round"
              />
            )
          )}
        {row.bottom
          .filter((s) => !(s.from === s.to && passThrough.has(s.from)))
          .map((s, i) =>
            s.from === s.to ? (
              <line
                key={`b${i}`}
                x1={cx(s.from)}
                y1={MID}
                x2={cx(s.to)}
                y2={ROW_H}
                stroke={laneColor(s.to)}
                strokeWidth={2}
              />
            ) : (
              <path
                key={`b${i}`}
                d={curveBottom(s.from, s.to)}
                fill="none"
                stroke={laneColor(s.to)}
                strokeWidth={2}
                strokeLinecap="round"
              />
            )
          )}

        {/* Soft halo behind branch tips + HEAD so the eye lands on them. */}
        {(isTip || isHead) && (
          <circle cx={x} cy={MID} r={9} fill={color} opacity={0.16} />
        )}
        {isHead && (
          <circle
            className="head-ring"
            cx={x}
            cy={MID}
            r={7.5}
            fill="none"
            stroke={color}
            strokeWidth={1.5}
          />
        )}
        {commit.isMerge ? (
          <>
            <circle cx={x} cy={MID} r={4} fill="#0e0d0b" stroke={color} strokeWidth={2} />
            <circle cx={x} cy={MID} r={1.6} fill={color} />
          </>
        ) : (
          <circle
            cx={x}
            cy={MID}
            r={isTip || isHead ? 5 : 4}
            fill={isMine ? color : "#0e0d0b"}
            stroke={isMine ? "#0e0d0b" : color}
            strokeWidth={2}
          />
        )}
        </svg>
      </div>

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
        {/* Line 1 belongs to the subject — branch chips and authorship live on
            the meta line so long messages aren't pushed off the edge. */}
        <div className="commit-line">
          <span className={`commit-msg${isMine ? "" : " is-other"}`}>
            {commit.subject}
          </span>
          <span className="commit-time">{shortWhen(commit.committedAt)}</span>
        </div>
        <div className="commit-meta">
          {isHead && <span className="commit-tag commit-tag--head">HEAD</span>}
          {/* Chips are capped — a commit tipped by dozens of stale branches
              must not flood the row. Overflow collapses into a +N pill whose
              tooltip lists everything. */}
          {refs.length > 0 && (
            <span className="ref-chips" title={refs.join("\n")}>
              {refs.slice(0, MAX_REF_CHIPS).map((name) => {
                const info = branchInfo?.[name];
                const wtId = info?.worktreeId;
                return (
                  <span key={name} className="ref-group">
                    <span
                      className="ref-chip"
                      style={{
                        color,
                        borderColor: `color-mix(in srgb, ${color} 45%, transparent)`,
                        background: `color-mix(in srgb, ${color} 13%, transparent)`
                      }}
                    >
                      <BranchGlyph />
                      {name}
                    </span>
                    {info?.pr !== undefined && <PrChip pr={info.pr} />}
                    {wtId !== undefined && (
                      <button
                        className="ref-wt"
                        title="Checked out in a worktree — click to open it"
                        aria-label={`Open the ${name} worktree`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onRevealWorktree?.(wtId);
                        }}
                      >
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M3 10.5 12 3l9 7.5" />
                          <path d="M5 9.5V20h14V9.5" />
                        </svg>
                      </button>
                    )}
                  </span>
                );
              })}
              {refs.length > MAX_REF_CHIPS && (
                <span className="ref-chip ref-chip--more">
                  +{refs.length - MAX_REF_CHIPS}
                </span>
              )}
            </span>
          )}
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
