import { useMemo, useState } from "react";
import type {
  PushRefPlan,
  PushRefResult,
  Repo,
  RepoRefs
} from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";

function sourceBranchName(sourceRef: string, refs: RepoRefs): string {
  const local = refs.branches.find((branch) => branch.fullName === sourceRef);
  if (local !== undefined) return local.name;
  for (const remote of refs.remotes) {
    const branch = remote.branches.find((candidate) => candidate.fullName === sourceRef);
    if (branch !== undefined) return branch.name;
  }
  return "";
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
  const sources = useMemo(
    () => [
      ...refs.branches.map((branch) => ({
        ref: branch.fullName,
        label: branch.name,
        kind: "Local"
      })),
      ...refs.remotes.flatMap((remote) =>
        remote.branches.map((branch) => ({
          ref: branch.fullName,
          label: branch.qualifiedName,
          kind: "Remote"
        }))
      )
    ],
    [refs]
  );
  const firstSource = sources[0]?.ref ?? "";
  const [sourceRef, setSourceRef] = useState(firstSource);
  const [destinationBranch, setDestinationBranch] = useState(() =>
    sourceBranchName(firstSource, refs)
  );
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
    setBusy("push");
    setError(null);
    const result = await dispatch("remote:pushRefs", { repoId: repo.id, plans });
    setBusy(null);
    if (!result.ok) {
      setError(result.error.message.split("\n")[0]);
      return;
    }
    setResults(result.value);
    onCompleted();
  };

  const safe = plans !== null && plans.every(isSafe);
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
        <label className="refs-field">
          <span>Source</span>
          <select
            value={sourceRef}
            onChange={(event) => {
              const next = event.target.value;
              setSourceRef(next);
              setDestinationBranch(sourceBranchName(next, refs));
              resetReview();
            }}
          >
            {sources.map((source) => (
              <option key={source.ref} value={source.ref}>
                {source.label} · {source.kind}
              </option>
            ))}
          </select>
        </label>
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
            {plans.map((plan) => (
              <div
                className={`refs-plan__row refs-plan__row--${plan.relation}`}
                key={`${plan.destinationRemote}/${plan.destinationBranch}`}
              >
                <span>
                  {plan.destinationRemote}/{plan.destinationBranch}
                </span>
                <span>{relationLabel(plan)}</span>
              </div>
            ))}
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
                disabled={busy !== null || !safe}
                onClick={() => void push()}
              >
                {busy === "push"
                  ? "Pushing…"
                  : `Push to ${plans.length} remote${plans.length === 1 ? "" : "s"}`}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
