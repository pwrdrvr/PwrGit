import { useEffect, useState } from "react";
import { dispatch } from "../../lib/pwrgit";
import { DiffViewer } from "./DiffViewer";

export type DiffTarget =
  | { kind: "file"; path: string; staged: boolean }
  | { kind: "commit"; hash: string; subject: string };

/** Full-pane diff: fetches the patch for a working-tree file or a commit and
 *  renders it, with a header + a back-to-lineage control. */
export function DiffPane({
  worktreeId,
  target,
  onClose
}: {
  worktreeId: string;
  target: DiffTarget;
  onClose: () => void;
}) {
  const [patch, setPatch] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const key =
    target.kind === "file"
      ? `f:${target.path}:${target.staged}`
      : `c:${target.hash}`;

  useEffect(() => {
    let active = true;
    setLoading(true);
    setPatch(null);
    const req =
      target.kind === "file"
        ? dispatch("diff:file", {
            worktreeId,
            path: target.path,
            staged: target.staged
          })
        : dispatch("diff:commit", { worktreeId, hash: target.hash });
    void req.then((r) => {
      if (!active) return;
      setPatch(r.ok ? r.value : "");
      setLoading(false);
    });
    return () => {
      active = false;
    };
    // key encodes the target; re-fetch when it or the worktree changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worktreeId, key]);

  const title = target.kind === "file" ? target.path : target.subject;
  const sub =
    target.kind === "file"
      ? target.staged
        ? "staged change"
        : "working-tree change"
      : `commit ${target.hash}`;

  return (
    <div className="diff-pane">
      <div className="diff-pane__head">
        <button className="diff-pane__back" onClick={onClose}>
          ‹ Lineage
        </button>
        <span className="diff-pane__title" title={title}>
          {title}
        </span>
        <span style={{ flex: 1 }} />
        <span className="diff-pane__sub">{sub}</span>
      </div>
      <div className="diff-pane__body">
        {loading ? (
          <div className="diff-empty">Loading diff…</div>
        ) : (
          <DiffViewer
            patch={patch ?? ""}
            emptyLabel={
              target.kind === "commit"
                ? "This commit has no textual changes."
                : "No changes in this file."
            }
          />
        )}
      </div>
    </div>
  );
}
