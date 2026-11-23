import { memo, useId, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import type { Commit, LaneBranchInfo, MovedTag, PrSummary, RepositoryStack, StackPosition } from "@pwrgit/shared";
import { BranchGlyph } from "../../lib/BranchGlyph";
import { ChevronGlyph } from "../../lib/ChevronGlyph";
import { CheckoutGlyph } from "../../lib/CheckoutGlyph";
import { AuthorAvatar } from "./AuthorAvatar";
import { hoverIntentHandlers, type HoverIntent } from "../../lib/hoverIntent";
import { StackPositionChip } from "../stacks/StackViews";
import { PrChip } from "../sidebar/PrChip";
import { prChipLabel } from "../sidebar/pr-status";
import { TagGlyph } from "../../lib/TagGlyph";
import type { LaneRow, LaneSeg } from "./lane-layout";
import type { PrLandingSeg } from "./pr-landings";
import type { BranchChipTarget } from "./BranchChipMenu";
import { shortWhen } from "./graph-view";
import {
  hoverTooltip,
  useViewportTooltip
} from "../../lib/useViewportTooltip";

export const LANE_W = 16;
const ROW_H = 64;
const MID = ROW_H / 2;

/** The gutter viewport shows at most this many lanes; wider graphs scroll
 *  horizontally inside it so commit text never gets pushed off-screen. */
export const MAX_GUTTER_LANES = 10;
/** At most two branch tips preview on a wide row. The ref list has every tip. */
const MAX_REF_CHIPS = 2;
export const gutterWidth = (laneCount: number): number =>
  Math.min(Math.max(1, laneCount), MAX_GUTTER_LANES) * LANE_W;

// Lane palette. Lane 0 (the default-branch spine) is the app accent; the rest
// rotate through legible, distinct hues. The values live in tokens.css as
// --lane-1..--lane-8 so the palette themes with the app instead of pinning
// dark-theme literals into TSX.
const LANE_COLORS = [
  "var(--lane-1)",
  "var(--lane-2)",
  "var(--lane-3)",
  "var(--lane-4)",
  "var(--lane-5)",
  "var(--lane-6)",
  "var(--lane-7)",
  "var(--lane-8)"
];
export const laneColor = (i: number): string =>
  LANE_COLORS[i % LANE_COLORS.length] ?? "var(--lane-1)";

const cx = (lane: number): number => lane * LANE_W + LANE_W / 2;

// Fetched-but-unapplied trunk, one pattern per remote tier: the closest remote
// seeds plain dashes, the next remote out seeds dash-dot, then dash-dot-dot
// (cycling beyond that). A continuous remote-only stretch retains its strongest
// pattern until the local tip starts solid history. Every pattern's period
// divides ROW_H and MID, so the dash phase lines up across row seams and
// straight runs read as one continuous line.
const DASHES = ["4 4", "4 2 1 1", "6 3 1 2 1 3"];
const dashFor = (tier: number): string =>
  DASHES[(tier - 1) % DASHES.length] ?? "4 4";

// Curved lane transitions with vertical tangents at both ends — adjacent rows
// meet with matching (vertical) slopes, so a multi-row swerve reads as one
// continuous ribbon instead of a chain of straight diagonals.
const curveTop = (from: number, to: number): string =>
  `M ${cx(from)} 0 C ${cx(from)} ${MID * 0.5}, ${cx(to)} ${MID * 0.5}, ${cx(to)} ${MID}`;
const curveBottom = (from: number, to: number): string =>
  `M ${cx(from)} ${MID} C ${cx(from)} ${MID + MID * 0.5}, ${cx(to)} ${MID + MID * 0.5}, ${cx(to)} ${ROW_H}`;

type PrLanding = { top: PrLandingSeg[]; bottom: PrLandingSeg[] };

export type GraphRowVM = {
  commit: Commit;
  row: LaneRow;
  refs: string[];
  tag?: { name: string; kind: "annotated" | "lightweight" } | undefined;
  /** `tag` differs from the published remote's value (Moved Tags 3a). */
  tagMoved?: MovedTag | undefined;
  /** Published values of local tags that sit elsewhere: drawn as dashed chips
   *  where the publisher now points (Moved Tags 3a). */
  publishedTags?: MovedTag[] | undefined;
  /** Remote-tracking refs to chip here — full ("origin/main") when the remote
   *  sits away from its local branch, collapsed ("origin") when synced. */
  remoteRefs: string[];
  isHead: boolean;
  /** Reachable from the viewed HEAD but not the default comparison ref. */
  isHeadOnly: boolean;
  isMine: boolean;
  defaultBranch: string;
  /** Best pull request associated with this exact commit, when known. */
  pullRequest?: PrSummary;
};

export function GraphRow({
  vm,
  laneCount,
  prLanding,
  now,
  selected,
  focused,
  contextOpen,
  flashing,
  branchInfo,
  authorAvatarUrl,
  personOpen = false,
  hoverIntent,
  onOpen,
  onShowContext,
  onHideContext,
  onFocusContext,
  onShowPerson,
  onHidePerson,
  onFocusPerson,
  onOpenContextMenu,
  onOpenBranchMenu,
  onRevealWorktree,
  onTakeTag,
  stackPositions,
  oldStackBases,
  onOpenStack
}: {
  vm: GraphRowVM;
  laneCount: number;
  /** Dotted semantic PR landing segments; never part of Git ancestry. */
  prLanding?: PrLanding;
  /** One shared renderer clock, supplied by LineageGraph. */
  now: number;
  selected: boolean;
  /** This commit's files are open in the rail (commit focus). */
  focused: boolean;
  /** Its interactive context card remains open after the pointer leaves. */
  contextOpen: boolean;
  /** One-shot attention pulse after a locate/worktree switch. */
  flashing: boolean;
  /** branch name → PR / worktree adornments for tip chips. */
  branchInfo?: Record<string, LaneBranchInfo>;
  stackPositions?: ReadonlyMap<string, StackPosition>;
  oldStackBases?: ReadonlyMap<string, StackPosition>;
  onOpenStack?: (stack: RepositoryStack) => void;
  /** The author's linked forge avatar, from main's people store. Absent
   *  draws initials. */
  authorAvatarUrl?: string | undefined;
  /** This row's byline has the person card open. */
  personOpen?: boolean;
  /** Shared hover-intent gate, owned by LineageGraph so hundreds of rows do
   *  not each mount their own. */
  hoverIntent: HoverIntent;
  onOpen: () => void;
  onShowContext: (
    target: HTMLElement,
    anchor: { x: number; y: number }
  ) => void;
  onHideContext: () => void;
  /** Move keyboard focus from the SHA trigger into the open context card. */
  onFocusContext: () => boolean;
  /** Open the author's person card beside the byline. Omitted, the byline is
   *  plain text. */
  onShowPerson?: (target: HTMLElement) => void;
  onHidePerson?: () => void;
  /** Move keyboard focus from the byline into the open person card. */
  onFocusPerson?: () => boolean;
  onOpenContextMenu: (position: { x: number; y: number }) => void;
  /** Open actions for one ref from its inline chip or the ref list. */
  onOpenBranchMenu?: (target: BranchChipTarget) => void;
  /** Jump to the worktree a tip branch is checked out in. */
  onRevealWorktree?: (worktreeId: string) => void;
  /** Take the published value of a moved tag. Omitted, its chips are marks. */
  onTakeTag?: (moved: MovedTag) => void;
}) {
  const {
    commit,
    row,
    refs,
    remoteRefs,
    isHead,
    isMine,
    pullRequest
  } = vm;
  /** The row's plain tooltips — the tag chip, the
   *  branch names and the worktree button. Not the gated SHA/PR
   *  cards below, which repeat down a column the pointer crosses (see
   *  lib/AGENTS.md). */
  const tip = useViewportTooltip();
  const width = Math.max(1, laneCount) * LANE_W;
  const color = laneColor(row.lane);
  const chipCount = refs.length + remoteRefs.length;
  const bracket = refs.length ? refs.map(ref => stackPositions?.get(ref)).find(position => position !== undefined) : undefined;
  const oldStackBase = oldStackBases?.get(commit.hash);
  const isTip = chipCount > 0;
  const orderedRefs = bracket ? [bracket.layer.branch, ...refs.filter(ref => ref !== bracket.layer.branch)] : refs;
  const movedTag = onTakeTag === undefined ? undefined : vm.tagMoved;
  const publishedTags = onTakeTag === undefined ? undefined : vm.publishedTags;
  const refCount = chipCount + Number(vm.tag !== undefined) + (publishedTags?.length ?? 0);
  // Keep the tracked stack layer first and give its position chip the second slot.
  const localPreview = orderedRefs.slice(0, bracket ? 1 : MAX_REF_CHIPS);
  const remotePreview = remoteRefs.slice(0, MAX_REF_CHIPS - localPreview.length - Number(bracket !== undefined));
  const x = cx(row.lane);

  const showContextFor = (target: HTMLElement): void => {
    const rect = target.getBoundingClientRect();
    onShowContext(target, {
      x: (rect.left + rect.right) / 2,
      y: (rect.top + rect.bottom) / 2
    });
  };
  // A pointer thrown across the window crosses many rows. Only a deliberate
  // hover should open a card; focus and click stay instant.
  const context = hoverIntentHandlers({
    intent: hoverIntent,
    show: showContextFor,
    hide: onHideContext
  });
  // The byline is gated by the same intent: it repeats down a column the
  // pointer crosses just as the SHA does.
  const personCard = hoverIntentHandlers({
    intent: hoverIntent,
    show: (target) => onShowPerson?.(target),
    hide: () => onHidePerson?.()
  });

  // A tip chip is the branch's own surface: either button opens its menu, so a
  // right-click on a branch offers branch actions instead of the commit's, and
  // a left-click does not fall through to opening the commit.
  const branchMenu = (
    ref: string,
    isRemote: boolean,
    browser?: RefBrowserActions
  ) => {
    const open = (event: MouseEvent<HTMLButtonElement>): void => {
      event.preventDefault();
      event.stopPropagation();
      if (onOpenBranchMenu === undefined) return;
      const trigger = browser?.trigger ?? event.currentTarget;
      // Keyboard activation has no pointer coordinates. The read belongs to
      // the explicitly opened menu, never to the row's layout.
      const keyboard = event.detail === 0 && event.clientX === 0 && event.clientY === 0;
      const rect = keyboard ? event.currentTarget.getBoundingClientRect() : undefined;
      const target = {
        ref, isRemote, trigger,
        x: rect?.left ?? event.clientX,
        y: rect?.bottom ?? event.clientY
      };
      if (browser === undefined) {
        onOpenBranchMenu(target);
      } else {
        browser.close();
        // Focusing a list entry can queue a scroll. Let that event reach
        // the closing list before the branch menu starts listening to scroll.
        requestAnimationFrame(() => {
          if (trigger.isConnected) onOpenBranchMenu(target);
        });
      }
    };
    return { onClick: open, onContextMenu: open };
  };

  const byline = (
    <>
      <AuthorAvatar
        block="commit-byline__avatar"
        name={commit.authorName}
        avatarUrl={authorAvatarUrl}
        size={16}
      />
      <span className={`commit-author${isMine ? "" : " is-other"}`}>
        {isMine ? "you" : commit.authorName}
      </span>
    </>
  );

  function renderTag(tag: NonNullable<GraphRowVM["tag"]>, browser?: RefBrowserActions) {
    const kind = tag.kind === "annotated" ? "Annotated tag" : "Tag";
    const name = <span className="commit-tag__name">{tag.name}</span>;
    if (movedTag !== undefined && onTakeTag !== undefined) {
      const { remote, targetId } = movedTag.published;
      return (
        <button
          type="button"
          className="commit-tag commit-tag--tag is-moved"
          aria-label={`${kind} ${tag.name}, moved on ${remote} to ${targetId.slice(0, 7)}. Take ${remote}'s…`}
          {...(browser === undefined && hoverTooltip(tip, `${remote}'s ${tag.name} is at ${targetId.slice(0, 12)}\nClick to take ${remote}'s.`))}
          onClick={(event) => {
            event.stopPropagation();
            browser?.close();
            tip.hide();
            onTakeTag(movedTag);
          }}
        >
          <TagGlyph />
          {name}
          <span className="commit-tag__moved" aria-hidden="true">· moved</span>
        </button>
      );
    }
    return (
      <span className="commit-tag commit-tag--tag" {...(browser === undefined && hoverTooltip(tip, `${kind} ${tag.name}`))}>
        <TagGlyph />
        <span className="a11y-sr-only">{kind} </span>
        {name}
      </span>
    );
  }

  function renderPublishedTag(moved: MovedTag, browser?: RefBrowserActions) {
    const { remote } = moved.published;
    return (
      <button
        type="button"
        className="commit-tag commit-tag--tag is-published"
        aria-label={`${remote}'s ${moved.name} points here; local ${moved.name} is at ${moved.local.targetId.slice(0, 7)}. Take ${remote}'s…`}
        {...(browser === undefined && hoverTooltip(tip, `${remote}'s ${moved.name} points here\nLocal ${moved.name} is at ${moved.local.targetId.slice(0, 12)}\nClick to take ${remote}'s.`))}
        onClick={(event) => {
          event.stopPropagation();
          browser?.close();
          tip.hide();
          onTakeTag?.(moved);
        }}
      >
        <TagGlyph />
        <span className="commit-tag__remote">{remote}</span>
        <span className="commit-tag__name">{moved.name}</span>
      </button>
    );
  }

  function renderLocal(name: string, secondary: boolean, browser?: RefBrowserActions) {
    const info = branchInfo?.[name];
    const pr = info?.pr?.number === pullRequest?.number ? undefined : info?.pr;
    const position = stackPositions?.get(name);
    const worktreeId = info?.worktreeId;
    return (
      <span key={name} className={`ref-group${secondary ? " ref-preview--secondary" : ""}`}>
        <button
          type="button"
          className="ref-chip"
          aria-label={`Actions for branch ${name}`}
          title={browser === undefined ? name : undefined}
          {...branchMenu(name, false, browser)}
        >
          <BranchGlyph size={8} strokeWidth={2.6} />
          <span className="ref-chip__name">{name}</span>
        </button>
        {position !== undefined && onOpenStack !== undefined && (
          <StackPositionChip position={position} onSelect={() => {
            browser?.close();
            onOpenStack(position.stack);
          }} />
        )}
        {pr !== undefined && (browser === undefined
          ? <PrChip pr={pr} hoverIntent={hoverIntent} />
          : <span className="ref-list__pr">{prChipLabel(pr)}</span>)}
        {worktreeId !== undefined && (
          <button
            type="button"
            className="ref-wt"
            {...(browser === undefined && hoverTooltip(tip, "Checked out in a worktree — click to open it"))}
            aria-label={`Open the ${name} worktree`}
            onClick={(event) => {
              event.stopPropagation();
              browser?.close();
              onRevealWorktree?.(worktreeId);
            }}
          >
            <CheckoutGlyph size={10} />
          </button>
        )}
      </span>
    );
  }

  function renderRemote(name: string, secondary: boolean, browser?: RefBrowserActions) {
    // A remote alone ("origin", when it sits on the local branch) is a label.
    const branch = name.includes("/");
    const Chip = branch ? "button" : "span";
    return (
      <Chip
        key={`r:${name}`}
        className={`ref-chip ref-chip--remote${secondary ? " ref-preview--secondary" : ""}`}
        title={browser === undefined ? name : undefined}
        {...(branch && { type: "button", "aria-label": `Actions for remote branch ${name}`, ...branchMenu(name, true, browser) })}
      >
        <BranchGlyph size={8} strokeWidth={2.6} />
        {!branch && <span className="a11y-sr-only">Remote </span>}
        <span className="ref-chip__name">{name}</span>
      </Chip>
    );
  }

  function renderMeta() {
    return (
      <div className="commit-meta" style={{ "--ref-lane-color": color } as CSSProperties}>
        {pullRequest !== undefined && <PrChip pr={pullRequest} hoverIntent={hoverIntent} />}
        {vm.tag !== undefined ? renderTag(vm.tag)
          : publishedTags?.[0] !== undefined && renderPublishedTag(publishedTags[0])}
        {isHead && <span className="commit-tag commit-tag--head">HEAD</span>}
        {oldStackBase && <span className="commit-tag commit-tag--old-parent" {...hoverTooltip(tip, `Recorded parent tip of ${oldStackBase.layer.branch}`)}>
          Old parent tip
        </span>}
        {isTip && (
          <span className="ref-chips">
            {localPreview.map((name, index) => renderLocal(name, index > 0))}
            {remotePreview.map((name, index) => renderRemote(name, localPreview.length + index > 0))}
          </span>
        )}
        {refCount > 0 && (
          <RefBrowser count={refCount} commit={commit.shortHash}>
            {(browser) => (
              <>
                {oldStackBase !== undefined && <p className="ref-list__note">Recorded parent tip of {oldStackBase.layer.branch}</p>}
                <ul className="ref-list">
                  {vm.tag !== undefined && <li>{renderTag(vm.tag, browser)}</li>}
                  {publishedTags?.map((moved) => <li key={moved.name}>{renderPublishedTag(moved, browser)}</li>)}
                  {orderedRefs.map((name) => <li key={name}>{renderLocal(name, false, browser)}</li>)}
                  {remoteRefs.map((name) => <li key={`remote:${name}`}>{renderRemote(name, false, browser)}</li>)}
                </ul>
              </>
            )}
          </RefBrowser>
        )}
        {commit.isMerge && <span className="commit-tag commit-tag--merge">merge</span>}
        {onShowPerson === undefined ? (
          <span className="commit-byline">{byline}</span>
        ) : (
          <button
            type="button"
            className={`commit-byline${personOpen ? " is-open" : ""}`}
            aria-label={`Show author ${isMine ? "(you) " : ""}${commit.authorName}`}
            aria-expanded={personOpen}
            onMouseEnter={(e) => personCard.onMouseEnter(e.currentTarget)}
            onMouseLeave={personCard.onMouseLeave}
            onFocus={(e) => personCard.onFocus(e.currentTarget)}
            onBlur={personCard.onBlur}
            onKeyDown={(e) => {
              if (e.key === "Tab" && !e.shiftKey && onFocusPerson?.() === true) {
                e.preventDefault();
              }
            }}
            onClick={(e) => {
              e.stopPropagation();
              personCard.showNow(e.currentTarget);
            }}
          >
            {byline}
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      className={`graph-row${selected ? " is-selected" : ""}${
        isHead ? " graph-row--head" : ""
      }${focused ? " is-focused" : ""}${
        contextOpen ? " is-context-open" : ""
      }${flashing ? " is-flash" : ""}`}
      data-hash={commit.hash}
      onClick={onOpen}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onOpenContextMenu({ x: e.clientX, y: e.clientY });
      }}
      style={{ height: ROW_H }}
    >
      <div className="graph-lanes-clip" style={{ width: gutterWidth(laneCount) }}>
        <svg
          className="graph-lanes"
          width={width}
          height={ROW_H}
          viewBox={`0 0 ${width} ${ROW_H}`}
        >
        <GraphLaneSegments row={row} prLanding={prLanding} />

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
            <circle cx={x} cy={MID} r={4} fill="var(--bg-panel)" stroke={color} strokeWidth={2} />
            <circle cx={x} cy={MID} r={1.6} fill={color} />
          </>
        ) : (
          <circle
            cx={x}
            cy={MID}
            r={isTip || isHead ? 5 : 4}
            fill={isMine ? color : "var(--bg-panel)"}
            stroke={isMine ? "var(--bg-panel)" : color}
            strokeWidth={2}
          />
        )}
        </svg>
        {bracket && onOpenStack && <button type="button" className="stack-graph-bracket"
          aria-label={`Open stack for ${bracket.layer.branch}`}
          style={{ color }}
          onClick={event => { event.stopPropagation(); onOpenStack(bracket.stack); }} />}
      </div>

      <div className="commit-body">
        {/* The SHA scopes only the title line. Branch chips and authorship keep
            their original left edge on the meta line below. */}
        <div className="commit-line">
          <button
            type="button"
            className="commit-sha-chip"
            aria-label={`Show context for commit ${commit.shortHash}`}
            onMouseEnter={(e) => context.onMouseEnter(e.currentTarget)}
            onMouseLeave={context.onMouseLeave}
            onFocus={(e) => context.onFocus(e.currentTarget)}
            onBlur={context.onBlur}
            onKeyDown={(e) => {
              if (e.key === "Tab" && !e.shiftKey && onFocusContext()) {
                e.preventDefault();
              }
            }}
            onClick={(e) => {
              e.stopPropagation();
              context.showNow(e.currentTarget);
            }}
          >
            {commit.shortHash}
          </button>
          <span className={`commit-msg${isMine ? "" : " is-other"}`}>
            {commit.subject}
          </span>
          <span className="commit-time">{shortWhen(commit.committedAt, now)}</span>
        </div>
        {renderMeta()}
      </div>
      {tip.tooltipNode}
    </div>
  );
}

type RefBrowserActions = { trigger: HTMLButtonElement; close: () => void };

function RefBrowser({ count, commit, children }: {
  count: number;
  commit: string;
  children: (actions: RefBrowserActions) => ReactNode;
}) {
  const id = useId();
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null);
  const label = `${count} ${count === 1 ? "ref" : "refs"}`;
  return (
    <>
      <button
        type="button"
        className="ref-chip ref-browser"
        popoverTarget={id}
        aria-expanded={trigger !== null}
        aria-label={`Browse ${label} at ${commit}`}
        onClick={(event) => {
          event.stopPropagation();
          if (trigger === null) {
            event.preventDefault();
            setTrigger(event.currentTarget);
          }
        }}
      >
        <span className="ref-chip__name">{label}</span>
        <ChevronGlyph size={9} />
      </button>
      {trigger !== null && (
        <OpenRefBrowser id={id} commit={commit} trigger={trigger} onClose={() => setTrigger(null)}>
          {children}
        </OpenRefBrowser>
      )}
    </>
  );
}

function OpenRefBrowser({ id, commit, trigger, onClose, children }: {
  id: string;
  commit: string;
  trigger: HTMLButtonElement;
  onClose: () => void;
  children: (actions: RefBrowserActions) => ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  // Mount the list on demand. Supplying its invoker lets Chromium handle
  // anchoring, light dismiss and sequential focus navigation.
  useLayoutEffect(() => { panel.current?.showPopover({ source: trigger }); }, [trigger]);
  return (
    <div
      ref={panel}
      id={id}
      popover="auto"
      className="ref-browser-panel"
      role="region"
      aria-label={`Refs at ${commit}`}
      onToggle={(event) => { if (event.newState === "closed") onClose(); }}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
    >
      {children({ trigger, close: () => panel.current?.hidePopover() })}
    </div>
  );
}

type GraphLaneSegmentsProps = {
  row: LaneRow;
  prLanding: PrLanding | undefined;
};
type DrawableSegment = LaneSeg & { number?: number };

function sameSegments(
  previous: readonly DrawableSegment[] | undefined,
  next: readonly DrawableSegment[] | undefined
): boolean {
  if (previous === next) return true;
  if (previous === undefined || next === undefined || previous.length !== next.length) {
    return false;
  }
  for (let i = 0; i < previous.length; i += 1) {
    const before = previous[i]!;
    const after = next[i]!;
    if (
      before.from !== after.from ||
      before.to !== after.to ||
      before.dashed !== after.dashed ||
      before.number !== after.number
    ) {
      return false;
    }
  }
  return true;
}

// Interaction often reuses the layout. A graph refresh can rebuild every
// segment, so compare their drawing inputs in order to reuse the SVG paths.
const GraphLaneSegments = memo(function GraphLaneSegments({
  row,
  prLanding
}: GraphLaneSegmentsProps) {
  // A lane that runs straight through both halves of the row is drawn as ONE
  // full-height line (no half-line seam at the vertical midpoint). Halves with
  // different dash tiers (a local or remote tip row on the spine) stay
  // separate so the pattern boundary lands exactly at the dot.
  const passThrough = new Map<number, number>();
  for (const t of row.top) {
    if (t.from !== t.to) continue;
    const b = row.bottom.find((s) => s.from === s.to && s.from === t.from);
    if (b !== undefined && (t.dashed ?? 0) === (b.dashed ?? 0)) {
      passThrough.set(t.from, t.dashed ?? 0);
    }
  }

  return (
    <>
      {prLanding?.top.map((s, i) => (
        <path
          key={`plt${i}`}
          d={curveTop(s.from, s.to)}
          fill="none"
          stroke="var(--brand-purple)"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeDasharray="2 2"
          opacity={0.9}
        >
          <title>{`PR #${s.number} landed without a Git parent edge`}</title>
        </path>
      ))}
      {prLanding?.bottom.map((s, i) => (
        <path
          key={`plb${i}`}
          d={curveBottom(s.from, s.to)}
          fill="none"
          stroke="var(--brand-purple)"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeDasharray="2 2"
          opacity={0.9}
        >
          <title>{`PR #${s.number} landed without a Git parent edge`}</title>
        </path>
      ))}
      {[...passThrough].map(([k, dashed]) => (
        <line
          key={`p${k}`}
          x1={cx(k)}
          y1={0}
          x2={cx(k)}
          y2={ROW_H}
          stroke={laneColor(k)}
          strokeWidth={2}
          strokeDasharray={dashed > 0 ? dashFor(dashed) : undefined}
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
              strokeDasharray={s.dashed !== undefined ? dashFor(s.dashed) : undefined}
            />
          ) : (
            <path
              key={`t${i}`}
              d={curveTop(s.from, s.to)}
              fill="none"
              stroke={laneColor(s.from)}
              strokeWidth={2}
              strokeLinecap="round"
              strokeDasharray={s.dashed !== undefined ? dashFor(s.dashed) : undefined}
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
              strokeDasharray={s.dashed !== undefined ? dashFor(s.dashed) : undefined}
            />
          ) : (
            <path
              key={`b${i}`}
              d={curveBottom(s.from, s.to)}
              fill="none"
              stroke={laneColor(s.to)}
              strokeWidth={2}
              strokeLinecap="round"
              strokeDasharray={s.dashed !== undefined ? dashFor(s.dashed) : undefined}
            />
          )
        )}
    </>
  );
}, (previous, next) =>
  (previous.row === next.row || (
    sameSegments(previous.row.top, next.row.top) &&
    sameSegments(previous.row.bottom, next.row.bottom)
  )) &&
  (previous.prLanding === next.prLanding || (
    sameSegments(previous.prLanding?.top, next.prLanding?.top) &&
    sameSegments(previous.prLanding?.bottom, next.prLanding?.bottom)
  ))
);
