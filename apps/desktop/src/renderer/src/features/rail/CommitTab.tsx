import { useEffect, useState } from "react";
import type { CommitFileChange } from "@pwrgit/shared";
import { fileStatusChipProps } from "../../lib/fileStatus";
import { dispatch } from "../../lib/pwrgit";

/**
 * Commit-scoped file list in the rail — the mirror of the Changes tab for a
 * commit you clicked in the lineage. Click a file → its diff (for THIS
 * commit) opens in the main pane; the full multi-file patch stays one click
 * away, never the default.
 */
export function CommitTab({
  worktreeId,
  hash,
  subject,
  onOpenFile,
  onOpenFullDiff,
  onClose
}: {
  worktreeId: string;
  hash: string;
  subject: string;
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

  return (
    <div className="changes-pane commit-tab">
      <div className="commit-tab__head">
        <button
          className="commit-tab__close"
          onClick={onClose}
          title="Back to working-tree changes"
        >
          ‹ Changes
        </button>
        <span className="commit-tab__hash">{hash.slice(0, 7)}</span>
        <span style={{ flex: 1 }} />
        <button
          className="commit-tab__full"
          onClick={onOpenFullDiff}
          title="Open the whole commit as one diff"
        >
          Full diff
        </button>
      </div>
      <div className="commit-tab__subject" title={subject}>
        {subject}
      </div>

      <div className="changes-list">
        {files === null && <div className="changes-section">Loading…</div>}
        {files !== null && (
          <>
            <div className="changes-section">
              Files · {files.length}
            </div>
            {files.map((f, i) => (
              <div
                key={`${i}-${f.path}`}
                className="file-row is-clickable"
                onClick={() => onOpenFile(f.path)}
                title="View this file's changes in the commit"
              >
                <span {...fileStatusChipProps(f.status)}>{f.status}</span>
                <span className="file-path" title={f.path}>
                  {f.path}
                </span>
              </div>
            ))}
            {files.length === 0 && (
              <div className="changes-section">No files (empty commit).</div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
