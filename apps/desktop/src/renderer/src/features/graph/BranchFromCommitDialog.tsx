import { useEffect, useMemo, useRef, useState } from "react";
import type { BranchCheckoutTarget, Commit } from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";
import { showErrorToast, showInfoToast } from "../../lib/toast";
import {
  branchNameProblem,
  initialCheckoutTarget,
  readStoredCheckoutTarget,
  suggestBranchName,
  writeStoredCheckoutTarget
} from "./branch-from-commit";
import { longWhen } from "./graph-view";

function firstLine(message: string): string {
  return message.split("\n")[0] ?? message;
}

/**
 * Create a branch at any commit, optionally checking it out. The three
 * checkout targets are one radio group because they are mutually exclusive
 * destinations for the same branch, and the choice is remembered app-wide
 * between openings.
 */
export function BranchFromCommitDialog({
  repoId,
  repoName,
  worktreeId,
  viewingBranch,
  commit,
  now,
  onClose,
  onCreated
}: {
  repoId: string;
  repoName: string;
  /** Worktree whose git dir the branch is written to — and the "here" target. */
  worktreeId: string;
  /** Branch checked out there, named in the in-place checkout choice. */
  viewingBranch: string;
  commit: Commit;
  now: number;
  onClose: () => void;
  /** A worktree now holding the branch, for the caller to reveal. */
  onCreated: (checkedOutWorktreeId: string | null) => void;
}) {
  const [branch, setBranch] = useState(() => suggestBranchName(commit.subject));
  const [target, setTarget] = useState<BranchCheckoutTarget>(
    readStoredCheckoutTarget
  );
  const [existing, setExisting] = useState<string[]>([]);
  const [dirty, setDirty] = useState<boolean | null>(null);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef(true);
  const selected = useRef(false);
  /** Whether the checkout target on screen is the user's pick or the fallback. */
  const picked = useRef(false);

  // The suggestion is a starting point, so it opens selected — typing replaces
  // it wholesale. Only on mount: a later click into the field places a caret.
  const selectSuggestionOnce = (node: HTMLInputElement | null): void => {
    if (node === null || selected.current) return;
    selected.current = true;
    node.select();
  };

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  // Names only, and local only: `git branch` refuses a name that a local ref
  // already holds, and nothing else here needs per-ref metadata. On a repo with
  // thousands of remote-tracking refs, `branch:list` would ship (and parse)
  // hundreds of KB per opening to answer the same question.
  useEffect(() => {
    let live = true;
    void dispatch("branch:localNames", { worktreeId }).then((result) => {
      if (!live || !result.ok) return;
      setExisting(result.value);
    });
    return () => {
      live = false;
    };
  }, [worktreeId]);

  // Dirtiness decides whether an in-place checkout is offered at all. The
  // cached snapshot is enough for the UI; the main process re-checks before it
  // actually moves HEAD.
  useEffect(() => {
    let live = true;
    void dispatch("worktree:getState", { worktreeId }).then((result) => {
      if (!live || !result.ok) return;
      setDirty(result.value === null ? false : result.value.dirty > 0);
    });
    return () => {
      live = false;
    };
  }, [worktreeId]);

  const problem = useMemo(
    () => branchNameProblem(branch, existing),
    [branch, existing]
  );
  const canCheckoutHere = dirty === false;
  const trimmed = branch.trim();

  // The stored preference is honoured unless it is unavailable right now; the
  // fallback is for this dialog only and never overwrites what is stored.
  useEffect(() => {
    if (dirty !== true) return;
    setTarget((current) => initialCheckoutTarget(current, false));
  }, [dirty]);

  // Ask the main process where the worktree would land rather than rebuilding
  // the path here — the preview and the created directory must not disagree.
  useEffect(() => {
    if (target !== "new-worktree" || problem !== null) {
      setPreviewPath(null);
      return;
    }
    let live = true;
    void dispatch("worktree:pathPreview", { repoId, branch: trimmed }).then(
      (result) => {
        if (!live) return;
        setPreviewPath(result.ok ? result.value.path : null);
      }
    );
    return () => {
      live = false;
    };
  }, [problem, repoId, target, trimmed]);

  // "here" stays checked until the dirty check answers, so hold the submit too
  // rather than sending a checkout the main process would only reject.
  const blocked = problem !== null || (target === "here" && !canCheckoutHere);

  // Dismissing mid-create is allowed (checking out a big repo takes seconds),
  // so say the work continues — the outcome arrives as a toast either way.
  const dismiss = (): void => {
    if (busy) {
      showInfoToast({
        title: "Still creating",
        message: `${trimmed} is being created in the background.`
      });
    }
    onClose();
  };

  const submit = async (): Promise<void> => {
    if (blocked || busy) return;
    setBusy(true);
    setError(null);
    const result = await dispatch("branch:create", {
      worktreeId,
      branch: trimmed,
      startPoint: commit.hash,
      checkout: target
    });
    // Everything below reports the outcome and must survive a dialog the user
    // dismissed while waiting; only the in-dialog state is mount-guarded.
    if (active.current) setBusy(false);
    if (!result.ok) {
      const message = firstLine(result.error.message);
      if (active.current) setError(message);
      showErrorToast({
        title: "Create branch failed",
        message,
        detail: result.error.message
      });
      return;
    }
    // Only a target the user picked is worth remembering. Persisting whatever
    // was on screen would let the dirty-worktree fallback quietly replace a
    // stored "here" the moment someone accepted the substitute once.
    if (picked.current) writeStoredCheckoutTarget(target);
    showInfoToast({
      title: "Branch created",
      message:
        target === "none"
          ? `${trimmed} points at ${commit.shortHash}.`
          : target === "here"
            ? `${trimmed} is checked out here at ${commit.shortHash}.`
            : `${trimmed} is checked out in a new worktree at ${commit.shortHash}.`
    });
    onCreated(result.value.checkedOutWorktreeId);
    onClose();
  };

  const nameError =
    problem === null || problem.kind === "empty"
      ? null
      : problem.kind === "taken"
        ? `A branch named ${trimmed} already exists. Pick another name.`
        : problem.message;

  const choice = (
    value: BranchCheckoutTarget,
    label: string,
    detail: string,
    disabled = false
  ) => (
    <label
      className={`branch-from__choice${target === value ? " is-selected" : ""}${
        disabled ? " is-disabled" : ""
      }`}
    >
      <input
        type="radio"
        name="branch-from-checkout"
        value={value}
        checked={target === value}
        disabled={disabled || busy}
        onChange={() => {
          picked.current = true;
          setTarget(value);
        }}
      />
      <span>
        {label}
        <small>{detail}</small>
      </span>
    </label>
  );

  return (
    <div className="overlay-backdrop" onClick={dismiss}>
      <div
        className="modal branch-from"
        role="dialog"
        aria-modal="true"
        aria-labelledby="branch-from-title"
        onClick={(event) => event.stopPropagation()}
        // Escape is handled here rather than on window: with the ⌘F switcher
        // stacked above this dialog, a window listener would close both on the
        // keystroke that was only meant to dismiss the switcher.
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.stopPropagation();
          dismiss();
        }}
      >
        <div className="modal__title" id="branch-from-title">
          Branch from {commit.shortHash} · {repoName}
        </div>

        <div className="branch-from__start">
          <div className="branch-from__start-top">
            <span className="branch-from__sha">{commit.shortHash}</span>
            <span className="branch-from__start-meta">
              {longWhen(commit.committedAt, now)} · {commit.authorName}
            </span>
          </div>
          <div className="branch-from__start-subject">{commit.subject}</div>
        </div>

        <input
          className="modal__input"
          autoFocus
          ref={selectSuggestionOnce}
          value={branch}
          aria-label="Branch name"
          aria-invalid={nameError !== null}
          // Points at the message so a screen reader reads WHY the name is
          // rejected, not just that it is — the button disables on the same
          // condition, leaving no other route to the reason.
          {...(nameError === null
            ? {}
            : { "aria-describedby": "branch-from-name-error" })}
          placeholder="branch name"
          onChange={(event) => {
            setBranch(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") void submit();
          }}
        />

        <fieldset className="branch-from__targets">
          <legend>Check out</legend>
          {choice(
            "none",
            "Don't check out",
            "Create the branch pointer only. Nothing on disk changes."
          )}
          {choice(
            "new-worktree",
            "In a new worktree",
            previewPath ?? "Created under your worktree root."
          )}
          {choice(
            "here",
            `In this worktree (${viewingBranch})`,
            canCheckoutHere
              ? "Switches the branch checked out here."
              : dirty === null
                ? "Checking for uncommitted changes…"
                : `Unavailable — ${viewingBranch} has uncommitted changes.`,
            !canCheckoutHere
          )}
        </fieldset>

        {nameError !== null && (
          <div className="modal__error" id="branch-from-name-error">
            {nameError}
          </div>
        )}
        {error !== null && <div className="modal__error">{error}</div>}

        <div className="modal__actions">
          <button className="modal__cancel" onClick={dismiss}>
            {busy ? "Close" : "Cancel"}
          </button>
          <button
            className="modal__create"
            disabled={busy || blocked}
            onClick={() => void submit()}
          >
            {busy
              ? "Creating…"
              : target === "new-worktree"
                ? "Create branch & worktree"
                : "Create branch"}
          </button>
        </div>
      </div>
    </div>
  );
}
