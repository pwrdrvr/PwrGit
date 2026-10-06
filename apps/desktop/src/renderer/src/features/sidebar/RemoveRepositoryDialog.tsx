import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  branchChoices,
  checkoutChoices,
  checkoutVerdict,
  removalStatus,
  type RemovalBranch,
  type RemovalChoice,
  type RemovalCheckout,
  type RemovalDecisions,
  type RemovalStep,
  type Repo,
  type RepoRemovalResult,
  type RepoRemovalReview
} from "@pwrgit/shared";
import { dispatch, subscribe } from "../../lib/pwrgit";
import { useModal } from "../../lib/useModal";
import { SettingsSegmented } from "../settings/SettingsLayout";
import { confirmDialog } from "../shell/dialogs";
import { revealLabel, revealPath } from "../shell/reveal";
import {
  checkoutFacts,
  checkoutLabel,
  partialCallout,
  pushOffReason,
  removeButtonLabel,
  resultHeadline,
  sizeLabel,
  statusLine,
  stepLabel,
  verdictLabel
} from "./remove-repo-view";

const CHOICE_LABEL: Record<RemovalChoice, string> = {
  push: "Push first",
  keep: "Keep",
  discard: "Discard"
};

type Phase =
  | { kind: "loading" }
  | { kind: "review" }
  | { kind: "pushing"; label: string }
  | { kind: "running"; steps: RemovalStep[] }
  | { kind: "result"; result: RepoRemovalResult };

const firstLine = (message: string): string => message.split("\n")[0] ?? message;

/**
 * Remove a repository from disk, guided: every checkout and everything in the
 * shared `.git` is listed with what removing it would lose, each risk takes an
 * explicit answer, and the folders go to the Trash — worktrees first, the main
 * checkout last and only when nothing that needs its `.git` is kept. Main
 * re-runs the review before it moves anything (`repo:remove`), so this dialog
 * can never remove on an answer given about a state that has since changed.
 */
export function RemoveRepositoryDialog({
  repo,
  platform,
  onClose,
  onOpenWorktree,
  onRemoved
}: {
  repo: Repo;
  platform?: string;
  onClose: () => void;
  /** "Open worktree" on a blocked row: finish the operation there. */
  onOpenWorktree: (worktreeId: string) => void;
  /** The repository left the profile (a full removal). */
  onRemoved?: () => void;
}) {
  const [review, setReview] = useState<RepoRemovalReview | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [decisions, setDecisions] = useState<RemovalDecisions>({
    checkouts: {},
    branches: {}
  });
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const busy = phase.kind === "pushing" || phase.kind === "running";
  const titleId = `remove-repo-${repo.id}-title`;
  const modalRef = useModal<HTMLDivElement>({
    onClose: () => {
      if (!busy) onClose();
    },
    initialFocusRef: cancelRef
  });

  const load = useCallback(async (): Promise<RepoRemovalReview | null> => {
    const result = await dispatch("repo:removalReview", { repoId: repo.id });
    if (!result.ok) {
      setError(firstLine(result.error.message));
      setPhase({ kind: "review" });
      return null;
    }
    setReview(result.value);
    setPhase({ kind: "review" });
    return result.value;
  }, [repo.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const status = useMemo(
    () => (review === null ? null : removalStatus(review, decisions)),
    [review, decisions]
  );

  const setCheckout = (worktreeId: string, choice: RemovalChoice): void =>
    setDecisions((d) => ({ ...d, checkouts: { ...d.checkouts, [worktreeId]: choice } }));
  const setBranch = (branch: string, choice: RemovalChoice): void =>
    setDecisions((d) => ({ ...d, branches: { ...d.branches, [branch]: choice } }));

  /** Push what the user asked to push, through the ordinary push commands so
   *  each one is a tracked remote activity. Returns a failure, or null. */
  const pushFirst = async (r: RepoRemovalReview, worktreeIds: string[], branches: string[]): Promise<string | null> => {
    for (const id of worktreeIds) {
      const checkout = r.checkouts.find((c) => c.worktreeId === id);
      if (checkout === undefined) continue;
      setPhase({ kind: "pushing", label: `Pushing ${checkoutLabel(checkout)}…` });
      const pushed = await dispatch(
        "remote:push",
        checkout.upstream === null && checkout.pushRemote !== null
          ? { worktreeId: id, publish: { remote: checkout.pushRemote } }
          : { worktreeId: id }
      );
      if (!pushed.ok) return `Push of ${checkoutLabel(checkout)} failed: ${firstLine(pushed.error.message)}`;
    }
    for (const branchName of branches) {
      const branch = r.branches.find((b) => b.name === branchName);
      if (branch === undefined || branch.pushRemote === null) continue;
      setPhase({ kind: "pushing", label: `Pushing ${branchName}…` });
      const plan = await dispatch("remote:planPushRefs", {
        repoId: r.repoId,
        sourceRef: `refs/heads/${branchName}`,
        destinations: [{ remote: branch.pushRemote, branch: branchName }]
      });
      if (!plan.ok) return `Push of ${branchName} failed: ${firstLine(plan.error.message)}`;
      const actionable = plan.value.filter((p) => p.relation !== "equal");
      if (actionable.some((p) => p.relation !== "create" && p.relation !== "fast_forward")) {
        return `${branch.pushRemote}/${branchName} has commits ${branchName} does not. Push it yourself, then review again.`;
      }
      if (actionable.length === 0) continue;
      const pushed = await dispatch("remote:pushRefs", { repoId: r.repoId, plans: actionable });
      if (!pushed.ok) return `Push of ${branchName} failed: ${firstLine(pushed.error.message)}`;
      const failed = pushed.value.find((p) => p.outcome === "failed");
      if (failed !== undefined) {
        return `Push of ${branchName} failed: ${firstLine(failed.message ?? "rejected")}`;
      }
    }
    return null;
  };

  const execute = async (r: RepoRemovalReview, deletePermanently?: string[]): Promise<void> => {
    const operationId = crypto.randomUUID();
    const off = subscribe("repo:removalProgress", (p) => {
      if (p.operationId === operationId) setPhase({ kind: "running", steps: p.steps });
    });
    setPhase({ kind: "running", steps: [] });
    try {
      const result = await dispatch("repo:remove", {
        operationId,
        repoId: r.repoId,
        decisions,
        ...(name === "" ? {} : { confirmName: name }),
        ...(deletePermanently === undefined ? {} : { deletePermanently })
      });
      if (!result.ok) {
        setError(firstLine(result.error.message));
        await load();
        return;
      }
      setPhase({ kind: "result", result: result.value });
      if (result.value.outcome === "removed") onRemoved?.();
    } finally {
      off();
    }
  };

  const start = async (): Promise<void> => {
    if (review === null || status === null || !status.ready || busy) return;
    if (status.needsName && name !== review.name) return;
    setError(null);
    let current = review;
    if (status.pushWorktreeIds.length > 0 || status.pushBranches.length > 0) {
      const failure = await pushFirst(current, status.pushWorktreeIds, status.pushBranches);
      const fresh = await load();
      if (failure !== null) {
        setError(failure);
        return;
      }
      if (fresh === null) return;
      current = fresh;
      const after = removalStatus(fresh, decisions);
      if (!after.ready || after.pushWorktreeIds.length > 0 || after.pushBranches.length > 0) {
        setError("Pushed. Something else changed since the review: look it over again.");
        return;
      }
    }
    await execute(current);
  };

  const deleteFailed = async (step: RemovalStep): Promise<void> => {
    if (review === null) return;
    const ok = await confirmDialog({
      title: `Delete ${step.label} permanently?`,
      message: `${step.path} could not go to the Trash. Deleting it skips the Trash: it cannot be restored from there.`,
      confirmLabel: "Delete permanently",
      danger: true
    });
    if (ok) await execute(review, [step.path]);
  };

  const linked = review?.checkouts.filter((c) => !c.isPrimary) ?? [];
  const primary = review?.checkouts.find((c) => c.isPrimary) ?? null;
  const decidedRow = (worktreeId: string): RemovalChoice | undefined =>
    decisions.checkouts[worktreeId];

  const renderCheckout = (checkout: RemovalCheckout) => {
    const verdict = checkoutVerdict(checkout);
    const choices = checkoutChoices(checkout);
    const choice = decidedRow(checkout.worktreeId);
    const pushOff = pushOffReason(checkout);
    // A row the removal no longer reaches: the main checkout of a partial
    // removal, which stays whatever the answer.
    const stays = checkout.isPrimary && status?.partial === true;
    return (
      <li key={checkout.worktreeId} className={`remove-repo__row is-${stays ? "stays" : verdict}`}>
        <div className="remove-repo__row-head">
          <span className="remove-repo__name">{checkout.isPrimary ? repo.name : checkoutLabel(checkout)}</span>
          {checkout.isPrimary && checkout.branch !== "" && (
            <span className="remove-repo__branch">{checkout.branch}</span>
          )}
          <span className={`remove-repo__verdict is-${stays ? "stays" : choice === "keep" ? "keep" : verdict}`}>
            {stays ? "stays" : choice === "keep" ? "keep" : verdictLabel[verdict]}
          </span>
          {checkout.bytes !== null && !stays && (
            <span className="remove-repo__size">{sizeLabel(checkout.bytes, checkout.bytesPartial)}</span>
          )}
        </div>
        <div className="remove-repo__path">{checkout.path}</div>
        <div className="remove-repo__facts">{checkoutFacts(checkout)}</div>
        {!stays && verdict === "blocked" && (
          <div className="remove-repo__choice">
            <button
              type="button"
              className="settings-button"
              disabled={busy}
              onClick={() => {
                onOpenWorktree(checkout.worktreeId);
                onClose();
              }}
            >
              Open worktree
            </button>
            <SettingsSegmented<RemovalChoice | "">
              aria-label={`What to do with ${checkoutLabel(checkout)}`}
              disabled={busy}
              options={[{ value: "keep", label: "Keep" }]}
              value={choice ?? ""}
              onChange={(value) => value !== "" && setCheckout(checkout.worktreeId, value)}
            />
          </div>
        )}
        {!stays && verdict === "at_risk" && (
          <div className="remove-repo__choice">
            <SettingsSegmented<RemovalChoice | "">
              aria-label={`What to do with ${checkoutLabel(checkout)}`}
              disabled={busy}
              options={choices.map((value) => ({ value, label: CHOICE_LABEL[value] }))}
              value={choice ?? ""}
              onChange={(value) => value !== "" && setCheckout(checkout.worktreeId, value)}
            />
            {pushOff !== null && <span className="remove-repo__note">{pushOff}</span>}
          </div>
        )}
      </li>
    );
  };

  const renderBranch = (branch: RemovalBranch) => {
    const choice = decisions.branches[branch.name];
    return (
      <li key={branch.name} className="remove-repo__row is-at_risk">
        <div className="remove-repo__row-head">
          <span className="remove-repo__name">{branch.name}</span>
          <span className={`remove-repo__verdict is-${choice === "keep" ? "keep" : "at_risk"}`}>
            {choice === "keep" ? "keep" : "at risk"}
          </span>
        </div>
        <div className="remove-repo__facts">
          {branch.unpushed} {branch.unpushed === 1 ? "commit" : "commits"} on no remote · not checked out
        </div>
        <div className="remove-repo__choice">
          <SettingsSegmented<RemovalChoice | "">
            aria-label={`What to do with ${branch.name}`}
            disabled={busy}
            options={branchChoices(branch).map((value) => ({ value, label: CHOICE_LABEL[value] }))}
            value={choice ?? ""}
            onChange={(value) => value !== "" && setBranch(branch.name, value)}
          />
        </div>
      </li>
    );
  };

  const renderStashes = (r: RepoRemovalReview) => {
    const choice = decisions.stashes;
    return (
      <li className="remove-repo__row is-at_risk">
        <div className="remove-repo__row-head">
          <span className="remove-repo__name">
            {r.stashes.count} {r.stashes.count === 1 ? "stash" : "stashes"}
          </span>
          <span className={`remove-repo__verdict is-${choice === "keep" ? "keep" : "at_risk"}`}>
            {choice === "keep" ? "keep" : "at risk"}
          </span>
        </div>
        {r.stashes.newestSubject !== null && (
          <div className="remove-repo__facts">Newest: {r.stashes.newestSubject}</div>
        )}
        <div className="remove-repo__choice">
          <SettingsSegmented<RemovalChoice | "">
            aria-label="What to do with the stashes"
            disabled={busy}
            options={[
              { value: "keep", label: "Keep" },
              { value: "discard", label: "Discard" }
            ]}
            value={choice ?? ""}
            onChange={(value) =>
              value !== "" && setDecisions((d) => ({ ...d, stashes: value }))
            }
          />
        </div>
      </li>
    );
  };

  const renderSteps = (steps: RemovalStep[]) => (
    <ol className="remove-repo__steps">
      {steps.map((step) => (
        <li key={step.id} className={`remove-repo__step is-${step.status}`}>
          <span className="remove-repo__step-status">{step.status}</span>
          <span className="remove-repo__step-label">{stepLabel(step)}</span>
          {step.message !== undefined && (
            <span className="remove-repo__step-message">{step.message}</span>
          )}
          {step.status === "failed" && phase.kind === "result" && (
            <span className="remove-repo__step-actions">
              <button type="button" className="settings-button" onClick={() => revealPath(step.path)}>
                {revealLabel(platform)}
              </button>
              <button
                type="button"
                className="settings-button settings-button--danger"
                onClick={() => void deleteFailed(step)}
              >
                Delete permanently…
              </button>
            </span>
          )}
        </li>
      ))}
    </ol>
  );

  const headline =
    phase.kind === "result" && review !== null ? resultHeadline(review, phase.result) : null;

  return (
    <div
      className="overlay-backdrop"
      onClick={() => {
        if (!busy) onClose();
      }}
    >
      <div
        ref={modalRef}
        aria-modal="true"
        tabIndex={-1}
        className="modal modal--remove-repo"
        role="dialog"
        aria-labelledby={titleId}
        aria-busy={busy || phase.kind === "loading"}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="remove-repo__eyebrow">Remove repository</div>
        <div className="modal__title" id={titleId}>
          {headline?.title ?? `Remove ${repo.name} from disk`}
        </div>

        {phase.kind === "loading" && (
          <p className="remove-repo__lede">
            Checking {repo.worktrees.length} {repo.worktrees.length === 1 ? "checkout" : "checkouts"} for work that is not on a remote…
          </p>
        )}

        {headline !== null && <p className="remove-repo__lede">{headline.message}</p>}

        {review !== null && status !== null && (phase.kind === "review" || phase.kind === "pushing") && (
          <>
            <div className="remove-repo__fates">
              <div className="remove-repo__fate">
                <div className="remove-repo__fate-title">Moved to the Trash</div>
                <div>
                  {status.folderCount} {status.folderCount === 1 ? "folder" : "folders"} ·{" "}
                  {sizeLabel(status.bytes, review.checkouts.some((c) => c.bytesPartial))}
                </div>
                <div className="remove-repo__fate-note">Restorable from the Trash until it is emptied.</div>
              </div>
              <div className="remove-repo__fate">
                <div className="remove-repo__fate-title">Not touched</div>
                {review.remotes.length === 0 ? (
                  <div>No remotes. Nothing of this repository exists anywhere else.</div>
                ) : (
                  review.remotes.map((remote) => (
                    <div key={remote.name} className="remove-repo__remote">
                      <span className="remove-repo__remote-name">{remote.name}</span>{" "}
                      <span className="remove-repo__remote-url">{remote.url}</span>
                    </div>
                  ))
                )}
                <div className="remove-repo__fate-note">The remote keeps every pushed branch.</div>
              </div>
            </div>

            <div className="remove-repo__list">
              {linked.length > 0 && (
                <section aria-label="Linked worktrees">
                  <div className="remove-repo__group">
                    Linked worktrees <span className="remove-repo__count">{linked.length}</span> · removed first
                  </div>
                  <ul>{linked.map(renderCheckout)}</ul>
                </section>
              )}
              {primary !== null && (
                <section aria-label="Main checkout">
                  <div className="remove-repo__group">
                    Main checkout <span className="remove-repo__count">1</span> · removed last, holds .git
                  </div>
                  <ul>
                    {renderCheckout(primary)}
                    {!status.partial && review.stashes.count > 0 && renderStashes(review)}
                    {!status.partial && review.branches.map(renderBranch)}
                  </ul>
                </section>
              )}
            </div>

            {status.partial && <p className="remove-repo__callout">{partialCallout(review, status)}</p>}

            {status.needsName && (
              <p className="remove-repo__discards">
                This discards {status.discards.join("; ")}. None of it is on a remote.
              </p>
            )}
            {status.needsName && (
              <label className="field remove-repo__gate">
                <span className="field__label">Type {review.name} to remove it</span>
                <input
                  className="modal__input"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={busy}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
            )}
          </>
        )}

        {phase.kind === "running" && (
          <>
            {renderSteps(phase.steps)}
            <p className="remove-repo__fate-note">A step that fails stops the main checkout from being touched.</p>
          </>
        )}
        {phase.kind === "result" && renderSteps(phase.result.steps)}

        {error !== null && (
          <div className="modal__error" role="alert">
            {error}
          </div>
        )}

        <div className="modal__actions remove-repo__actions">
          {status !== null && phase.kind === "review" && (
            <span className="remove-repo__status" aria-live="polite">
              {statusLine(status)}
            </span>
          )}
          {phase.kind === "pushing" && (
            <span className="remove-repo__status" aria-live="polite">
              {phase.label}
            </span>
          )}
          {phase.kind === "result" ? (
            <>
              {phase.result.outcome === "stopped" && review !== null && (
                <button type="button" className="modal__cancel" onClick={() => void execute(review)}>
                  Retry
                </button>
              )}
              <button ref={cancelRef} type="button" className="modal__create" onClick={onClose}>
                Done
              </button>
            </>
          ) : (
            <>
              <button
                ref={cancelRef}
                className="modal__cancel"
                type="button"
                disabled={busy}
                onClick={onClose}
              >
                Cancel
              </button>
              {review !== null && status !== null && (
                <button
                  className="modal__create modal__create--danger"
                  type="button"
                  disabled={
                    busy ||
                    phase.kind !== "review" ||
                    !status.ready ||
                    (status.needsName && name !== review.name)
                  }
                  onClick={() => void start()}
                >
                  {removeButtonLabel(review, status)}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
