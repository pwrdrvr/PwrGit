import { useEffect, useMemo, useState } from "react";
import { dispatch } from "../../lib/pwrgit";
import { DiffViewer } from "./DiffViewer";
import type { ImageDiffRevisions } from "./ImageDiff";

export type DiffTarget =
  | { kind: "file"; path: string; staged: boolean }
  | { kind: "commit"; hash: string; subject: string }
  | { kind: "commitFile"; hash: string; path: string; subject: string };

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
      : target.kind === "commitFile"
        ? `cf:${target.hash}:${target.path}`
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
        : target.kind === "commitFile"
          ? dispatch("diff:commitFile", {
              worktreeId,
              hash: target.hash,
              path: target.path
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

  // Binary image files carry no patch text, so the viewer needs to know which
  // two revisions this diff compares in order to fetch the bytes itself.
  const images: ImageDiffRevisions = useMemo(
    () =>
      target.kind === "file"
        ? {
            worktreeId,
            before: target.staged ? { kind: "head" } : { kind: "index" },
            after: target.staged ? { kind: "index" } : { kind: "worktree" }
          }
        : {
            worktreeId,
            before: { kind: "commitParent", hash: target.hash },
            after: { kind: "commit", hash: target.hash }
          },
    // Same target identity the patch fetch keys on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [worktreeId, key]
  );

  const title =
    target.kind === "file" || target.kind === "commitFile"
      ? target.path
      : target.subject;
  const sub =
    target.kind === "file"
      ? target.staged
        ? "staged change"
        : "working-tree change"
      : target.kind === "commitFile"
        ? `in ${target.hash.slice(0, 7)} — ${target.subject}`
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
            images={images}
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
