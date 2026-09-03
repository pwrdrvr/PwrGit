import { useCallback, useEffect, useRef, useState } from "react";
import type {
  RemoteResetMode,
  RemoteResetPreview,
  RemoteResetSnapshot,
  ResetTargets,
  ResetTargetSuggestion,
  Worktree
} from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";
import { relativeAge } from "../../lib/relativeAge";
import { showErrorToast, showInfoToast } from "../../lib/toast";
import {
  BranchRefPicker,
  type BranchPickerOption
} from "../shell/BranchRefPicker";
import { CommitAlignment, commitCountLabel } from "./CommitAlignment";
import {
  fetchAgeLabel,
  isStaleFetch,
  remoteRefLabel,
  resetImpact,
  targetNote
} from "./reset-impact";

/* The dialog no longer blocks on a repo-wide ref load — the picker pages its
   own results — so the only load it waits on is the ranked-target lookup, and
   even that only gates the cards, not the list. */
type Busy = "targets" | "fetch" | "review" | "reset" | null;

/**
 * Everything the reset needs to know about the checkout it acts on. Narrower
 * than `Worktree` so the lineage graph — which holds ids and a branch name,
 * not the row — can open this from a branch-tip chip.
 */
export type ResetWorktree = Pick<Worktree, "id" | "repoId" | "branch">;

/** The target the reset will act on, from a ranked card or from the list. */
type ResetChoice = {
  /** Fully qualified fetched ref, e.g. `refs/remotes/origin/main`. */
  ref: string;
  label: string;
  head?: string;
  lastCommitAt?: string;
  /** Commits on the checkout this tip lacks; absent for list picks. */
  ahead?: number;
  behind?: number;
};

function firstLine(message: string): string {
  return message.split("\n")[0] ?? message;
}

function shortHead(head: string): string {
  return head.slice(0, 12);
}

function choiceOf(target: ResetTargetSuggestion): ResetChoice {
  return {
    ref: target.ref,
    label: target.label,
    head: target.head,
    ...(target.lastCommitAt === undefined
      ? {}
      : { lastCommitAt: target.lastCommitAt }),
    ahead: target.ahead,
    behind: target.behind
  };
}

export function resetInspectionRequest(worktreeId: string, remoteRef: string) {
  return { worktreeId, remoteRef };
}

export function resetExecutionRequest(
  worktreeId: string,
  mode: RemoteResetMode,
  snapshot: RemoteResetSnapshot
) {
  return { worktreeId, mode, ...snapshot };
}

/** One ranked target, rendered as a radio card above the full branch list. */
function TargetCard({
  choice,
  tag,
  note,
  selected,
  disabled,
  onSelect
}: {
  choice: ResetChoice;
  tag: string;
  note?: string;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  const meta = [
    choice.head === undefined ? null : shortHead(choice.head),
    choice.lastCommitAt === undefined
      ? null
      : relativeAge(choice.lastCommitAt)
  ].filter((part): part is string => part !== null);

  return (
    <label className={`reset-target${selected ? " is-selected" : ""}`}>
      <input
        type="radio"
        name="reset-target"
        checked={selected}
        disabled={disabled}
        onChange={onSelect}
      />
      <span className="reset-target__body">
        <span className="reset-target__head">
          <span className="reset-target__name">{choice.label}</span>
          <span className="reset-target__tag">{tag}</span>
        </span>
        <span className="reset-target__meta">
          {meta.join(" · ")}
          {choice.ahead !== undefined && choice.behind !== undefined && (
            <>
              {meta.length > 0 && " · "}
              <span className="reset-target__ahead">↑{choice.ahead}</span>{" "}
              <span className="reset-target__behind">↓{choice.behind}</span>
            </>
          )}
        </span>
        {note !== undefined && (
          <span className="reset-target__note">{note}</span>
        )}
      </span>
    </label>
  );
}

export function ResetToRemoteDialog({
  worktree,
  preselectRef,
  onClose,
  onComplete
}: {
  worktree: ResetWorktree;
  /**
   * A fully qualified ref the caller already named — the branch chip menu
   * opens on the chip the user right-clicked, so the picker never has to be
   * touched at all.
   */
  preselectRef?: string;
  onClose: () => void;
  onComplete: (mode: RemoteResetMode, branch: string) => void;
}) {
  const [targets, setTargets] = useState<ResetTargets | null>(null);
  const [selected, setSelected] = useState<ResetChoice | null>(
    preselectRef === undefined
      ? null
      : { ref: preselectRef, label: remoteRefLabel(preselectRef) }
  );
  const [browsing, setBrowsing] = useState(false);
  const [mode, setMode] = useState<RemoteResetMode>("soft");
  const [preview, setPreview] = useState<RemoteResetPreview | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState<Busy>("targets");
  const [error, setError] = useState<string | null>(null);
  const activeRef = useRef(true);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);

  const loadTargets = useCallback(async (): Promise<void> => {
    const result = await dispatch("remote:resetTargets", {
      worktreeId: worktree.id
    });
    if (!activeRef.current) return;
    setBusy(null);
    if (!result.ok) {
      // A branch with no upstream, or a repo with no remote HEAD, is ordinary
      // — the list below still works, so this never blocks the dialog.
      setTargets(null);
      setBrowsing(true);
      return;
    }
    setTargets(result.value);
    setSelected((current) => {
      if (current !== null) return current;
      const ranked = result.value.upstream ?? result.value.defaultBranch;
      if (ranked === null) {
        setBrowsing(true);
        return null;
      }
      return choiceOf(ranked);
    });
  }, [worktree.id]);

  useEffect(() => {
    void loadTargets();
  }, [loadTargets]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || busy !== null) return;
      if (preview !== null) setPreview(null);
      else onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose, preview]);

  const changeMode = (next: RemoteResetMode): void => {
    setMode(next);
    setPreview(null);
    setAcknowledged(false);
    setError(null);
  };

  const choose = (next: ResetChoice, fromList: boolean): void => {
    setSelected(next);
    setBrowsing(fromList);
    setPreview(null);
    setAcknowledged(false);
    setError(null);
  };

  /**
   * Hand the choice to the list. Clearing the selection is the point: leaving
   * a ranked card selected underneath left two radios in one group rendering
   * `checked`, React re-synced the group back to the card, and the reset ran
   * against the upstream while the picker sat open reading as the target.
   */
  const browse = (): void => {
    setSelected(null);
    setBrowsing(true);
    setPreview(null);
    setAcknowledged(false);
    setError(null);
  };

  const fetchNow = async (): Promise<void> => {
    setBusy("fetch");
    setError(null);
    const result = await dispatch("remote:fetch", { worktreeId: worktree.id });
    if (!activeRef.current) return;
    if (!result.ok) {
      setBusy(null);
      const message = firstLine(result.error.message);
      setError(message);
      return;
    }
    // The tips the cards quote just moved; re-read them rather than leaving
    // stale counts beside a freshly fetched ref.
    setPreview(null);
    setAcknowledged(false);
    setBusy("targets");
    await loadTargets();
  };

  const inspect = async (): Promise<void> => {
    if (selected === null) return;
    setBusy("review");
    setError(null);
    const result = await dispatch(
      "remote:inspectReset",
      resetInspectionRequest(worktree.id, selected.ref)
    );
    if (!activeRef.current) return;
    setBusy(null);
    if (!result.ok) {
      const message = firstLine(result.error.message);
      setError(message);
      showErrorToast({
        title: "Review reset failed",
        message,
        detail: result.error.message
      });
      return;
    }
    setAcknowledged(false);
    setPreview(result.value);
  };

  const reset = async (): Promise<void> => {
    if (preview === null || selected === null) return;
    setBusy("reset");
    setError(null);
    const result = await dispatch(
      "remote:resetToRemote",
      resetExecutionRequest(worktree.id, mode, preview.snapshot)
    );
    if (!activeRef.current) return;
    setBusy(null);
    if (!result.ok) {
      const message = firstLine(result.error.message);
      setError(message);
      setPreview(null);
      showErrorToast({
        title: `${mode === "hard" ? "Hard" : "Soft"} reset failed`,
        message,
        detail: result.error.message
      });
      return;
    }
    showInfoToast({
      title: `${mode === "hard" ? "Hard" : "Soft"} reset complete`,
      message: `${preview.snapshot.branch} now points to ${selected.label} at ${shortHead(preview.snapshot.remoteHead)}.`
    });
    onComplete(mode, selected.label);
    onClose();
  };

  const canClose = busy === null;
  const targetLabel = selected?.label ?? "remote branch";
  const impact = preview === null ? null : resetImpact(preview, mode);
  const upstreamRef = targets?.upstream?.ref;
  const defaultRef = targets?.defaultBranch?.ref;
  // With a card to fall back on, the picker must not seed itself — its first
  // row is whatever committed most recently, which is the wrong default for
  // the one action that discards history, and is what this dialog set out to
  // stop doing. With no card at all, that row is the only default there is.
  const hasRankedTarget = upstreamRef !== undefined || defaultRef !== undefined;
  const listSelected =
    selected !== null &&
    selected.ref !== upstreamRef &&
    selected.ref !== defaultRef;

  return (
    <div
      className="overlay-backdrop reset-remote-backdrop"
      onClick={() => canClose && onClose()}
    >
      <div
        className={`modal reset-remote${preview === null ? "" : " is-reviewing"}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="reset-remote-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal__title" id="reset-remote-title">
          Reset {worktree.branch} to a fetched remote branch
        </div>

        {preview === null || impact === null ? (
          <>
            <p className="reset-remote__intro">
              Pick the fetched tip this branch should point to. PwrGit re-reads
              both tips before the final confirmation.
            </p>

            <fieldset className="reset-remote__targets">
              <legend>Target</legend>
              {targets?.upstream != null && (
                <TargetCard
                  choice={choiceOf(targets.upstream)}
                  tag="Upstream"
                  note={targetNote(
                    targets.upstream.ahead,
                    targets.upstream.behind
                  )}
                  selected={selected?.ref === targets.upstream.ref}
                  disabled={busy !== null}
                  onSelect={() =>
                    targets.upstream != null &&
                    choose(choiceOf(targets.upstream), false)
                  }
                />
              )}
              {targets?.defaultBranch != null && (
                <TargetCard
                  choice={choiceOf(targets.defaultBranch)}
                  tag="Default branch"
                  note={targetNote(
                    targets.defaultBranch.ahead,
                    targets.defaultBranch.behind
                  )}
                  selected={selected?.ref === targets.defaultBranch.ref}
                  disabled={busy !== null}
                  onSelect={() =>
                    targets.defaultBranch != null &&
                    choose(choiceOf(targets.defaultBranch), false)
                  }
                />
              )}
              <label
                className={`reset-target${listSelected || browsing ? " is-selected" : ""}`}
              >
                <input
                  type="radio"
                  name="reset-target"
                  checked={listSelected || browsing}
                  disabled={busy !== null}
                  onChange={() => browse()}
                />
                <span className="reset-target__body">
                  <span className="reset-target__head">
                    <span className="reset-target__name">
                      {listSelected && selected !== null
                        ? selected.label
                        : "Another fetched branch…"}
                    </span>
                    {targets !== null && (
                      <span className="reset-target__tag reset-target__tag--quiet">
                        {targets.branchCount} fetched
                      </span>
                    )}
                  </span>
                </span>
              </label>
            </fieldset>

            {/* Outside the radio's <label> on purpose: a filter box nested in a
                label re-toggles the radio on every click into the field. */}
            {(browsing || listSelected) && (
              <div className="reset-remote__browse">
                <BranchRefPicker
                  repoId={worktree.repoId}
                  label="Remote branch"
                  stacked
                  autoFocus={browsing}
                  autoSelectFirst={selected === null && !hasRankedTarget}
                  disabled={busy !== null}
                  onChange={(option: BranchPickerOption) =>
                    choose(
                      {
                        ref: option.ref,
                        label: option.label,
                        head: option.head,
                        ...(option.remoteBranch?.lastCommitAt === undefined
                          ? {}
                          : { lastCommitAt: option.remoteBranch.lastCommitAt })
                      },
                      true
                    )
                  }
                />
              </div>
            )}

            <div
              className={`reset-remote__fetched${
                isStaleFetch(targets?.lastFetchedAt ?? null) ? " is-stale" : ""
              }`}
            >
              <span>
                {targets?.lastFetchedAt == null
                  ? "This repository has not fetched in this session — the refs below may be old."
                  : `Last fetched ${fetchAgeLabel(targets.lastFetchedAt)} — the reset uses that snapshot, not the live remote.`}
              </span>
              <button
                type="button"
                className="reset-remote__fetch"
                disabled={busy !== null}
                onClick={() => void fetchNow()}
              >
                {busy === "fetch" ? "Fetching…" : "Fetch now"}
              </button>
            </div>

            <fieldset className="reset-remote__modes">
              <legend>Reset mode</legend>
              <label className={mode === "soft" ? "is-selected" : ""}>
                <input
                  type="radio"
                  name="reset-mode"
                  value="soft"
                  checked={mode === "soft"}
                  onChange={() => changeMode("soft")}
                />
                <span>
                  <strong>Soft</strong>
                  <small>
                    Move the branch and HEAD to the selected commit without
                    changing the index or working tree. File contents and existing
                    staged/unstaged work stay in place; Git reports their differences
                    against the new HEAD.
                  </small>
                </span>
              </label>
              <label
                className={`reset-remote__mode--hard${
                  mode === "hard" ? " is-selected" : ""
                }`}
              >
                <input
                  type="radio"
                  name="reset-mode"
                  value="hard"
                  checked={mode === "hard"}
                  onChange={() => changeMode("hard")}
                />
                <span>
                  <strong>Hard · destructive</strong>
                  <small>
                    Move the branch and HEAD, reset the index, and overwrite tracked
                    files. This discards tracked staged and unstaged changes. Untracked
                    and ignored files are normally left alone, but Git may delete an
                    untracked file or directory that obstructs a tracked path in the
                    target commit. This does not run git clean.
                  </small>
                </span>
              </label>
            </fieldset>

            <p className="reset-remote__history-note">
              Both modes move the local branch pointer to <code>{targetLabel}</code>.
              Any local commits that are not reachable from that target leave the
              branch. Git&apos;s reflog may retain them temporarily; do not rely on that
              as a backup.
            </p>
          </>
        ) : (
          <>
            <p className="reset-remote__intro">
              Review the exact refs and object IDs. The reset stops if either the
              checkout or fetched remote-tracking ref changes.
            </p>
            <dl className="reset-remote__review">
              <div>
                <dt>Checked-out branch</dt>
                <dd>{preview.snapshot.branch}</dd>
                <dd className="reset-remote__sha">{preview.snapshot.head}</dd>
              </div>
              <div>
                <dt>Fetched target</dt>
                <dd>{targetLabel}</dd>
                <dd className="reset-remote__sha">
                  {preview.snapshot.remoteHead}
                </dd>
              </div>
            </dl>

            <div className="reset-ledger">
              <div
                className={`reset-ledger__cell${
                  impact.stranded > 0 ? " is-hot" : ""
                }`}
              >
                <strong>{impact.stranded}</strong>
                <span>
                  {impact.stranded === 1 ? "commit exists" : "commits exist"} only
                  on this branch
                </span>
              </div>
              {impact.rewritten > 0 && (
                <div className="reset-ledger__cell">
                  <strong>{impact.rewritten}</strong>
                  <span>already on the target under new hashes</span>
                </div>
              )}
              <div className="reset-ledger__cell">
                <strong>{impact.arriving}</strong>
                <span>
                  {impact.arriving === 1 ? "commit arrives" : "commits arrive"} on
                  the branch
                </span>
              </div>
              {mode === "hard" && (
                <div
                  className={`reset-ledger__cell${
                    impact.discarding > 0 ? " is-hot" : ""
                  }`}
                >
                  <strong>{impact.discarding}</strong>
                  <span>working-tree changes discarded</span>
                </div>
              )}
            </div>

            {impact.leaving > 0 && (
              <CommitAlignment
                rows={preview.alignedCommits}
                localHeading="Leaving this branch"
                otherHeading={`Arriving from ${targetLabel}`}
                localCount={impact.leaving}
                otherCount={impact.arriving}
                ariaLabel="Commits leaving the branch, aligned against the target"
                otherAbsentLabel="Not present on the target"
                otherOnlyLabel="Only on the target branch"
              />
            )}

            <div
              className={`reset-remote__final-warning${
                mode === "hard" ? " is-hard" : ""
              }`}
            >
              {mode === "hard"
                ? impact.stranded === 0
                  ? "Hard reset will move the branch pointer to this target and reset the index and working tree to match it. Every commit leaving the branch is already on the target under a different object name."
                  : `Hard reset will move the branch pointer to this target and discard tracked staged and unstaged changes. ${commitCountLabel(impact.stranded)} on this branch ${impact.stranded === 1 ? "has" : "have"} no counterpart on the target and will not survive anywhere but the reflog.`
                : `Soft reset will move the branch pointer to this target and leave the index and working tree untouched.${
                    impact.leaving === 0
                      ? " No commits leave the branch."
                      : ` The ${commitCountLabel(impact.leaving)} leaving the branch ${impact.leaving === 1 ? "keeps its changes" : "keep their changes"} in your working tree as differences against the new HEAD.`
                  }`}
            </div>

            {impact.needsAcknowledgement && (
              <label className="reset-remote__ack">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  disabled={busy !== null}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                />
                <span>
                  I understand {commitCountLabel(impact.stranded)} will leave{" "}
                  {preview.snapshot.branch} and{" "}
                  {impact.discarding === 0
                    ? "cannot be recovered outside the reflog"
                    : `${impact.discarding} working-tree ${impact.discarding === 1 ? "change" : "changes"} will be discarded`}
                  .
                </span>
              </label>
            )}
          </>
        )}

        {error !== null && <div className="modal__error">{error}</div>}
        <div className="modal__actions">
          {preview !== null && (
            <button
              className="modal__cancel"
              disabled={busy !== null}
              onClick={() => setPreview(null)}
            >
              Back
            </button>
          )}
          <button className="modal__cancel" disabled={!canClose} onClick={onClose}>
            Cancel
          </button>
          {preview === null ? (
            <button
              className={`modal__create${
                mode === "hard" ? " modal__create--danger" : ""
              }`}
              disabled={busy !== null || selected === null}
              onClick={() => void inspect()}
            >
              {busy === "review" ? "Inspecting…" : `Review ${mode} reset`}
            </button>
          ) : (
            <button
              className={`modal__create${
                mode === "hard" ? " modal__create--danger" : ""
              }`}
              disabled={
                busy !== null ||
                (impact !== null &&
                  impact.needsAcknowledgement &&
                  !acknowledged)
              }
              onClick={() => void reset()}
            >
              {busy === "reset"
                ? "Resetting…"
                : `${mode === "hard" ? "Hard" : "Soft"} reset branch`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
