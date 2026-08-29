import { useEffect, useMemo, useRef, type MouseEvent } from "react";
import {
  imageMediaType,
  type PartialDiffHunk,
  type PartialDiffLine
} from "@pwrgit/shared";
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
  /** One call per gesture: a plain click sends one ID, a shift-click sends
   *  the whole run it spans. The lead ID is first — the pane follows its
   *  check state for the rest, so a range never half-clears. */
  onToggleLine: (ids: string[]) => void;
  onApply: (lineIds: string[]) => void;
};

/** Renders a raw unified-diff patch (one or many files). No syntax
 *  highlighting — added/removed/context rows in a line-numbered grid. */
export function DiffViewer({
  patch,
  emptyLabel,
  images,
  selection
}: {
  patch: string;
  emptyLabel?: string;
  /** Revisions the patch compares; enables previews for binary image files. */
  images?: ImageDiffRevisions;
  /** Typed line IDs from the main process. Present only for a selectable
   * working-tree patch; commit and protected file kinds remain read-only. */
  selection?: DiffSelectionControls;
}) {
  const parsed = useMemo(() => parseUnifiedDiff(patch), [patch]);
  if (parsed.files.length === 0) {
    return <div className="diff-empty">{emptyLabel ?? "No changes."}</div>;
  }
  return (
    <div
      className={`diff-view${selection === undefined ? "" : " diff-view--selectable"}`}
    >
      {parsed.files.map((file, i) => (
        <DiffFileView
          key={`${file.path}-${i}`}
          file={file}
          images={images}
          selection={selection}
        />
      ))}
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

function DiffFileView({
  file,
  images,
  selection
}: {
  file: DiffFile;
  images: ImageDiffRevisions | undefined;
  selection: DiffSelectionControls | undefined;
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
    // The anchor stays the lead, so extending a checked run checks the rest
    // of it rather than inverting each row it passes over.
    const run = orderedIds.slice(Math.min(start, end), Math.max(start, end) + 1);
    selection.onToggleLine([from, ...run.filter((each) => each !== from)]);
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
            onToggle={toggle}
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
  onToggle
}: {
  hunk: DiffFile["hunks"][number];
  selection: DiffSelectionControls | undefined;
  byCoordinate: Map<string, LineMeta>;
  onToggle: (id: string, shiftKey: boolean) => void;
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
    // Lead with a row whose state is about to flip, so the pane's
    // follow-the-lead rule drives the rest the same way.
    selection.onToggleLine(
      allChecked
        ? tickable.map((line) => line.id)
        : [
            ...tickable
              .filter((line) => !selection.selectedIds.has(line.id))
              .map((line) => line.id),
            ...checked.map((line) => line.id)
          ]
    );
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
                // A drag that selected code and released over the gutter still
                // reports a click on the row. Reading it as a tick would throw
                // the selection away and check a line nobody aimed at.
                if ((window.getSelection()?.toString() ?? "") !== "") return;
                // The box is controlled; let React own its checked state.
                event.preventDefault();
                onToggle(meta.id, event.shiftKey);
              }
            : undefined;
        return (
          <div
            key={index}
            className={`diff-row diff-row--${line.kind}${isSelected ? " is-selected" : ""}${canTick ? " is-tickable" : ""}`}
            {...(onRowClick === undefined ? {} : { onClick: onRowClick })}
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
