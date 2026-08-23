import { useEffect, useMemo, useRef, useState } from "react";
import type { PartialFileDiff } from "@pwrgit/shared";
import { dispatch, subscribe } from "../../lib/pwrgit";
import { showErrorToast } from "../../lib/toast";
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
  const [selectionDiff, setSelectionDiff] = useState<PartialFileDiff | null>(
    null
  );
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [applying, setApplying] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
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
    setSelectionDiff(null);
    setSelectedIds(new Set());
    const req =
      target.kind === "file"
        ? dispatch("diff:fileSelection", {
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
      if (!r.ok) {
        setPatch("");
      } else if (target.kind === "file") {
        const value = r.value as PartialFileDiff;
        setSelectionDiff(value);
        setPatch(value.patch);
      } else {
        setPatch(r.value as string);
      }
      setLoading(false);
    });
    return () => {
      active = false;
    };
    // key encodes the target; re-fetch when it or the worktree changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worktreeId, key, refreshVersion]);

  // Keep an open working-tree diff interoperable with stage/unstage actions in
  // the rail and with external Git clients. Every index move gets a fresh
  // fingerprint; any checked lines are intentionally cleared for re-review.
  useEffect(() => {
    if (target.kind !== "file") return;
    const refresh = (payload: { worktreeId: string }): void => {
      if (payload.worktreeId === worktreeId) {
        setRefreshVersion((version) => version + 1);
      }
    };
    const offChanges = subscribe("changes:changed", refresh);
    const offWorktree = subscribe("worktree:changed", refresh);
    return () => {
      offChanges();
      offWorktree();
    };
  }, [target.kind, worktreeId]);

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
        ? "staged · HEAD → index"
        : "unstaged · index → working tree"
      : target.kind === "commitFile"
        ? `in ${target.hash.slice(0, 7)} — ${target.subject}`
        : `commit ${target.hash}`;

  const toggleLine = (id: string): void => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const applyLines = (lineIds: string[]): void => {
    if (
      target.kind !== "file" ||
      selectionDiff === null ||
      lineIds.length === 0 ||
      applying
    ) {
      return;
    }
    setApplying(true);
    void dispatch("changes:applySelection", {
      worktreeId,
      path: target.path,
      staged: target.staged,
      fingerprint: selectionDiff.fingerprint,
      lineIds
    }).then((result) => {
      setApplying(false);
      setSelectedIds(new Set());
      if (!result.ok) {
        showErrorToast({
          title:
            result.error.code === "stale_diff"
              ? "Diff changed"
              : target.staged
                ? "Unstage selection failed"
                : "Stage selection failed",
          message: result.error.message,
          detail: target.path
        });
      }
    });
  };

  const selectionAvailable =
    target.kind === "file" && selectionDiff?.capability.available === true;
  const selectedCount = selectedIds.size;
  const selectionVerb =
    target.kind === "file" && target.staged ? "Unstage" : "Stage";

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
      {target.kind === "file" && selectionDiff !== null && (
        <div
          className={`diff-selection-bar${selectionAvailable ? "" : " diff-selection-bar--unavailable"}`}
          role="status"
        >
          {selectionDiff.capability.available ? (
            <>
              <span>
                Select changed lines, or use{" "}
                <strong>{selectionVerb} hunk</strong>.
              </span>
              <span className="diff-selection-bar__count">
                {selectedCount} selected
              </span>
              <button
                className="diff-selection-bar__apply"
                disabled={selectedCount === 0 || applying}
                onClick={() => applyLines([...selectedIds])}
              >
                {applying ? `${selectionVerb}…` : `${selectionVerb} selected`}
              </button>
            </>
          ) : (
            <>
              <strong>Whole file only.</strong>
              <span>{selectionDiff.capability.message}</span>
            </>
          )}
        </div>
      )}
      <div className="diff-pane__body">
        {loading ? (
          <div className="diff-empty">Loading diff…</div>
        ) : (
          <DiffViewer
            patch={patch ?? ""}
            images={images}
            {...(selectionAvailable && selectionDiff !== null
              ? {
                  selection: {
                    staged: target.kind === "file" && target.staged,
                    selectedIds,
                    applying,
                    hunks: selectionDiff.hunks,
                    onToggleLine: toggleLine,
                    onApply: applyLines
                  }
                }
              : {})}
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
