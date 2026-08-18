import { useMemo } from "react";
import { imageMediaType } from "@pwrgit/shared";
import { DiffStat } from "./DiffStat";
import { ImageDiff, type ImageDiffRevisions } from "./ImageDiff";
import { type DiffFile, parseUnifiedDiff } from "./parse-diff";

const STATUS_LABEL: Record<DiffFile["status"], string> = {
  added: "added",
  deleted: "deleted",
  modified: "modified",
  renamed: "renamed"
};

/** Renders a raw unified-diff patch (one or many files). No syntax
 *  highlighting — added/removed/context rows in a line-numbered grid. */
export function DiffViewer({
  patch,
  emptyLabel,
  images
}: {
  patch: string;
  emptyLabel?: string;
  /** Revisions the patch compares; enables previews for binary image files. */
  images?: ImageDiffRevisions;
}) {
  const parsed = useMemo(() => parseUnifiedDiff(patch), [patch]);
  if (parsed.files.length === 0) {
    return <div className="diff-empty">{emptyLabel ?? "No changes."}</div>;
  }
  return (
    <div className="diff-view">
      {parsed.files.map((file, i) => (
        <DiffFileView key={`${file.path}-${i}`} file={file} images={images} />
      ))}
    </div>
  );
}

function DiffFileView({
  file,
  images
}: {
  file: DiffFile;
  images: ImageDiffRevisions | undefined;
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
          <div className="diff-hunk" key={hi}>
            <div className="diff-hunk__header">{hunk.header}</div>
            {hunk.lines.map((ln, li) => (
              <div key={li} className={`diff-row diff-row--${ln.kind}`}>
                <span className="diff-gutter">
                  {ln.kind === "add" ? "" : ln.oldNo}
                </span>
                <span className="diff-gutter">
                  {ln.kind === "del" ? "" : ln.newNo}
                </span>
                <span className="diff-sym">
                  {ln.kind === "add" ? "+" : ln.kind === "del" ? "−" : ""}
                </span>
                <span className="diff-text">{ln.text === "" ? " " : ln.text}</span>
              </div>
            ))}
          </div>
        ))
      )}
    </div>
  );
}
