import { useEffect, useMemo, useRef, useState } from "react";
import { dispatch } from "../../lib/pwrgit";
import { DiffViewer } from "./DiffViewer";
import type { ImageDiffRevisions } from "./ImageDiff";

export type DiffTarget =
  | { kind: "file"; path: string; staged: boolean }
  | { kind: "commit"; hash: string; subject: string }
  | { kind: "commitFile"; hash: string; path: string; subject: string };

/** Full-pane diff: fetches the patch for a working-tree file or a commit and
 *  renders it, with a header + a close control that returns to the graph. */
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
  const paneRef = useRef<HTMLDivElement>(null);

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

  // The pane takes focus when it opens and whenever it is pointed at a new
  // target, so Escape works right after the click that opened it — whether
  // that click landed on a non-focusable file row (focus would otherwise fall
  // to <body>) or on the commit tab's "Full diff" button (which would keep
  // it). Escape is scoped to that focus: it closes the pane only while focus
  // is inside it, so a modal that has taken focus, or a rail control the user
  // is working in, keeps its own Escape. Overlays that leave focus where it
  // was (a hover tooltip) claim the key with preventDefault instead — and
  // since their window listeners are registered after this one, the check
  // is deferred a tick so the claim has been made by the time it is read.
  useEffect(() => {
    paneRef.current?.focus({ preventScroll: true });
  }, [key]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      const focused = document.activeElement;
      if (paneRef.current?.contains(focused) !== true) return;
      window.setTimeout(() => {
        if (!event.defaultPrevented) onClose();
      }, 0);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

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
    <div className="diff-pane" ref={paneRef} tabIndex={-1}>
      <div className="diff-pane__head">
        <span className="diff-pane__title" title={title}>
          {title}
        </span>
        <span style={{ flex: 1 }} />
        <span className="diff-pane__sub">{sub}</span>
        <button
          className="diff-pane__close"
          onClick={onClose}
          aria-label="Close"
          title="Close (Esc)"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
        </button>
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
