import { useEffect, useState } from "react";
import type { CommitFileChange } from "@pwrgit/shared";
import { fileStatusChipProps } from "../../lib/fileStatus";
import { dispatch } from "../../lib/pwrgit";
import {
  hoverTooltip,
  useViewportTooltip
} from "../../lib/useViewportTooltip";
import { fileLabel } from "../file-tree/file-tree";
import { TreeFolderRow, treeDepthStyle } from "../file-tree/TreeFolderRow";
import { useFileTree } from "../file-tree/useFileTree";

const NO_FILES: CommitFileChange[] = [];

/**
 * Commit-scoped file list in the rail — the mirror of the Changes tab for a
 * commit you clicked in the lineage. Click a file → its diff (for THIS
 * commit) opens in the main pane; the full multi-file patch stays one click
 * away, never the default. Files are drawn as the same folder tree as the
 * Changes tab.
 */
export function CommitTab({
  worktreeId,
  hash,
  subject,
  onOpenFile,
  onOpenFullDiff,
  onClose,
  view
}: {
  worktreeId: string;
  hash: string;
  subject: string;
  /** What the main pane is showing of THIS commit, so the list can say so. */
  view: { kind: "full" } | { kind: "file"; path: string } | null;
  onOpenFile: (path: string) => void;
  onOpenFullDiff: () => void;
  onClose: () => void;
}) {
  const [files, setFiles] = useState<CommitFileChange[] | null>(null);

  useEffect(() => {
    let active = true;
    setFiles(null);
    void dispatch("commit:files", { worktreeId, hash }).then((r) => {
      if (active && r.ok) setFiles(r.value);
    });
    return () => {
      active = false;
    };
  }, [worktreeId, hash]);

  const openPath = view?.kind === "file" ? view.path : null;
  const { rows, nested, toggle } = useFileTree(
    files ?? NO_FILES,
    `${worktreeId}:${hash}`,
    openPath
  );

  const tip = useViewportTooltip();
  return (
    <div className="changes-pane commit-tab">
      <div className="commit-tab__head">
        <button
          className="commit-tab__close"
          onClick={onClose}
          {...hoverTooltip(tip, "Back to working-tree changes")}
        >
          ‹ Changes
        </button>
        <span className="commit-tab__hash">{hash.slice(0, 7)}</span>
        <span style={{ flex: 1 }} />
        <button
          className={`commit-tab__full${
            view?.kind === "full" ? " is-active" : ""
          }`}
          {...(view?.kind === "full"
            ? { "aria-current": "true" as const }
            : {})}
          onClick={onOpenFullDiff}
          {...hoverTooltip(tip, "Open the whole commit as one diff")}
        >
          Full diff
        </button>
      </div>
      <div className="commit-tab__subject" {...hoverTooltip(tip, subject)}>
        {subject}
      </div>

      <div className="changes-list">
        {files === null && <div className="changes-section">Loading…</div>}
        {files !== null && (
          <>
            <div className="changes-section">
              Files · {files.length}
            </div>
            {rows.map((row) => {
              if (row.kind === "folder") {
                const { folder, open } = row;
                return (
                  <TreeFolderRow
                    key={`d-${folder.dir}`}
                    dir={folder.dir}
                    label={folder.label}
                    depth={row.depth}
                    count={folder.all.length}
                    open={open}
                    onToggleOpen={() => toggle(folder, open)}
                  />
                );
              }
              const f = row.file;
              const selected = openPath === f.path;
              return (
                <div
                  key={`f-${f.path}`}
                  className={`file-row is-clickable${nested ? " tree-file" : ""}${
                    selected ? " is-selected" : ""
                  }`}
                  style={nested ? treeDepthStyle(row.depth) : undefined}
                  {...(selected ? { "aria-current": "true" as const } : {})}
                  onClick={() => onOpenFile(f.path)}
                  {...hoverTooltip(tip, "View this file's changes in the commit")}
                >
                  <span {...fileStatusChipProps(f.status)}>{f.status}</span>
                  <span className="file-path" {...hoverTooltip(tip, f.path)}>
                    {fileLabel(f.path)}
                  </span>
                </div>
              );
            })}
            {files.length === 0 && (
              <div className="changes-section">No files (empty commit).</div>
            )}
          </>
        )}
      </div>
      {tip.tooltipNode}
    </div>
  );
}
