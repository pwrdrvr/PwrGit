import { useMemo, useState } from "react";
import type {
  PushRefPlan,
  PushRefResult,
  Repo,
  RepoRefs
} from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";
import {
  BranchRefPicker,
  type BranchPickerOption
} from "../shell/BranchRefPicker";
import { CopyTarget } from "../shell/CopyTarget";

/**
 * The branch name a push should default to for `option` — the name relative to
 * its remote for a remote-tracking ref, the plain name for a local one. The
 * picker already carries both, so this no longer has to search a repo-wide
 * ref list that is now only a preview.
 */
function sourceBranchName(option: BranchPickerOption): string {
  return option.remoteBranch?.name ?? option.label;
}

function relationLabel(plan: PushRefPlan): string {
  switch (plan.relation) {
    case "create":
      return "Will create";
    case "equal":
      return "Up to date";
    case "fast_forward":
      return "Fast-forward";
    case "destination_ahead":
      return "Destination ahead";
    case "diverged":
      return "Diverged";
  }
}

function isSafe(plan: PushRefPlan): boolean {
  return (
    plan.relation === "create" ||
    plan.relation === "equal" ||
    plan.relation === "fast_forward"
  );
}

function shortHead(head: string | undefined): string {
  return head === undefined ? "new" : head.slice(0, 7);
}

export function PushRefsDialog({
  repo,
  refs,
  onCompleted,
  onClose
}: {
  repo: Repo;
  refs: RepoRefs;
  onCompleted: () => void;
  onClose: () => void;
}) {
  // Locals are already loaded and bounded, so the picker filters them in place;
  // only the remote side, which can run to thousands of refs, is paged.
  const locals = useMemo<BranchPickerOption[]>(
    () =>
      refs.branches.map((branch) => ({
        ref: branch.fullName,
        label: branch.name,
        kind: "local" as const,
        head: branch.head
      })),
    [refs.branches]
  );
  const [source, setSource] = useState<BranchPickerOption | null>(null);
  const sourceRef = source?.ref ?? "";
  const [destinationBranch, setDestinationBranch] = useState("");
  const [selectedRemotes, setSelectedRemotes] = useState<Set<string>>(new Set());
  const [plans, setPlans] = useState<PushRefPlan[] | null>(null);
  const [results, setResults] = useState<PushRefResult[] | null>(null);
  const [busy, setBusy] = useState<"plan" | "push" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const resetReview = (): void => {
    setPlans(null);
    setResults(null);
    setError(null);
  };

  const review = async (): Promise<void> => {
    setBusy("plan");
    setError(null);
    setResults(null);
    const result = await dispatch("remote:planPushRefs", {
      repoId: repo.id,
      sourceRef,
      destinations: Array.from(selectedRemotes).map((remote) => ({
        remote,
        branch: destinationBranch.trim()
      }))
    });
    setBusy(null);
    if (result.ok) setPlans(result.value);
    else setError(result.error.message.split("\n")[0]);
  };

  const push = async (): Promise<void> => {
    if (plans === null || plans.some((plan) => !isSafe(plan))) return;
    const actionablePlans = plans.filter((plan) => plan.relation !== "equal");
    if (actionablePlans.length === 0) return;
    setBusy("push");
    setError(null);
    const result = await dispatch("remote:pushRefs", {
      repoId: repo.id,
      plans: actionablePlans
    });
    setBusy(null);
    if (!result.ok) {
      setError(result.error.message.split("\n")[0]);
      return;
    }
    setResults(result.value);
    onCompleted();
  };

  const safe = plans !== null && plans.every(isSafe);
  const actionableCount =
    plans?.filter((plan) => plan.relation !== "equal").length ?? 0;
  const equalCount = plans?.filter((plan) => plan.relation === "equal").length ?? 0;
  const pushedCount = results?.filter((result) => result.outcome === "pushed").length;

  return (
    <div className="overlay-backdrop refs-push-backdrop" onClick={onClose}>
      <div
        className="modal refs-push"
        role="dialog"
        aria-label={`Push ${repo.name} branch to remotes`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal__title">Push branch to remotes · {repo.name}</div>
        <BranchRefPicker
          repoId={repo.id}
          label="Source"
          locals={locals}
          onChange={(option) => {
            setSource(option);
            setDestinationBranch(sourceBranchName(option));
            resetReview();
          }}
        />
        <label className="refs-field">
          <span>Destination branch</span>
          <input
            value={destinationBranch}
            onChange={(event) => {
              setDestinationBranch(event.target.value);
              resetReview();
            }}
            placeholder="branch name"
          />
        </label>

        <div className="refs-destinations">
          <div className="refs-field__label">Destination remotes</div>
          {refs.remotes.map((remote) => (
            <label className="refs-destination" key={remote.name}>
              <input
                type="checkbox"
                checked={selectedRemotes.has(remote.name)}
                onChange={(event) => {
                  setSelectedRemotes((previous) => {
                    const next = new Set(previous);
                    if (event.target.checked) next.add(remote.name);
                    else next.delete(remote.name);
                    return next;
                  });
                  resetReview();
                }}
              />
              <span className="refs-destination__name">{remote.name}</span>
              <span className="refs-destination__url">{remote.pushUrl}</span>
            </label>
          ))}
        </div>

        {plans !== null && (
          <div className="refs-plan" aria-label="Push review">
            {plans[0] !== undefined && (
              <div className="refs-plan__notice">
                <span>Source</span>
                <CopyTarget
                  value={plans[0].sourceLabel}
                  label={`Copy source branch ${plans[0].sourceLabel}`}
                  hint={`${plans[0].sourceLabel}\nClick to copy source branch`}
                  className="refs-plan__copy copyable"
                >
                  {plans[0].sourceLabel}
                </CopyTarget>
                <code>{shortHead(plans[0].sourceHead)}</code>
                <small>
                  Fetched moments ago. Push uses a lease and stops if the source or
                  destination changes after this review.
                </small>
              </div>
            )}
            {plans.map((plan) => (
              <div
                className={`refs-plan__row refs-plan__row--${plan.relation}`}
                key={`${plan.destinationRemote}/${plan.destinationBranch}`}
              >
                <div className="refs-plan__target">
                  <CopyTarget
                    value={plan.destinationBranch}
                    label={`Copy destination branch ${plan.destinationBranch}`}
                    hint={`${plan.destinationRemote}/${plan.destinationBranch}\nClick to copy branch name`}
                    className="refs-plan__copy copyable"
                  >
                    {plan.destinationRemote}/{plan.destinationBranch}
                  </CopyTarget>
                  <small>
                    {shortHead(plan.destinationHead)} → {shortHead(plan.sourceHead)}
                  </small>
                </div>
                <span>{relationLabel(plan)}</span>
              </div>
            ))}
            {safe && equalCount > 0 && (
              <div className="refs-plan__hint">
                {actionableCount === 0
                  ? "All selected destinations already match the source."
                  : `${equalCount} up-to-date destination${equalCount === 1 ? "" : "s"} will be skipped.`}
              </div>
            )}
            {!safe && (
              <div className="modal__error">
                Every destination must be a create, fast-forward, or already equal.
                Uncheck unsafe destinations and review again.
              </div>
            )}
          </div>
        )}

        {results !== null && (
          <div className="refs-plan" role="status">
            {results.map((result) => (
              <div
                className={`refs-plan__row refs-plan__row--${result.outcome}`}
                key={`${result.destinationRemote}/${result.destinationBranch}`}
              >
                <span>
                  {result.destinationRemote}/{result.destinationBranch}
                </span>
                <span>{result.outcome.replaceAll("_", " ")}</span>
                {result.message !== undefined && <small>{result.message}</small>}
              </div>
            ))}
            <div className="modal__hint">
              {pushedCount ?? 0} destination{pushedCount === 1 ? "" : "s"} updated.
            </div>
          </div>
        )}

        {error !== null && <div className="modal__error">{error}</div>}
        <div className="modal__actions">
          <button className="modal__cancel" onClick={onClose}>
            {results === null ? "Cancel" : "Close"}
          </button>
          {results === null && plans === null && (
            <button
              className="modal__create"
              disabled={
                busy !== null ||
                sourceRef === "" ||
                destinationBranch.trim() === "" ||
                selectedRemotes.size === 0
              }
              onClick={() => void review()}
            >
              {busy === "plan" ? "Fetching and comparing…" : "Review push"}
            </button>
          )}
          {results === null && plans !== null && (
            <>
              <button className="modal__cancel" onClick={resetReview}>
                Edit
              </button>
              <button
                className="modal__create"
                disabled={busy !== null || !safe || actionableCount === 0}
                onClick={() => void push()}
              >
                {busy === "push"
                  ? "Pushing…"
                  : actionableCount === 0
                    ? "Nothing to push"
                    : `Push to ${actionableCount} remote${actionableCount === 1 ? "" : "s"}`}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
