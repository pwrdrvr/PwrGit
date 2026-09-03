import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type MouseEvent as ReactMouseEvent
} from "react";
import {
  imageMediaType,
  type PartialDiffHunk,
  type PartialDiffLine
} from "@pwrgit/shared";
import { ContextMenu, type MenuItem } from "../shell/ContextMenu";
import { DiffStat } from "./DiffStat";
import { ImageDiff, type ImageDiffRevisions } from "./ImageDiff";
import { ImageLightbox } from "./ImageLightbox";
import {
  buildSequence,
  imageFilesOf,
  indexOfStop,
  type SideKey
} from "./lightbox-sequence";
import type { SideSeed, SideStates } from "./use-image-revisions";
import { type DiffFile, parseUnifiedDiff } from "./parse-diff";

const STATUS_LABEL: Record<DiffFile["status"], string> = {
  added: "added",
  deleted: "deleted",
  modified: "modified",
  renamed: "renamed"
};

/** Why a changed line inside an otherwise selectable hunk carries no tick.
 *  Shown on the disabled box itself: a row that loses its control while its
 *  neighbours keep theirs reads as a rendering fault, and nothing else on
 *  screen would tell the user that Git's EOF marker is the reason. */
const ATOMIC_LINE_TITLE =
  "This file has no trailing newline, so its last change can only move as a whole hunk.";


export type DiffSelectionControls = {
  staged: boolean;
  selectedIds: ReadonlySet<string>;
  applying: boolean;
  hunks: PartialDiffHunk[];
  /** One call per gesture. With no `op`, the single ID toggles. A range
   *  gesture names its intent instead: "check" or "uncheck" applies to every
   *  ID. Intent used to ride implicitly on array order — the lead's toggled
   *  state drove the run — and that inverted the commonest gesture of all
   *  (tick a line, shift-click to extend cleared the whole range). */
  onToggleLine: (ids: string[], op?: "check" | "uncheck") => void;
  onApply: (lineIds: string[]) => void;
};

/** Renders a raw unified-diff patch (one or many files). No syntax
 *  highlighting — added/removed/context rows in a line-numbered grid. */
export function DiffViewer({
  patch,
  emptyLabel,
  images,
  selection,
  fileMenuItems,
  onBlameFrom
}: {
  patch: string;
  emptyLabel?: string;
  /** Revisions the patch compares; enables previews for binary image files. */
  images?: ImageDiffRevisions;
  /** Typed line IDs from the main process. Present only for a selectable
   * working-tree patch; commit and protected file kinds remain read-only. */
  selection?: DiffSelectionControls;
  /**
   * Per-file actions, offered from a menu on that file's own strip. This is
   * the only place a WHOLE-COMMIT diff can reach one file's history or blame:
   * everywhere else you have to leave, find the file in the rail, open it, and
   * come back.
   */
  fileMenuItems?: (path: string) => MenuItem[];
  /** Blame the file from a specific line — wired to the new-side gutter, so
   *  "I am reading line 248" becomes "blame opens AT line 248". */
  onBlameFrom?: (path: string, line: number) => void;
}) {
  const parsed = useMemo(() => parseUnifiedDiff(patch), [patch]);
  // The trigger rides along so ContextMenu can tell "clicked the kebab again"
  // from an outside click — without it the same click closed and reopened the
  // menu, which made the kebab impossible to toggle shut.
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    path: string;
    trigger: HTMLButtonElement;
  } | null>(null);
  const [lightbox, setLightbox] = useState<{
    at: number;
    seed: SideSeed;
  } | null>(null);
  // Memoized, and above the early return so the hook order holds. Both are
  // pure functions of the already-memoized parse, and a fresh `files` array
  // each render would defeat ImageLightbox's own useMemo — which invalidates
  // its `step`, which re-registers the window keydown listener every render.
  const walk = useMemo(() => {
    const imageFiles = images === undefined ? [] : imageFilesOf(parsed.files);
    return { imageFiles, sequence: buildSequence(imageFiles) };
  }, [images, parsed]);
  if (parsed.files.length === 0) {
    return <div className="diff-empty">{emptyLabel ?? "No changes."}</div>;
  }
  // Line coordinates are keyed by kind and line number with no file dimension,
  // so a selection snapshot only describes a single-file patch. `diff:fileSelection`
  // only ever returns one, but nothing in the prop's type says so — and handing
  // the same map to a second file would tick a row in the wrong one.
  const scoped = parsed.files.length === 1 ? selection : undefined;
  // The lightbox lives HERE rather than in each row because its arrows walk
  // every image in the diff — before, after, diff, then on to the next file.
  // A row only knows its own picture, so it hands the request up along with
  // the bytes it already holds and this owns the walk.
  const { imageFiles, sequence } = walk;
  const openImage = (file: DiffFile, item: SideKey, states: SideStates) => {
    const fileIndex = imageFiles.indexOf(file);
    if (fileIndex === -1) return;
    setLightbox({
      at: indexOfStop(sequence, { fileIndex, item }),
      seed: { path: file.path, states }
    });
  };
  return (
    <div
      className={`diff-view${scoped === undefined ? "" : " diff-view--selectable"}`}
    >
      {parsed.files.map((file, i) => (
        <DiffFileView
          key={`${file.path}-${i}`}
          file={file}
          images={images}
          selection={scoped}
          onOpenImage={(item, states) => openImage(file, item, states)}
          {...(onBlameFrom === undefined ? {} : { onBlameFrom })}
          {...(fileMenuItems === undefined
            ? {}
            : {
                onMenu: (event: ReactMouseEvent<HTMLButtonElement>) => {
                  const trigger = event.currentTarget;
                  const box = trigger.getBoundingClientRect();
                  setMenu((current) =>
                    current?.path === file.path
                      ? null
                      : { x: box.right, y: box.bottom + 4, path: file.path, trigger }
                  );
                }
              })}
        />
      ))}
      {menu !== null && fileMenuItems !== undefined && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={`Actions for ${menu.path}`}
          triggerRef={{ current: menu.trigger }}
          onClose={() => setMenu(null)}
          items={fileMenuItems(menu.path)}
        />
      )}
      {lightbox !== null && images !== undefined && (
        <ImageLightbox
          files={imageFiles}
          revisions={images}
          at={lightbox.at}
          seed={lightbox.seed}
          onMove={(at) => setLightbox((prev) => (prev === null ? prev : { ...prev, at }))}
          onClose={() => setLightbox(null)}
        />
      )}
    </div>
  );
}

type DiffLine = DiffFile["hunks"][number]["lines"][number];
type LineMeta = PartialDiffLine & { lineSelection: boolean };

const selectionKey = (kind: "add" | "delete", line: number | null): string =>
  `${kind}:${line ?? ""}`;

/** The metadata coordinate for a parsed display row, or null for context. */
const coordinateOf = (line: DiffLine): string | null =>
  line.kind === "ctx"
    ? null
    : selectionKey(
        line.kind === "add" ? "add" : "delete",
        line.kind === "add" ? line.newNo : line.oldNo
      );

/** A sweep in progress: where the press landed, the row the pointer is over
 *  now, and what the gesture is doing.
 *
 *  Intent is fixed at press — pressing an unticked line takes the run,
 *  pressing a ticked one clears it — rather than being re-decided per row.
 *  A sweep that re-decided would invert whatever it crossed and leave a
 *  striped selection behind, which is never what a drag across ten lines
 *  means. */
type Sweep = {
  from: string;
  to: string;
  adding: boolean;
  /** The painted line list this sweep was drawn against. `orderedIds` is
   *  memoized on the parsed hunks, so a diff that refreshes mid-drag hands
   *  back a different array — and a run resolved against THAT list is not the
   *  run the preview showed. Identity is the whole check. */
  order: readonly string[];
};

/** What a sweep would do if it ended now — the rows it covers and the single
 *  intent it carries. One value, because the ids are meaningless without the
 *  intent and a separate flag can only be read wrongly. */
type SweepPreview = { ids: ReadonlySet<string>; adding: boolean };

/** The columns a press must NOT start a gesture on. Everything else in the row
 *  is the target — a 24px lane is a poor one, and the gutter cells around it
 *  were already the target before the lanes existed.
 *
 *  Naming the target positively does not work. A row's grid items are
 *  baseline-aligned, so a cell with no content has no height — an added row's
 *  old-line cell, like a deleted row's new-line cell, is exactly that — and a
 *  rule written as "hit .diff-lane" silently loses its target on the rows that
 *  carry the changes. The code column stays selectable text; the blame gutter
 *  is its own button, and a press that both opened blame and started a sweep
 *  would do two things the user asked for once. */
const NOT_A_PRESS = ".diff-text, .diff-gutter--blame";

/** The inclusive slice of `order` between two IDs, in painted order however
 *  the gesture ran — a sweep upward selects the same run as the same sweep
 *  downward. */
const runBetween = (
  order: readonly string[],
  from: string,
  to: string
): string[] => {
  const a = order.indexOf(from);
  const b = order.indexOf(to);
  if (a === -1 || b === -1) return [];
  return order.slice(Math.min(a, b), Math.max(a, b) + 1);
};

function DiffFileView({
  file,
  images,
  selection,
  onMenu,
  onBlameFrom,
  onOpenImage
}: {
  file: DiffFile;
  images: ImageDiffRevisions | undefined;
  selection: DiffSelectionControls | undefined;
  onMenu?: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onBlameFrom?: (path: string, line: number) => void;
  onOpenImage?: (item: SideKey, states: SideStates) => void;
}) {
  const name =
    file.status === "renamed" && file.oldPath !== undefined
      ? `${file.oldPath} → ${file.path}`
      : file.path;

  const byCoordinate = useMemo(() => {
    const map = new Map<string, LineMeta>();
    for (const sourceHunk of selection?.hunks ?? []) {
      for (const line of sourceHunk.lines) {
        map.set(
          selectionKey(
            line.kind,
            line.kind === "add" ? line.newLine : line.oldLine
          ),
          { ...line, lineSelection: sourceHunk.lineSelection }
        );
      }
    }
    return map;
  }, [selection?.hunks]);

  // Every tickable ID in the order it is painted. A sweep or a shift-click is
  // a slice of this list, so a run picked out by eye matches the one applied —
  // including across a hunk boundary.
  const orderedIds = useMemo(() => {
    const ids: string[] = [];
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        const coordinate = coordinateOf(line);
        if (coordinate === null) continue;
        const meta = byCoordinate.get(coordinate);
        if (meta !== undefined && meta.lineSelection) ids.push(meta.id);
      }
    }
    return ids;
  }, [file.hunks, byCoordinate]);

  // Lead of the last gesture, so the next shift-click knows where to start.
  const anchor = useRef<string | null>(null);
  // The sweep is held in a ref AND in state: the ref is what the gesture
  // reads, so press → extend → release is correct however React schedules the
  // renders between them (a click fast enough to beat a commit still lands);
  // the state is only what paints the preview.
  const sweepRef = useRef<Sweep | null>(null);
  const [sweep, setSweep] = useState<Sweep | null>(null);
  const setGesture = (next: Sweep | null): void => {
    sweepRef.current = next;
    setSweep(next);
  };

  // What the sweep would take if it ended now. Held here rather than pushed
  // into the pane's selection on every row: an uncommitted sweep must be
  // abandonable, and repainting one file beats repainting the pane — bar,
  // counter and all — sixty times across a ten-line drag.
  const preview = useMemo<SweepPreview | null>(
    () =>
      sweep === null
        ? null
        : {
            ids: new Set(runBetween(orderedIds, sweep.from, sweep.to)),
            adding: sweep.adding
          },
    [sweep, orderedIds]
  );

  // The list and the callback the release will need, mirrored after every
  // commit. Neither changes mid-gesture — only a new patch moves them — so
  // reading the last committed pair is reading the right one.
  const latest = useRef({ orderedIds, selection });
  useEffect(() => {
    latest.current = { orderedIds, selection };
  });

  // The gesture ends wherever the button comes up, including outside the
  // window — a sweep that ran off the bottom of a long diff still commits
  // what it crossed rather than sticking in the pressed state forever.
  // Registered once, for the life of the file view: an effect that installed
  // it per sweep would not be listening until React flushed the press.
  useEffect(() => {
    const commit = (): void => {
      const gesture = sweepRef.current;
      const { orderedIds: order, selection: controls } = latest.current;
      if (gesture === null || controls === undefined) return;
      setGesture(null);
      // The diff moved under the drag. Committing now would resolve the run
      // against line positions the user never saw previewed, so drop it and
      // let them draw it again on what is actually on screen.
      if (gesture.order !== order) return;
      const run = runBetween(order, gesture.from, gesture.to);
      if (run.length === 0) return;
      controls.onToggleLine(run, gesture.adding ? "check" : "uncheck");
      anchor.current = gesture.to;
    };
    window.addEventListener("mouseup", commit);
    return () => window.removeEventListener("mouseup", commit);
    // Deliberately empty: `commit` reads everything it needs through refs, so
    // it never goes stale and never needs re-registering.
  }, []);

  /** Press on a line's lane. Shift keeps its old meaning — extend from the
   *  anchor, following the anchor's state — and deliberately does NOT begin a
   *  sweep: the two gestures would fight over the same button-down. */
  const press = (id: string, shiftKey: boolean): void => {
    if (selection === undefined || selection.applying) return;
    const from = anchor.current;
    if (shiftKey && from !== null) {
      const run = runBetween(orderedIds, from, id);
      if (run.length > 0) {
        selection.onToggleLine(
          run,
          selection.selectedIds.has(from) ? "check" : "uncheck"
        );
        return;
      }
    }
    anchor.current = id;
    setGesture({
      from: id,
      to: id,
      adding: !selection.selectedIds.has(id),
      order: orderedIds
    });
  };

  /** Extend the run to this row. `held` is the event's button state: a mouseup
   *  the window never saw — swallowed by a native menu, or by focus leaving
   *  mid-drag — would otherwise leave the sweep live, and every later hover
   *  would keep growing a run the user is no longer drawing. */
  const extend = (id: string, held: boolean): void => {
    const current = sweepRef.current;
    if (current === null) return;
    if (!held) {
      setGesture(null);
      return;
    }
    if (current.to === id) return;
    setGesture({ ...current, to: id });
  };

  /** Keyboard activation of a line's + button. The pointer path runs through
   *  press/commit instead, so this fires only for Enter and Space, which
   *  report no press position. */
  const activate = (id: string): void => {
    if (selection === undefined || selection.applying) return;
    anchor.current = id;
    selection.onToggleLine([id]);
  };

  return (
    <div className="diff-file">
      <div className="diff-file__head">
        <span className={`diff-file__status diff-file__status--${file.status}`}>
          {STATUS_LABEL[file.status]}
        </span>
        <span className="diff-file__path" title={file.path}>
          {name}
        </span>
        <span style={{ flex: 1 }} />
        <DiffStat additions={file.additions} deletions={file.deletions} />
        {onMenu !== undefined && (
          <button
            className="diff-file__menu"
            onClick={onMenu}
            aria-label={`Actions for ${file.path}`}
            title="File actions"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <circle cx="12" cy="5" r="1.6" />
              <circle cx="12" cy="12" r="1.6" />
              <circle cx="12" cy="19" r="1.6" />
            </svg>
          </button>
        )}
      </div>

      {file.binary ? (
        images !== undefined && imageMediaType(file.path) !== null ? (
          <ImageDiff
            file={file}
            revisions={images}
            {...(onOpenImage === undefined ? {} : { onOpen: onOpenImage })}
          />
        ) : (
          <div className="diff-binary">Binary file — no preview.</div>
        )
      ) : (
        file.hunks.map((hunk, hi) => (
          <DiffHunkView
            key={hi}
            hunk={hunk}
            filePath={file.path}
            {...(onBlameFrom === undefined ? {} : { onBlameFrom })}
            selection={selection}
            byCoordinate={byCoordinate}
            preview={preview}
            onPress={press}
            onExtend={extend}
            onActivate={activate}
            onAnchor={(id) => {
              anchor.current = id;
            }}
          />
        ))
      )}
    </div>
  );
}

function DiffHunkView({
  hunk,
  filePath,
  selection,
  byCoordinate,
  preview,
  onPress,
  onExtend,
  onActivate,
  onAnchor,
  onBlameFrom
}: {
  hunk: DiffFile["hunks"][number];
  filePath: string;
  selection: DiffSelectionControls | undefined;
  byCoordinate: Map<string, LineMeta>;
  preview: SweepPreview | null;
  onPress: (id: string, shiftKey: boolean) => void;
  onExtend: (id: string, held: boolean) => void;
  onActivate: (id: string) => void;
  onAnchor: (id: string) => void;
  onBlameFrom?: (path: string, line: number) => void;
}) {
  const metaFor = (line: DiffLine): LineMeta | undefined => {
    const coordinate = coordinateOf(line);
    return coordinate === null ? undefined : byCoordinate.get(coordinate);
  };

  // Everything this hunk's button moves — including EOF-bound lines that
  // carry no control of their own, which is the reason the button has to
  // exist.
  const hunkLines = hunk.lines.flatMap((line) => {
    const meta = metaFor(line);
    return meta === undefined ? [] : [meta];
  });
  const tickable = hunkLines.filter((line) => line.lineSelection);
  const isTicked = (id: string): boolean =>
    selection?.selectedIds.has(id) === true;
  // What the lane shows: the committed selection with an in-flight sweep laid
  // over it, so the rail and the chip answer the drag as it crosses them
  // rather than waiting for the button to come up.
  const shown = (id: string): boolean =>
    preview?.ids.has(id) === true ? preview.adding : isTicked(id);
  const shownCount = tickable.filter((line) => shown(line.id)).length;
  const shownAll = tickable.length > 0 && shownCount === tickable.length;
  // The chip's own action reads committed state only. A sweep is always
  // finished before a click can land, but a rail state that included a
  // preview would make the button's meaning depend on a hover.
  const committedAll =
    tickable.length > 0 && tickable.every((line) => isTicked(line.id));
  const railState = shownAll ? "full" : shownCount > 0 ? "part" : "idle";
  const verb = selection?.staged === true ? "Unstage" : "Stage";

  const toggleHunk = (): void => {
    if (selection === undefined) return;
    selection.onToggleLine(
      tickable.map((line) => line.id),
      committedAll ? "uncheck" : "check"
    );
    // Re-seat the anchor inside this hunk. Left where it was, the next
    // shift-click would sweep from whatever row was ticked last — possibly
    // hunks away — and take a run the user never indicated.
    const last = tickable.at(-1);
    if (last !== undefined) onAnchor(last.id);
  };

  const selectable = selection !== undefined;
  return (
    <div className="diff-hunk">
      <div
        className={`diff-hunk__header${selectable ? " diff-hunk__header--lanes" : ""}`}
      >
        {selectable && (
          <>
            <span className="diff-lane diff-lane--hunk">
              {tickable.length > 0 && (
                <button
                  className={`diff-hunk-chip${committedAll ? " is-on" : shownCount > 0 ? " is-part" : ""}`}
                  disabled={selection.applying}
                  onClick={toggleHunk}
                  aria-pressed={committedAll}
                  aria-label={`Select every changed line in hunk ${hunk.header}`}
                  title="Select every changed line in this hunk"
                >
                  {committedAll ? "✓" : "+"}
                </button>
              )}
            </span>
            <span className="diff-lane diff-lane--line" />
          </>
        )}
        <span className="diff-hunk__range">{hunk.header}</span>
        {selection !== undefined && hunkLines.length > 0 && (
          <button
            className="diff-hunk__action"
            disabled={selection.applying}
            onClick={() => selection.onApply(hunkLines.map((line) => line.id))}
            title={`${verb} all ${hunkLines.length} changed line${hunkLines.length === 1 ? "" : "s"} in this hunk — j / k move between hunks`}
          >
            {verb} hunk
          </button>
        )}
      </div>
      {hunk.lines.map((line, index) => {
        const meta = metaFor(line);
        const lineNo =
          line.kind === "add"
            ? line.newNo
            : line.kind === "del"
              ? line.oldNo
              : null;
        const isSelected = meta !== undefined && isTicked(meta.id);
        const inSweep = meta !== undefined && preview?.ids.has(meta.id) === true;
        // Drops while an apply is in flight, so the row stops advertising a
        // control it would ignore.
        const canTick =
          meta !== undefined &&
          meta.lineSelection &&
          selection !== undefined &&
          !selection.applying;
        const takeId = canTick && meta !== undefined ? meta.id : null;
        return (
          <div
            key={index}
            className={`diff-row diff-row--${line.kind}${isSelected ? " is-selected" : ""}${inSweep ? " is-sweeping" : ""}${canTick ? " is-tickable" : ""}`}
            {...(takeId === null
              ? {}
              : {
                  // The ROW is the target, not the 16px glyph and not the
                  // 24px lane holding it. A lane-only press is a fifth of the
                  // target this gutter had before the lanes existed, and a
                  // lane-only extend stops tracking the moment a downward
                  // drag drifts out of a 24px column — which is most of them.
                  onMouseDown: (event: MouseEvent<HTMLDivElement>) => {
                    if (event.button !== 0) return;
                    if ((event.target as Element).closest(NOT_A_PRESS)) return;
                    // Without this the press starts a text selection, and the
                    // sweep drags a highlight across the code.
                    event.preventDefault();
                    onPress(takeId, event.shiftKey);
                  },
                  // mouseover, not mouseenter: enter/leave are synthesized by
                  // React from delegated events, so a dispatched mouseenter
                  // never reaches the handler and the gesture is untestable.
                  // Bubbling is also what makes the whole row extend the run.
                  onMouseOver: (event: MouseEvent<HTMLDivElement>) =>
                    onExtend(takeId, event.buttons !== 0)
                })}
          >
            {selectable && (
              <>
                <span className="diff-lane diff-lane--hunk" aria-hidden="true">
                  <span className={`diff-rail diff-rail--${railState}`} />
                </span>
                <span className="diff-lane diff-lane--line">
                  {meta !== undefined &&
                    (meta.lineSelection ? (
                      <button
                        className={`diff-line-take${isSelected ? " is-on" : inSweep ? " is-ghost" : ""}`}
                        disabled={selection?.applying === true}
                        aria-pressed={isSelected}
                        aria-label={`Select ${meta.kind === "add" ? "added" : "deleted"} line ${lineNo ?? ""}`}
                        // Enter and Space only: a mouse click has already
                        // been handled by the press/release pair above, and
                        // running both would toggle the line twice.
                        onClick={(event) => {
                          if (event.detail === 0) onActivate(meta.id);
                        }}
                      >
                        {isSelected ? "−" : "+"}
                      </button>
                    ) : (
                      <span
                        className="diff-line-take diff-line-take--atomic"
                        title={ATOMIC_LINE_TITLE}
                        aria-label={ATOMIC_LINE_TITLE}
                        role="img"
                      >
                        ·
                      </span>
                    ))}
                </span>
              </>
            )}
            <span className="diff-gutter">
              {line.kind === "add" ? "" : line.oldNo}
            </span>
            {onBlameFrom !== undefined && line.kind !== "del" ? (
              // The union narrows: add and ctx rows both carry newNo.
              <button
                className="diff-gutter diff-gutter--blame"
                onClick={() => onBlameFrom(filePath, line.newNo)}
                title={`Blame from line ${line.newNo}`}
              >
                {line.newNo}
              </button>
            ) : (
              <span className="diff-gutter">
                {line.kind === "del" ? "" : line.newNo}
              </span>
            )}
            <span className="diff-sym">
              {line.kind === "add" ? "+" : line.kind === "del" ? "−" : ""}
            </span>
            <span className="diff-text">{line.text === "" ? " " : line.text}</span>
          </div>
        );
      })}
    </div>
  );
}
