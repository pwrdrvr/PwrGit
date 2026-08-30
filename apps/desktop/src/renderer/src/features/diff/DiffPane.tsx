import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent
} from "react";
import type { FileInsightContext, PartialFileDiff } from "@pwrgit/shared";
import { dispatch, subscribe } from "../../lib/pwrgit";
import { showErrorToast } from "../../lib/toast";
import { DiffViewer } from "./DiffViewer";
import type { ImageDiffRevisions } from "./ImageDiff";
import type { FileInsightTab } from "./FileInsightsPane";

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

const HINT_SEEN_KEY = "pwrgit.diffHintSeen";

/** The gestures and keys the pane answers to — the ? button's card. Lists
 *  only what is wired today; a help card advertising a dead key teaches
 *  distrust of the whole card. */
const HELP_ROWS: { keys: string[]; label: string }[] = [
  { keys: ["click"], label: "tick a line — anywhere left of the code" },
  { keys: ["⇧", "click"], label: "extend the tick range" },
  { keys: ["j", "k"], label: "next / previous hunk" },
  { keys: ["⏎"], label: "stage or unstage the focused hunk" },
  { keys: ["esc"], label: "close the diff" }
];

/** Full-pane diff: fetches the patch for a working-tree file or a commit and
 *  renders it, with a header + a close control that returns to the graph. */
export function DiffPane({
  worktreeId,
  target,
  onOpenFile,
  hidden = false,
  onOpenFileInsight,
  onClose
}: {
  worktreeId: string;
  target: DiffTarget;
  /** Point the pane at the other side of the index for the same path. The
   *  rail lists a partially staged file twice; without this the only route
   *  between the two halves is closing the diff and finding its twin. */
  onOpenFile: (path: string, staged: boolean) => void;
  /** Kept mounted but out of view while file details are open, so coming back
   *  costs no refetch and keeps the reader's scroll position. */
  hidden?: boolean;
  onOpenFileInsight: (
    path: string,
    context: FileInsightContext,
    tab: FileInsightTab
  ) => void;
  onClose: () => void;
}) {
  const [patch, setPatch] = useState<string | null>(null);
  const [selectionDiff, setSelectionDiff] = useState<PartialFileDiff | null>(
    null
  );
  const [selection, setSelection] = useState<LineSelection>(NO_SELECTION);
  const [applying, setApplying] = useState(false);
  const [failed, setFailed] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  // The gesture hint teaches until the first selection lands, then yields its
  // 38px of bar to the ? button. Sticky across sessions: re-teaching a gesture
  // the user has already performed is noise.
  const [hintSeen, setHintSeen] = useState(
    () => window.localStorage.getItem(HINT_SEEN_KEY) === "1"
  );
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
  // client's — never blanks the body the user is reading.
  //
  // The previous key is held in state, not a ref: under the concurrent root a
  // render can be discarded and restarted, and state set during a discarded
  // render is rolled back with it while a mutated ref stays advanced. With a
  // ref, that restart sees "same key", skips the reset, and paints the last
  // file's patch and ticks under the new file's name.
  const [shownKey, setShownKey] = useState(key);
  if (shownKey !== key) {
    setShownKey(key);
    setPatch(null);
    setSelectionDiff(null);
    setSelection(NO_SELECTION);
    setFailed(false);
    setHelpOpen(false);
    // F9: every other piece of per-target state is cleared here; an apply left
    // in flight would otherwise render the newly opened side fully disabled.
    setApplying(false);
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
        // A failed read says nothing about the file. Keep the last good diff
        // and its ticks on screen and report the failure as a failure — the
        // alternative claimed the file was empty and that its lines had been
        // cleared because it changed, neither of which happened.
        setFailed(true);
        return;
      }
      setFailed(false);
      if (target.kind === "file") {
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
  // `hidden` is in the dependencies, not just `key`: file details render OVER
  // this pane rather than replacing it, so coming back changes neither the
  // target nor the key. Without it the pane stayed unfocused on return — the
  // insights pane had taken focus and then unmounted — and Escape, which is
  // scoped to focus being inside this pane, silently did nothing.
  useEffect(() => {
    if (hidden) return;
    paneRef.current?.focus({ preventScroll: true });
  }, [key, hidden]);
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
  // the tabs cannot say — which two revisions this view is comparing. Split
  // from the subject, which is unbounded context: joined, one long commit
  // subject pushed History, Blame and the close button off the right edge.
  const sub =
    target.kind === "file"
      ? target.staged
        ? "HEAD → index"
        : "index → working tree"
      : target.kind === "commitFile"
        ? `in ${target.hash.slice(0, 7)}`
        : `commit ${target.hash.slice(0, 7)}`;
  const subDetail = target.kind === "file" ? null : target.subject;
  // History and blame are per-file, so a whole-commit diff offers neither.
  // The path is read from the target, never from `title` — the two only
  // happen to agree today, and a title is for reading, not for dispatching.
  const filePath =
    target.kind === "file" || target.kind === "commitFile" ? target.path : null;
  const fileContext: FileInsightContext | null =
    target.kind === "file"
      ? { kind: "workingTree" }
      : target.kind === "commitFile"
        ? { kind: "commit", hash: target.hash }
        : null;

  const fingerprint = selectionDiff?.fingerprint ?? "";
  // Ticks survive a refresh that left this file's diff byte-identical, and
  // only that. The fingerprint covers this path's own patch and status, so an
  // unrelated file's edit — the common case for a worktree-wide watcher —
  // reads as "same diff" and costs the user nothing.
  const selectedIds =
    selection.fingerprint === fingerprint ? selection.ids : new Set<string>();
  const selectionDropped =
    selection.ids.size > 0 && selection.fingerprint !== fingerprint;

  const toggleLine = (ids: string[], op?: "check" | "uncheck"): void => {
    setSelection((current) => {
      const next = new Set(
        current.fingerprint === fingerprint ? current.ids : []
      );
      const first = ids[0];
      if (first === undefined) return current;
      // A lone click toggles its line; a range gesture arrives with explicit
      // intent, so a span is set as one thing and never half-inverts.
      const checking = op === undefined ? !next.has(first) : op === "check";
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
      if (result.ok && !hintSeen) {
        setHintSeen(true);
        window.localStorage.setItem(HINT_SEEN_KEY, "1");
      }
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

  // j / k walk the hunks and land on each one's action button, so the whole
  // staging loop is reachable without a pointer: j, Enter, j, Enter. Tabbing
  // is the alternative and it costs one stop per tick — a file with sixty
  // changed lines puts sixty stops between hunk one and hunk two.
  const onHunkNavigation = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape" && helpOpen) {
      // Claimed here so the window-level listener, which checks
      // defaultPrevented a tick later, leaves the pane itself open.
      event.preventDefault();
      setHelpOpen(false);
      return;
    }
    if (event.key !== "j" && event.key !== "k" && event.key !== "?") return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const from = document.activeElement;
    if (from instanceof HTMLElement && from.isContentEditable) return;
    // Checkboxes are the pane's only inputs and swallow no letters; a real
    // text field would, so leave one alone if this pane ever grows one.
    if (
      (from instanceof HTMLInputElement && from.type !== "checkbox") ||
      from instanceof HTMLTextAreaElement
    ) {
      return;
    }
    if (event.key === "?") {
      if (selectionAvailable) setHelpOpen((open) => !open);
      return;
    }
    const buttons = [
      ...(paneRef.current?.querySelectorAll<HTMLButtonElement>(
        ".diff-hunk__action"
      ) ?? [])
    ];
    if (buttons.length === 0) return;
    event.preventDefault();
    const hunk = from instanceof Element ? from.closest(".diff-hunk") : null;
    const here = buttons.findIndex(
      (button) => button.closest(".diff-hunk") === hunk
    );
    // The first press from inside a hunk claims that hunk rather than
    // skipping past it.
    const next =
      here !== -1 && !buttons.includes(from as HTMLButtonElement)
        ? here
        : event.key === "j"
          ? Math.min(here + 1, buttons.length - 1)
          : Math.max(here === -1 ? buttons.length - 1 : here - 1, 0);
    const button = buttons[next];
    button?.focus({ preventScroll: true });
    button?.closest(".diff-hunk")?.scrollIntoView({ block: "nearest" });
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
    <div
      className="diff-pane"
      ref={paneRef}
      tabIndex={-1}
      onKeyDown={onHunkNavigation}
      style={hidden ? { display: "none" } : undefined}
    >
      <div className="diff-pane__head">
        <span
          className={`diff-pane__title${
            target.kind === "commit" ? " diff-pane__title--text" : ""
          }`}
          title={title}
        >
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
        <span className="diff-pane__sub" title={target.kind === "file" ? undefined : target.hash}>
          {sub}
        </span>
        {subDetail !== null && (
          <span className="diff-pane__sub-detail" title={subDetail}>
            {subDetail}
          </span>
        )}
        {fileContext !== null && filePath !== null && (
          <div className="diff-pane__tools" aria-label="File details">
            <button
              onClick={() => onOpenFileInsight(filePath, fileContext, "history")}
            >
              History
            </button>
            <button
              onClick={() => onOpenFileInsight(filePath, fileContext, "blame")}
            >
              Blame
            </button>
          </div>
        )}
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
                  className="diff-selection-bar__file"
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
                  <button
                    className="diff-selection-bar__help"
                    aria-expanded={helpOpen}
                    aria-label="Gestures and keyboard shortcuts"
                    title="Gestures and keyboard shortcuts (?)"
                    onClick={() => setHelpOpen((open) => !open)}
                  >
                    ?
                  </button>
                  {!hintSeen && (
                    <span className="diff-selection-bar__hint">
                      Click a line’s gutter to pick it, shift-click for a run,
                      or use <strong>{selectionVerb} hunk</strong>.
                    </span>
                  )}
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
      {failed && (
        <div className="diff-stale-notice" role="status">
          PwrGit couldn’t re-read this diff. What you see is the last good
          read; it will catch up on the next change.
        </div>
      )}
      {!failed && selectionDropped && (
        <div className="diff-stale-notice" role="status">
          This file changed, so the lines you had ticked were cleared — their
          positions no longer describe the same edit.
        </div>
      )}
      {helpOpen && selectionAvailable && (
        <div className="diff-help" aria-label="Gestures and keyboard shortcuts">
          <div className="diff-help__title">Gestures</div>
          {HELP_ROWS.map((row) => (
            <div key={row.label} className="diff-help__row">
              <span className="diff-help__keys">
                {row.keys.map((key) => (
                  <kbd key={key}>{key}</kbd>
                ))}
              </span>
              <span>{row.label}</span>
            </div>
          ))}
        </div>
      )}
      <div className="diff-pane__body">
        {patch === null ? (
          <div className="diff-empty">
            {failed
              ? "This diff couldn’t be read."
              : "Loading diff…"}
          </div>
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
