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

/** Checked line IDs, bound to the fingerprint they were chosen against.
 *  Line IDs are positional (`h:<i>:<oldStart>:<newStart>:a|d:<n>`), so the
 *  same ID names a different line as soon as the diff moves. Carrying the
 *  fingerprint alongside is what lets a refresh tell "same diff, keep the
 *  ticks" apart from "the file moved, these coordinates mean something else
 *  now" — the difference between a refresh nobody notices and one that
 *  quietly stages the wrong line. */
type LineSelection = { fingerprint: string; ids: ReadonlySet<string> };

const NO_SELECTION: LineSelection = { fingerprint: "", ids: new Set() };

/** Full-pane diff: fetches the patch for a working-tree file or a commit and
 *  renders it, with a header + a close control that returns to the graph. */
export function DiffPane({
  worktreeId,
  target,
  onOpenFile,
  onClose
}: {
  worktreeId: string;
  target: DiffTarget;
  /** Point the pane at the other side of the index for the same path. The
   *  rail lists a partially staged file twice; without this the only route
   *  between the two halves is closing the diff and finding its twin. */
  onOpenFile: (path: string, staged: boolean) => void;
  onClose: () => void;
}) {
  const [patch, setPatch] = useState<string | null>(null);
  const [selectionDiff, setSelectionDiff] = useState<PartialFileDiff | null>(
    null
  );
  const [selection, setSelection] = useState<LineSelection>(NO_SELECTION);
  const [applying, setApplying] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const paneRef = useRef<HTMLDivElement>(null);

  const key =
    target.kind === "file"
      ? `f:${target.path}:${target.staged}`
      : target.kind === "commitFile"
        ? `cf:${target.hash}:${target.path}`
        : `c:${target.hash}`;

  // A refresh replaces the diff in place. Only pointing the pane at a new
  // target clears what is on screen, so an index move — ours or an external
  // client's — never blanks the body the user is reading. `key` is in the
  // dependency list, so this runs before the fetch effect below on a retarget.
  const shownKey = useRef<string | null>(null);
  if (shownKey.current !== key) {
    shownKey.current = key;
    if (patch !== null) setPatch(null);
    if (selectionDiff !== null) setSelectionDiff(null);
    if (selection !== NO_SELECTION) setSelection(NO_SELECTION);
  }

  useEffect(() => {
    let active = true;
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
        setSelectionDiff(null);
      } else if (target.kind === "file") {
        const value = r.value as PartialFileDiff;
        setSelectionDiff(value);
        setPatch(value.patch);
      } else {
        setPatch(r.value as string);
      }
    });
    return () => {
      active = false;
    };
    // key encodes the target; re-fetch when it or the worktree changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worktreeId, key, refreshVersion]);

  // Keep an open working-tree diff interoperable with stage/unstage actions in
  // the rail and with external Git clients. The watcher behind these events
  // fingerprints the whole worktree, so it fires for edits to files this pane
  // is not showing; the refetch is cheap and the fingerprint comparison below
  // decides whether anything the user chose is actually affected.
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
  // The side's name moves into the tabs below; what is left here is the part
  // the tabs cannot say — which two revisions this view is comparing.
  const sub =
    target.kind === "file"
      ? target.staged
        ? "HEAD → index"
        : "index → working tree"
      : target.kind === "commitFile"
        ? `in ${target.hash.slice(0, 7)} — ${target.subject}`
        : `commit ${target.hash}`;

  const fingerprint = selectionDiff?.fingerprint ?? "";
  // Ticks survive a refresh that left this file's diff byte-identical, and
  // only that. The fingerprint covers this path's own patch and status, so an
  // unrelated file's edit — the common case for a worktree-wide watcher —
  // reads as "same diff" and costs the user nothing.
  const selectedIds =
    selection.fingerprint === fingerprint ? selection.ids : new Set<string>();
  const selectionDropped =
    selection.ids.size > 0 && selection.fingerprint !== fingerprint;

  const toggleLine = (ids: string[]): void => {
    setSelection((current) => {
      const next = new Set(
        current.fingerprint === fingerprint ? current.ids : []
      );
      // A multi-line range follows the lead line: if it is being checked, the
      // whole range is checked, so a shift-click never half-clears a span.
      const first = ids[0];
      if (first === undefined) return current;
      const checking = !next.has(first);
      for (const id of ids) {
        if (checking) next.add(id);
        else next.delete(id);
      }
      return { fingerprint, ids: next };
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
      setSelection(NO_SELECTION);
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

  const applyFile = (): void => {
    if (target.kind !== "file" || applying) return;
    setApplying(true);
    void dispatch(target.staged ? "changes:unstage" : "changes:stage", {
      worktreeId,
      paths: [target.path]
    }).then((result) => {
      setApplying(false);
      setSelection(NO_SELECTION);
      if (!result.ok) {
        showErrorToast({
          title: target.staged ? "Unstage failed" : "Stage failed",
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
  const capability = selectionDiff?.capability;
  // "No changes on this side" is the ordinary end of the staging loop, not a
  // limitation — the reader just moved the last hunk across. It gets its own
  // bar, pointing at where the changes went.
  const settled =
    capability !== undefined &&
    !capability.available &&
    capability.reason === "no_changes";
  const counterpart = selectionDiff?.counterpartChanges === true;
  const otherSide = target.kind === "file" && target.staged;
  const otherSideName = otherSide ? "unstaged" : "staged";
  const showOtherSide = (): void => {
    if (target.kind === "file") onOpenFile(target.path, !target.staged);
  };

  return (
    <div className="diff-pane" ref={paneRef} tabIndex={-1}>
      <div className="diff-pane__head">
        <span className="diff-pane__title" title={title}>
          {title}
        </span>
        <span style={{ flex: 1 }} />
        {target.kind === "file" && (
          <span
            className="diff-side"
            role="group"
            aria-label="Side of the index to show"
          >
            {([false, true] as const).map((staged) => (
              <button
                key={String(staged)}
                className={`diff-side__tab${target.staged === staged ? " is-active" : ""}`}
                aria-pressed={target.staged === staged}
                onClick={() => onOpenFile(target.path, staged)}
                title={
                  staged
                    ? "Staged for the next commit (HEAD → index)"
                    : "Not yet staged (index → working tree)"
                }
              >
                {staged ? "Staged" : "Unstaged"}
                {target.staged !== staged && counterpart && (
                  <span className="diff-side__dot" aria-hidden="true" />
                )}
              </button>
            ))}
          </span>
        )}
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
          className={`diff-selection-bar${settled ? " diff-selection-bar--settled" : selectionAvailable ? "" : " diff-selection-bar--unavailable"}`}
        >
          {settled ? (
            <>
              <strong>
                Nothing to {selectionVerb.toLowerCase()} here.
              </strong>
              <span>
                {counterpart
                  ? `Every change to this file is ${otherSideName}.`
                  : "This file has no changes left."}
              </span>
              {counterpart && (
                <button
                  className="diff-selection-bar__apply"
                  onClick={showOtherSide}
                >
                  View {otherSideName} changes
                </button>
              )}
            </>
          ) : (
            <>
              {/* Whole-file staging lives here too. Reviewing a file and
                  deciding to take all of it is the commonest way this pane
                  ends, and sending the reader back to the rail to do it is
                  the close-and-reopen loop this bar exists to remove. */}
              <button
                className="diff-selection-bar__file"
                disabled={applying}
                onClick={applyFile}
                title={`${selectionVerb} every change to this file`}
              >
                {selectionVerb} file
              </button>
              {selectionDiff.capability.available ? (
                <>
                  <button
                    className="diff-selection-bar__apply"
                    disabled={selectedCount === 0 || applying}
                    onClick={() => applyLines([...selectedIds])}
                  >
                    {applying
                      ? `${selectionVerb}…`
                      : selectedCount === 0
                        ? `${selectionVerb} selected`
                        : `${selectionVerb} ${selectedCount} line${selectedCount === 1 ? "" : "s"}`}
                  </button>
                  <span className="diff-selection-bar__hint">
                    Click a line’s gutter to pick it, shift-click for a run, or
                    use <strong>{selectionVerb} hunk</strong>.
                  </span>
                  <span className="diff-selection-bar__count" role="status">
                    {selectedCount > 0 ? `${selectedCount} selected` : ""}
                  </span>
                </>
              ) : (
                <span className="diff-selection-bar__hint">
                  <strong>Whole file only.</strong>{" "}
                  {selectionDiff.capability.message}
                </span>
              )}
            </>
          )}
        </div>
      )}
      {selectionDropped && (
        <div className="diff-stale-notice" role="status">
          This file changed, so the lines you had ticked were cleared — their
          positions no longer describe the same edit.
        </div>
      )}
      <div className="diff-pane__body">
        {patch === null ? (
          <div className="diff-empty">Loading diff…</div>
        ) : (
          <DiffViewer
            patch={patch}
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
                : settled && counterpart
                  ? `All of this file’s changes are ${otherSideName}.`
                  : "No changes in this file."
            }
          />
        )}
      </div>
    </div>
  );
}
