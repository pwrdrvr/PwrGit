import {
  type CSSProperties,
  useCallback,
  useEffect,
  useRef,
  useState
} from "react";
import type {
  SubmoduleCheckoutState,
  SubmoduleRelation,
  SubmoduleSnapshot,
  SubmoduleStatus
} from "@pwrgit/shared";
import { dispatch, subscribe } from "../../lib/pwrgit";

const shortSha = (sha: string | undefined): string => sha?.slice(0, 8) ?? "—";

const CHECKOUT_LABEL: Record<SubmoduleCheckoutState, string> = {
  checked_out: "Checked out",
  uninitialized: "Uninitialized",
  deinitialized: "Deinitialized",
  missing: "Missing",
  not_repository: "Not a checkout"
};

const RELATION_LABEL: Record<SubmoduleRelation, string> = {
  at_pin: "At pin",
  ahead_of_pin: "Ahead of pin",
  behind_pin: "Behind pin",
  diverged_from_pin: "Diverged",
  unknown: "Unknown relation"
};

function relationTone(relation: SubmoduleRelation): string {
  if (relation === "at_pin") return "ok";
  if (relation === "unknown") return "muted";
  return "warn";
}

function checkoutTone(state: SubmoduleCheckoutState): string {
  if (state === "checked_out") return "ok";
  if (state === "uninitialized" || state === "deinitialized") return "warn";
  return "danger";
}

function snapshotHasConcern(snapshot: SubmoduleSnapshot): boolean {
  return (
    snapshot.issues.length > 0 ||
    snapshot.submodules.some(
      (submodule) =>
        submodule.dirty === true ||
        submodule.issues.length > 0 ||
        (submodule.relation !== "at_pin" && submodule.relation !== "unknown")
    )
  );
}

function SubmoduleRow({ submodule }: { submodule: SubmoduleStatus }) {
  const expected = submodule.indexCommit ?? submodule.pinnedCommit;
  const stagedPinMoved =
    submodule.indexCommit !== undefined &&
    submodule.indexCommit !== submodule.pinnedCommit;
  const hasConcern =
    submodule.issues.length > 0 ||
    submodule.dirty === true ||
    (submodule.relation !== "at_pin" && submodule.relation !== "unknown");

  return (
    <details
      className="submodule-row"
      style={{ "--submodule-depth": submodule.depth } as CSSProperties}
      open={hasConcern || undefined}
    >
      <summary className="submodule-row__summary">
        <span className="submodule-row__path" title={submodule.path}>
          {submodule.path}
        </span>
        {submodule.dirty === true && (
          <span className="submodule-chip submodule-chip--warn">Dirty</span>
        )}
        <span
          className={`submodule-chip submodule-chip--${relationTone(submodule.relation)}`}
        >
          {RELATION_LABEL[submodule.relation]}
        </span>
        <span
          className={`submodule-chip submodule-chip--${checkoutTone(submodule.checkoutState)}`}
        >
          {CHECKOUT_LABEL[submodule.checkoutState]}
        </span>
      </summary>

      <div className="submodule-row__body">
        <div className="submodule-fact">
          <span className="submodule-fact__label">Parent pin</span>
          <span
            className="submodule-fact__value"
            title={submodule.pinnedCommit}
          >
            {shortSha(submodule.pinnedCommit)}
          </span>
          {submodule.pinnedTags.map((tag) => (
            <span className="submodule-tag" key={tag} title={`Tag ${tag}`}>
              {tag}
            </span>
          ))}
        </div>
        {stagedPinMoved && (
          <div className="submodule-fact">
            <span className="submodule-fact__label">Next pin</span>
            <span
              className="submodule-fact__value"
              title={submodule.indexCommit}
            >
              {shortSha(submodule.indexCommit)}
            </span>
            <span className="submodule-fact__note">staged in parent</span>
          </div>
        )}
        <div className="submodule-fact">
          <span className="submodule-fact__label">Checkout</span>
          <span
            className="submodule-fact__value"
            title={submodule.checkedOutCommit}
          >
            {shortSha(submodule.checkedOutCommit)}
          </span>
          {submodule.detached === true ? (
            <span className="submodule-fact__note">detached HEAD</span>
          ) : submodule.checkedOutBranch !== undefined ? (
            <span className="submodule-fact__note">
              branch {submodule.checkedOutBranch}
            </span>
          ) : null}
        </div>
        <div className="submodule-fact">
          <span className="submodule-fact__label">Tracking hint</span>
          <span className="submodule-fact__value">
            {submodule.configuredBranch ?? "—"}
          </span>
        </div>
        <div className="submodule-fact submodule-fact--stacked">
          <span className="submodule-fact__label">.gitmodules URL</span>
          <span
            className="submodule-fact__value"
            title={submodule.configuredUrl}
          >
            {submodule.configuredUrl ?? "—"}
          </span>
        </div>
        {submodule.initializedUrl !== undefined &&
          submodule.initializedUrl !== submodule.configuredUrl && (
            <div className="submodule-fact submodule-fact--stacked">
              <span className="submodule-fact__label">Initialized URL</span>
              <span
                className="submodule-fact__value"
                title={submodule.initializedUrl}
              >
                {submodule.initializedUrl}
              </span>
            </div>
          )}

        {expected !== undefined && submodule.checkedOutCommit !== undefined && (
          <span className="a11y-sr-only">
            Expected commit {expected}; checked out commit{" "}
            {submodule.checkedOutCommit}.
          </span>
        )}

        {submodule.issues.length > 0 && (
          <ul className="submodule-issues">
            {submodule.issues.map((problem, index) => (
              <li
                className={`submodule-issue submodule-issue--${problem.severity}`}
                key={`${problem.code}-${index}`}
              >
                <span>{problem.message}</span>
                {problem.remedy !== undefined && (
                  <small>{problem.remedy}</small>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}

export function SubmodulePanel({
  worktreeId,
  onConcernChange
}: {
  worktreeId: string;
  onConcernChange?: (hasConcern: boolean) => void;
}) {
  const [snapshot, setSnapshot] = useState<SubmoduleSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Ignore an older request that resolves after a worktree switch or refresh.
  const requestRef = useRef(0);
  // One scan per selected worktree at a time. A PwrGit mutation can emit both
  // worktree:changed and changes:changed; those signals describe the same new
  // state and must not queue two 20-child walks back to back.
  const inFlightRef = useRef(false);

  const load = useCallback(() => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    const request = ++requestRef.current;
    setLoading(true);
    void dispatch("submodules:list", { worktreeId })
      .then((result) => {
        if (request !== requestRef.current) return;
        if (result.ok) {
          setSnapshot(result.value);
          setError(null);
          onConcernChange?.(snapshotHasConcern(result.value));
        } else {
          setError(result.error.message);
          onConcernChange?.(true);
        }
        setLoading(false);
      })
      .finally(() => {
        if (request === requestRef.current) inFlightRef.current = false;
      });
  }, [onConcernChange, worktreeId]);

  useEffect(() => {
    setSnapshot(null);
    setError(null);
    onConcernChange?.(false);
    load();
    const offWorktree = subscribe("worktree:changed", (event) => {
      if (event.worktreeId === worktreeId) load();
    });
    const offChanges = subscribe("changes:changed", (event) => {
      if (event.worktreeId === worktreeId) load();
    });
    return () => {
      requestRef.current += 1;
      inFlightRef.current = false;
      offWorktree();
      offChanges();
    };
  }, [load, onConcernChange, worktreeId]);

  if (
    !loading &&
    error === null &&
    snapshot !== null &&
    snapshot.submodules.length === 0 &&
    snapshot.issues.length === 0
  ) {
    return null;
  }

  return (
    <section className="submodule-panel" aria-label="Submodules">
      <div className="submodule-panel__head">
        <span>Submodules</span>
        {snapshot !== null && (
          <span className="submodule-panel__count">
            {snapshot.submodules.length}
          </span>
        )}
        <span className="submodule-panel__spacer" />
        <button
          className="submodule-panel__refresh"
          onClick={load}
          disabled={loading}
          aria-label="Refresh submodules"
        >
          {loading ? "Checking…" : "Refresh"}
        </button>
      </div>

      {error !== null && (
        <div className="submodule-panel__error" role="alert">
          <strong>Submodule scan failed.</strong>
          <span>{error}</span>
          <small>
            Parent status is still available. Open Logs for the Git diagnostic.
          </small>
        </div>
      )}

      {snapshot?.issues.map((problem, index) => (
        <div
          className={`submodule-panel__error submodule-panel__error--${problem.severity}`}
          role={problem.severity === "error" ? "alert" : "status"}
          key={`${problem.code}-${index}`}
        >
          <span>{problem.message}</span>
          {problem.remedy !== undefined && <small>{problem.remedy}</small>}
        </div>
      ))}

      {snapshot?.submodules.map((submodule) => (
        <SubmoduleRow submodule={submodule} key={submodule.path} />
      ))}

      {snapshot !== null && snapshot.submodules.length > 0 && (
        <p className="submodule-panel__legend">
          Pins come from Git’s 160000 entries. URL and branch are .gitmodules
          hints.
        </p>
      )}
    </section>
  );
}
