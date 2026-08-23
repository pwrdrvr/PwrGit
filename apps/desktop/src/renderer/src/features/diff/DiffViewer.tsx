import { useMemo } from "react";
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

export type DiffSelectionControls = {
  staged: boolean;
  selectedIds: ReadonlySet<string>;
  applying: boolean;
  hunks: PartialDiffHunk[];
  onToggleLine: (id: string) => void;
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
          />
        ))
      )}
    </div>
  );
}

const selectionKey = (
  kind: "add" | "delete",
  line: number | null
): string => `${kind}:${line ?? ""}`;

function DiffHunkView({
  hunk,
  selection
}: {
  hunk: DiffFile["hunks"][number];
  selection: DiffSelectionControls | undefined;
}) {
  const selectable = useMemo(() => {
    const byCoordinate = new Map<
      string,
      PartialDiffLine & { lineSelection: boolean }
    >();
    for (const sourceHunk of selection?.hunks ?? []) {
      for (const line of sourceHunk.lines) {
        byCoordinate.set(
          selectionKey(
            line.kind,
            line.kind === "add" ? line.newLine : line.oldLine
          ),
          { ...line, lineSelection: sourceHunk.lineSelection }
        );
      }
    }
    return byCoordinate;
  }, [selection?.hunks]);
  const hunkLines = hunk.lines.flatMap((line) => {
    if (line.kind === "ctx") return [];
    const metadata = selectable.get(
      selectionKey(
        line.kind === "add" ? "add" : "delete",
        line.kind === "add" ? line.newNo : line.oldNo
      )
    );
    return metadata === undefined ? [] : [metadata];
  });
  const verb = selection?.staged === true ? "Unstage" : "Stage";

  return (
    <div className="diff-hunk">
      <div className="diff-hunk__header">
        <span>{hunk.header}</span>
        {selection !== undefined && hunkLines.length > 0 && (
          <button
            className="diff-hunk__action"
            disabled={selection.applying}
            onClick={() => selection.onApply(hunkLines.map((line) => line.id))}
          >
            {verb} hunk
          </button>
        )}
      </div>
      {hunk.lines.map((line, index) => {
        const metadata =
          line.kind === "ctx"
            ? undefined
            : selectable.get(
                selectionKey(
                  line.kind === "add" ? "add" : "delete",
                  line.kind === "add" ? line.newNo : line.oldNo
                )
              );
        const lineNo =
          line.kind === "add"
            ? line.newNo
            : line.kind === "del"
              ? line.oldNo
              : null;
        return (
          <div key={index} className={`diff-row diff-row--${line.kind}`}>
            {selection !== undefined && (
              <span className="diff-select">
                {metadata !== undefined && metadata.lineSelection && (
                  <input
                    type="checkbox"
                    checked={selection.selectedIds.has(metadata.id)}
                    disabled={selection.applying}
                    onChange={() => selection.onToggleLine(metadata.id)}
                    aria-label={`Select ${metadata.kind === "add" ? "added" : "deleted"} line ${lineNo ?? ""}`}
                  />
                )}
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
