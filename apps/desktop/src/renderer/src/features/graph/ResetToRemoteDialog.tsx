import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ForkPushBack,
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
import { useModal } from "../../lib/useModal";
import {
  fetchCoverage,
  forkPushPlan,
  pushForces,
  pushNote,
  rankedTarget,
  remoteRefLabel,
  resetImpact,
  targetNote
} from "./reset-impact";

/* The dialog no longer blocks on a repo-wide ref load — the picker pages its
   own results — so the only load it waits on is the ranked-target lookup, and
   even that only gates the cards, not the list. */
type Busy = "targets" | "fetch" | "review" | "reset" | "push" | null;

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

/**
 * One ranked target, rendered as a radio card above the full branch list.
 *
 * A target identical to the checkout draws as one quiet line: it is still a
 * valid choice, but resetting to it changes nothing, and a full card with its
 * arrows reading ↑0 ↓0 looked like the answer.
 */
function TargetCard({
  choice,
  tag,
  repo,
  note,
  identicalTo,
  selected,
  disabled,
  onSelect
}: {
  choice: ResetChoice;
  tag: string;
  /** The forge repository the ref belongs to, e.g. a fork's parent. */
  repo?: string | undefined;
  note?: string;
  /** The checked-out branch, when this target is identical to it. */
  identicalTo?: string | undefined;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  if (identicalTo !== undefined) {
    return (
      <label
        className={`reset-target is-identical${selected ? " is-selected" : ""}`}
      >
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
            <span className="reset-target__inline">
              {choice.head === undefined ? "" : `${shortHead(choice.head)} · `}
              already identical to {identicalTo}
            </span>
            <span className="reset-target__tag reset-target__tag--quiet">
              {tag}
            </span>
          </span>
        </span>
      </label>
    );
  }

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
          {repo !== undefined && (
            <span className="reset-target__repo">{repo}</span>
          )}
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

/** "Review soft reset + push" on the first step, "Hard reset branch" on the last. */
function actionLabel(
  mode: RemoteResetMode,
  push: ForkPushBack | null,
  step: "review" | "confirm"
): string {
  const tail =
    push === null
      ? step === "review"
        ? ""
        : " branch"
      : pushForces(push)
        ? " + force-push"
        : " + push";
  return step === "review"
    ? `Review ${mode} reset${tail}`
    : `${mode === "hard" ? "Hard" : "Soft"} reset${tail}`;
}

/** The push as Git is asked to run it, for the review step to show verbatim. */
function pushCommand(push: ForkPushBack, head: string): string {
  const destination = `refs/heads/${push.branch}`;
  return `git push --force-with-lease=${destination}:${push.head} ${push.remote} ${head}:${destination}`;
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
  /**
   * The user's answer to "also update the fork", or null for the default: on
   * for a fast-forward, which loses nothing, and off for a forced push, which
   * removes commits from the remote. Cleared whenever the target or the
   * fetched tips change, so a yes given to a fast-forward never carries over
   * into a force.
   */
  const [pushChoice, setPushChoice] = useState<boolean | null>(null);
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
    setPushChoice(null);
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
      const ranked = rankedTarget(result.value);
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

  const changeMode = (next: RemoteResetMode): void => {
    setMode(next);
    setPreview(null);
    setAcknowledged(false);
    setError(null);
  };

  const choose = (next: ResetChoice, fromList: boolean): void => {
    setSelected(next);
    setBrowsing(fromList);
    setPushChoice(null);
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
    setPushChoice(null);
    setPreview(null);
    setAcknowledged(false);
    setError(null);
  };

  const coverage = fetchCoverage(targets);

  const fetchNow = async (): Promise<void> => {
    setBusy("fetch");
    setError(null);
    const result = await dispatch("remote:fetch", {
      worktreeId: worktree.id,
      ...(coverage.remotes === undefined ? {} : { remotes: coverage.remotes })
    });
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

  const fork = targets?.forkSource ?? null;
  const pushPlan = forkPushPlan(fork, selected?.ref);
  const forcePush = pushPlan !== null && pushForces(pushPlan);
  const pushing =
    pushPlan !== null && (pushChoice ?? !pushForces(pushPlan));
  const push = pushing ? pushPlan : null;

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
        detail: result.error.message,
        subject: { worktreeId: worktree.id }
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
    const done = `${mode === "hard" ? "Hard" : "Soft"} reset complete`;
    if (!result.ok) {
      setBusy(null);
      const message = firstLine(result.error.message);
      setError(message);
      setPreview(null);
      showErrorToast({
        title: `${mode === "hard" ? "Hard" : "Soft"} reset failed`,
        message,
        detail: result.error.message,
        subject: { worktreeId: worktree.id }
      });
      return;
    }
    const moved = `${preview.snapshot.branch} now points to ${selected.label} at ${shortHead(preview.snapshot.remoteHead)}`;
    if (push === null) {
      showInfoToast({
        title: done,
        message: `${moved}.`,
        subject: { worktreeId: worktree.id }
      });
    } else {
      // Only after the reset has landed, and it pushes the object that was
      // reviewed. A failure here is reported as what it is — the reset stands
      // — never as though the whole operation failed.
      setBusy("push");
      const tracked = `${push.remote}/${push.branch}`;
      const subject = { worktreeId: worktree.id, remote: { name: push.remote } };
      const pushed = await dispatch("remote:pushBranchWithLease", {
        worktreeId: worktree.id,
        remote: push.remote,
        branch: push.branch,
        head: preview.snapshot.remoteHead,
        expectedHead: push.head
      });
      if (pushed.ok) {
        showInfoToast({
          title: done,
          message: `${moved}, and ${tracked} was pushed to match.`,
          subject
        });
      } else {
        showErrorToast({
          title: `${done} — push ${
            pushed.error.code === "push_lease_stale" ? "refused" : "failed"
          }`,
          message: `${moved}. ${firstLine(pushed.error.message)} ${tracked} is unchanged.`,
          detail: pushed.error.detail ?? pushed.error.message,
          subject
        });
      }
    }
    if (!activeRef.current) return;
    setBusy(null);
    onComplete(mode, selected.label);
    onClose();
  };

  const canClose = busy === null;
  const targetLabel = selected?.label ?? "remote branch";
  const impact = preview === null ? null : resetImpact(preview, mode);
  const upstreamRef = targets?.upstream?.ref;
  const defaultRef = targets?.defaultBranch?.ref;
  const forkRef = fork?.ref;
  // With a card to fall back on, the picker must not seed itself — its first
  // row is whatever committed most recently, which is the wrong default for
  // the one action that discards history, and is what this dialog set out to
  // stop doing. With no card at all, that row is the only default there is.
  const hasRankedTarget =
    upstreamRef !== undefined ||
    defaultRef !== undefined ||
    forkRef !== undefined;
  const listSelected =
    selected !== null &&
    selected.ref !== upstreamRef &&
    selected.ref !== defaultRef &&
    selected.ref !== forkRef;
  // A soft reset keeps a leaving commit's changes locally; a forced push still
  // deletes the commits from the remote. So the push asks on its own account.
  const needsAcknowledgement =
    impact !== null && (impact.needsAcknowledgement || (push !== null && forcePush));
  const danger = mode === "hard" || (push !== null && forcePush);

  const identicalTo = (target: ResetTargetSuggestion): string | undefined =>
    target.ahead === 0 && target.behind === 0 ? worktree.branch : undefined;

  // Escape unwinds one step at a time: it leaves the review screen first and
  // only closes the dialog from the top, and is refused entirely while a reset
  // is running. Preserved from the hand-rolled handler this replaced.
  const modalRef = useModal<HTMLDivElement>({
    onClose: () => {
      if (busy !== null) return;
      if (preview !== null) setPreview(null);
      else onClose();
    }
  });

  return (
    <div
      className="overlay-backdrop reset-remote-backdrop"
      onClick={() => canClose && onClose()}
    >
      <div
        ref={modalRef}
        tabIndex={-1}
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
              {fork !== null && (
                <TargetCard
                  choice={choiceOf(fork)}
                  // "Upstream remote" when only the remote's name said so: a
                  // fork relationship is the forge's to confirm, not ours.
                  tag={fork.parent === undefined ? "Upstream remote" : "Fork source"}
                  repo={fork.parent}
                  note={targetNote(fork.ahead, fork.behind)}
                  identicalTo={identicalTo(fork)}
                  selected={selected?.ref === fork.ref}
                  disabled={busy !== null}
                  onSelect={() => choose(choiceOf(fork), false)}
                />
              )}
              {targets?.upstream != null && (
                <TargetCard
                  choice={choiceOf(targets.upstream)}
                  // Git's sense of "upstream". Named for what it does, because
                  // on a fork a remote called `upstream` is a different thing.
                  tag="Tracking"
                  note={targetNote(
                    targets.upstream.ahead,
                    targets.upstream.behind
                  )}
                  identicalTo={identicalTo(targets.upstream)}
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
              className={`reset-remote__fetched${coverage.stale ? " is-stale" : ""}`}
            >
              <span>{coverage.text}</span>
              <button
                type="button"
                className="reset-remote__fetch"
                disabled={busy !== null}
                onClick={() => void fetchNow()}
              >
                {busy === "fetch" ? "Fetching…" : coverage.fetchLabel}
              </button>
            </div>

            {pushPlan !== null && fork !== null && (
              <fieldset className="reset-remote__follow">
                <legend>
                  {fork.parent === undefined ? "After the reset" : "Your fork"}
                </legend>
                <label
                  className={`reset-remote__push${forcePush ? " is-force" : ""}${
                    pushing ? " is-selected" : ""
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={pushing}
                    disabled={busy !== null}
                    onChange={(event) => {
                      setPushChoice(event.target.checked);
                      setPreview(null);
                      setAcknowledged(false);
                    }}
                  />
                  <span className="reset-target__body">
                    <span className="reset-target__head">
                      <span className="reset-remote__push-title">
                        {forcePush ? "Force-push " : "Update "}
                        <code>
                          {pushPlan.remote}/{pushPlan.branch}
                        </code>{" "}
                        to match
                      </span>
                      <span
                        className={`reset-target__tag ${
                          forcePush
                            ? "reset-target__tag--danger"
                            : "reset-target__tag--ok"
                        }`}
                      >
                        {forcePush ? "Force · lease" : "Fast-forward"}
                      </span>
                    </span>
                    <span className="reset-target__note">
                      {pushNote(pushPlan, fork, worktree.branch)}
                    </span>
                  </span>
                </label>
              </fieldset>
            )}

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

            {push !== null && (
              <div
                className={`reset-remote__then${forcePush ? " is-force" : ""}`}
              >
                <div className="reset-remote__then-head">
                  <span>
                    Then {forcePush ? "force-push" : "push"} to{" "}
                    {fork?.parent === undefined ? push.remote : "your fork"}
                  </span>
                  <span
                    className={`reset-target__tag ${
                      forcePush
                        ? "reset-target__tag--danger"
                        : "reset-target__tag--ok"
                    }`}
                  >
                    {forcePush ? "Force · lease" : "Fast-forward"}
                  </span>
                </div>
                <div className="reset-remote__then-refs">
                  <code>{preview.snapshot.branch}</code>
                  <span aria-hidden="true">→</span>
                  <code>
                    {push.remote}/{push.branch}
                  </code>
                </div>
                <p>
                  {forcePush
                    ? `Removes ${commitCountLabel(push.overwrites)} from ${push.remote}/${push.branch}. The lease refuses the push if ${push.remote}/${push.branch} is no longer at ${shortHead(push.head)}.`
                    : `${push.remote}/${push.branch} moves from ${shortHead(push.head)} to ${shortHead(preview.snapshot.remoteHead)}. If it has moved since the fetch, the push stops and the reset stands.`}
                </p>
                <code className="reset-remote__cmd">
                  {pushCommand(push, preview.snapshot.remoteHead)}
                </code>
              </div>
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

            {needsAcknowledgement && (
              <label className="reset-remote__ack">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  disabled={busy !== null}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                />
                <span>
                  I understand{" "}
                  {[
                    ...(impact.needsAcknowledgement
                      ? [
                          `${commitCountLabel(impact.stranded)} will leave ${preview.snapshot.branch} and ${
                            impact.discarding === 0
                              ? "cannot be recovered outside the reflog"
                              : `${impact.discarding} working-tree ${impact.discarding === 1 ? "change" : "changes"} will be discarded`
                          }`
                        ]
                      : []),
                    ...(push !== null && forcePush
                      ? [
                          `${commitCountLabel(push.overwrites)} will be removed from ${push.remote}/${push.branch}`
                        ]
                      : [])
                  ].join(", and ")}
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
              className={`modal__create${danger ? " modal__create--danger" : ""}`}
              disabled={busy !== null || selected === null}
              onClick={() => void inspect()}
            >
              {busy === "review"
                ? "Inspecting…"
                : actionLabel(mode, push, "review")}
            </button>
          ) : (
            <button
              className={`modal__create${danger ? " modal__create--danger" : ""}`}
              disabled={busy !== null || (needsAcknowledgement && !acknowledged)}
              onClick={() => void reset()}
            >
              {busy === "reset"
                ? "Resetting…"
                : busy === "push"
                  ? "Pushing…"
                  : actionLabel(mode, push, "confirm")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
