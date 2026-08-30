import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject
} from "react";
import {
  imageMediaType,
  type PartialDiffHunk,
  type PartialDiffLine
} from "@pwrgit/shared";
import { ContextMenu, type MenuItem } from "../shell/ContextMenu";
import { DiffStat } from "./DiffStat";
import { ImageDiff, type ImageDiffRevisions } from "./ImageDiff";
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

/** The one column a click must NOT toggle on: everything left of the code is
 *  the tick target, and the code itself stays selectable text.
 *
 *  Naming the gutters positively does not work. A row's grid items are
 *  baseline-aligned, so a cell with no content has no height — and an added
 *  row's old-line cell, like a deleted row's new-line cell, is exactly that.
 *  Clicks across those 44px land on the row, not on the cell, so a rule
 *  written as "hit .diff-gutter" silently loses half its target on the very
 *  rows that carry the changes. Letting the row own everything but .diff-text
 *  has no such gaps. */
const CODE_COLUMN = ".diff-text";

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
  fileMenuItems
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
}) {
  const parsed = useMemo(() => parseUnifiedDiff(patch), [patch]);
  const [menu, setMenu] = useState<{ x: number; y: number; path: string } | null>(
    null
  );
  if (parsed.files.length === 0) {
    return <div className="diff-empty">{emptyLabel ?? "No changes."}</div>;
  }
  // Line coordinates are keyed by kind and line number with no file dimension,
  // so a selection snapshot only describes a single-file patch. `diff:fileSelection`
  // only ever returns one, but nothing in the prop's type says so — and handing
  // the same map to a second file would tick a row in the wrong one.
  const scoped = parsed.files.length === 1 ? selection : undefined;
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
          {...(fileMenuItems === undefined
            ? {}
            : {
                onMenu: (event: ReactMouseEvent) => {
                  const box = event.currentTarget.getBoundingClientRect();
                  setMenu({ x: box.right, y: box.bottom + 4, path: file.path });
                }
              })}
        />
      ))}
      {menu !== null && fileMenuItems !== undefined && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={`Actions for ${menu.path}`}
          onClose={() => setMenu(null)}
          items={fileMenuItems(menu.path)}
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

/** A checkbox React cannot express in JSX alone: `indeterminate` is a
 *  property, not an attribute, so the partial state has to be written to the
 *  node. The box itself is inert to the pointer (see `.diff-select input` in
 *  app.css) — the row owns the click so the whole gutter is one target and a
 *  shift-click can be read for its modifier. Keyboard activation still fires
 *  a click on the input, which reaches that same handler. */
function TickBox({
  checked,
  indeterminate,
  disabled,
  label,
  title
}: {
  checked: boolean;
  indeterminate: boolean;
  disabled: boolean;
  label: string;
  title?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current !== null) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      aria-label={label}
      {...(title === undefined ? {} : { title })}
      onChange={() => undefined}
    />
  );
}

/** How far the pointer may travel between press and release and still count
 *  as a click rather than a drag. A drag that starts in the code column and
 *  releases over the gutter reports its click on the row, and reading that as
 *  a tick would throw the selection away and check a line nobody aimed at.
 *  Measuring the gesture is what separates the two — asking whether anything
 *  on the page is selected would also block every tick made while an
 *  unrelated selection happens to be sitting there. */
const DRAG_SLOP_PX = 4;

function DiffFileView({
  file,
  images,
  selection,
  onMenu
}: {
  file: DiffFile;
  images: ImageDiffRevisions | undefined;
  selection: DiffSelectionControls | undefined;
  onMenu?: (event: ReactMouseEvent<HTMLButtonElement>) => void;
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

  // Every tickable ID in the order it is painted. A shift-click range is a
  // slice of this list, so a run picked out by eye matches the one applied —
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

  // Lead of the last tick, so the next shift-click knows where to start.
  const anchor = useRef<string | null>(null);
  // Where the pointer went down, to tell a click from a drag on release.
  const pressedAt = useRef<{ x: number; y: number } | null>(null);
  const toggle = (id: string, shiftKey: boolean): void => {
    if (selection === undefined) return;
    const from = anchor.current;
    const start = from === null ? -1 : orderedIds.indexOf(from);
    const end = orderedIds.indexOf(id);
    if (!shiftKey || start === -1 || end === -1 || from === null) {
      anchor.current = id;
      selection.onToggleLine([id]);
      return;
    }
    // The run follows the anchor's CURRENT state: extending from a ticked
    // line ticks the span, extending from a just-unticked line clears it —
    // the same rule every checkbox list follows. The anchor itself is in the
    // run and keeps its state.
    const run = orderedIds.slice(Math.min(start, end), Math.max(start, end) + 1);
    selection.onToggleLine(
      run,
      selection.selectedIds.has(from) ? "check" : "uncheck"
    );
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
          <ImageDiff file={file} revisions={images} />
        ) : (
          <div className="diff-binary">Binary file — no preview.</div>
        )
      ) : (
        file.hunks.map((hunk, hi) => (
          <DiffHunkView
            key={hi}
            hunk={hunk}
            selection={selection}
            byCoordinate={byCoordinate}
            pressedAt={pressedAt}
            onToggle={toggle}
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
  selection,
  byCoordinate,
  pressedAt,
  onToggle,
  onAnchor
}: {
  hunk: DiffFile["hunks"][number];
  selection: DiffSelectionControls | undefined;
  byCoordinate: Map<string, LineMeta>;
  pressedAt: RefObject<{ x: number; y: number } | null>;
  onToggle: (id: string, shiftKey: boolean) => void;
  onAnchor: (id: string) => void;
}) {
  const metaFor = (line: DiffLine): LineMeta | undefined => {
    const coordinate = coordinateOf(line);
    return coordinate === null ? undefined : byCoordinate.get(coordinate);
  };

  // Everything this hunk's button moves — including EOF-bound lines that
  // carry no tick of their own, which is the reason the button has to exist.
  const hunkLines = hunk.lines.flatMap((line) => {
    const meta = metaFor(line);
    return meta === undefined ? [] : [meta];
  });
  const tickable = hunkLines.filter((line) => line.lineSelection);
  const checked = tickable.filter((line) => selection?.selectedIds.has(line.id));
  const allChecked = tickable.length > 0 && checked.length === tickable.length;
  const verb = selection?.staged === true ? "Unstage" : "Stage";

  const toggleHunk = (): void => {
    if (selection === undefined) return;
    selection.onToggleLine(
      tickable.map((line) => line.id),
      allChecked ? "uncheck" : "check"
    );
    // Re-seat the anchor inside this hunk. Left where it was, the next
    // shift-click would sweep from whatever row was ticked last — possibly
    // hunks away — and take a run the user never indicated.
    const last = tickable.at(-1);
    if (last !== undefined) onAnchor(last.id);
  };

  return (
    <div className="diff-hunk">
      <div className="diff-hunk__header">
        {selection !== undefined && tickable.length > 0 && (
          <span
            className={`diff-select diff-select--hunk${selection.applying ? "" : " is-tickable"}`}
            {...(selection.applying ? {} : { onClick: toggleHunk })}
          >
            <TickBox
              checked={allChecked}
              indeterminate={checked.length > 0 && !allChecked}
              disabled={selection.applying}
              label={`Select every changed line in hunk ${hunk.header}`}
              title="Select every changed line in this hunk"
            />
          </span>
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
        const isSelected =
          meta !== undefined && selection?.selectedIds.has(meta.id) === true;
        // Drops while an apply is in flight, so the row stops advertising a
        // click it would ignore.
        const canTick =
          meta !== undefined &&
          meta.lineSelection &&
          selection !== undefined &&
          !selection.applying;
        const onRowClick =
          canTick && meta !== undefined
            ? (event: MouseEvent<HTMLDivElement>): void => {
                if ((event.target as Element).closest(CODE_COLUMN)) return;
                // Only a gesture that actually travelled is a drag. Keyboard
                // activation reports no press position and is a click.
                const from = pressedAt.current;
                pressedAt.current = null;
                if (
                  event.detail !== 0 &&
                  from !== null &&
                  (Math.abs(event.clientX - from.x) > DRAG_SLOP_PX ||
                    Math.abs(event.clientY - from.y) > DRAG_SLOP_PX)
                ) {
                  return;
                }
                // The box is controlled; let React own its checked state.
                event.preventDefault();
                onToggle(meta.id, event.shiftKey);
              }
            : undefined;
        return (
          <div
            key={index}
            className={`diff-row diff-row--${line.kind}${isSelected ? " is-selected" : ""}${canTick ? " is-tickable" : ""}`}
            {...(onRowClick === undefined
              ? {}
              : {
                  onClick: onRowClick,
                  onMouseDown: (event: MouseEvent<HTMLDivElement>) => {
                    pressedAt.current = {
                      x: event.clientX,
                      y: event.clientY
                    };
                  }
                })}
          >
            {selection !== undefined && (
              <span className="diff-select">
                {meta !== undefined &&
                  (meta.lineSelection ? (
                    <TickBox
                      checked={isSelected}
                      indeterminate={false}
                      disabled={selection.applying}
                      label={`Select ${meta.kind === "add" ? "added" : "deleted"} line ${lineNo ?? ""}`}
                    />
                  ) : (
                    <TickBox
                      checked={false}
                      indeterminate={false}
                      disabled
                      label={ATOMIC_LINE_TITLE}
                      title={ATOMIC_LINE_TITLE}
                    />
                  ))}
              </span>
            )}
            <span className="diff-gutter">
              {line.kind === "add" ? "" : line.oldNo}
            </span>
            <span className="diff-gutter">
              {line.kind === "del" ? "" : line.newNo}
            </span>
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
