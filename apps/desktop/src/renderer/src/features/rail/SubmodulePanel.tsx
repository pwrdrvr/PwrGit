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
import { RefreshGlyph } from "../../lib/RefreshGlyph";
import {
  hoverTooltip,
  useViewportTooltip
} from "../../lib/useViewportTooltip";
import { SectionChevron } from "../sidebar/SectionChevron";

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

/**
 * Only active local work in a submodule (dirty child checkout, checkout moved
 * off the parent pin, staged pin move, or gitlink conflict) warrants automatic
 * attention in Changes. Passive repository states like uninitialized optional
 * submodules or unmapped vendored gitlinks leave `git status` clean and stay
 * collapsed until the user asks to inspect them.
 */
export function submoduleHasActiveChange(submodule: SubmoduleStatus): boolean {
  const stagedPinMoved =
    submodule.indexCommit !== undefined &&
    submodule.indexCommit !== submodule.pinnedCommit;
  const hasConflict = submodule.issues.some(
    (problem) => problem.code === "index_conflict"
  );
  return (
    submodule.dirty === true ||
    stagedPinMoved ||
    hasConflict ||
    (submodule.relation !== "at_pin" && submodule.relation !== "unknown")
  );
}

export function snapshotHasActiveChange(snapshot: SubmoduleSnapshot): boolean {
  return snapshot.submodules.some(submoduleHasActiveChange);
}

/**
 * A submodule that is checked out locally without error-severity issues.
 * The header count shows working submodules only so it never double-counts
 * unconfigured, uninitialized, or failing entries shown beside it.
 */
export function submoduleIsWorking(submodule: SubmoduleStatus): boolean {
  return (
    submodule.checkoutState === "checked_out" &&
    !submodule.issues.some((problem) => problem.severity === "error")
  );
}

type SummaryBadge = { label: string; tone: "warn" | "danger" | "muted" };

function nonWorkingLabel(nonWorking: SubmoduleStatus[]): string {
  const count = nonWorking.length;
  if (
    nonWorking.every(
      (submodule) =>
        submodule.issues.some(
          (problem) => problem.code === "gitmodules_entry_missing"
        ) &&
        submodule.issues.every(
          (problem) =>
            problem.code === "gitmodules_entry_missing" ||
            problem.code === "checkout_uninitialized"
        )
    )
  ) {
    return `${count} unconfigured`;
  }
  if (
    nonWorking.every(
      (submodule) =>
        submodule.checkoutState === "uninitialized" &&
        submodule.issues.every(
          (problem) => problem.code === "checkout_uninitialized"
        )
    )
  ) {
    return `${count} uninitialized`;
  }
  if (
    nonWorking.every(
      (submodule) =>
        submodule.checkoutState === "deinitialized" &&
        submodule.issues.every(
          (problem) => problem.code === "checkout_deinitialized"
        )
    )
  ) {
    return `${count} deinitialized`;
  }
  if (
    nonWorking.some((submodule) =>
      submodule.issues.some((problem) => problem.severity === "error")
    )
  ) {
    return `${count} failing`;
  }
  return `${count} inactive`;
}

function summaryBadgesFor(
  snapshot: SubmoduleSnapshot | null,
  error: string | null
): SummaryBadge[] {
  if (error !== null) return [{ label: "Scan failed", tone: "danger" }];
  if (snapshot === null) return [];

  const badges: SummaryBadge[] = [];
  const working = snapshot.submodules.filter(submoduleIsWorking);
  const nonWorking = snapshot.submodules.filter(
    (submodule) => !submoduleIsWorking(submodule)
  );
  const activeWorking = working.filter(submoduleHasActiveChange).length;

  if (activeWorking > 0) {
    badges.push({ label: `${activeWorking} changed`, tone: "warn" });
  }
  if (nonWorking.length > 0) {
    badges.push({ label: nonWorkingLabel(nonWorking), tone: "muted" });
  }
  if (badges.length === 0) {
    const warningRows = working.filter(
      (submodule) => submodule.issues.length > 0
    );
    const total = warningRows.length + snapshot.issues.length;
    if (total > 0) {
      badges.push({
        label: `${total} ${total === 1 ? "notice" : "notices"}`,
        tone: "muted"
      });
    }
  }
  return badges;
}

function renderSubmodulePath(path: string) {
  const slash = path.lastIndexOf("/");
  if (slash < 0) {
    return <span className="submodule-row__leaf">{path}</span>;
  }
  return (
    <>
      <span className="submodule-row__dir">{path.slice(0, slash)}</span>
      <span className="submodule-row__sep">/</span>
      <span className="submodule-row__leaf">{path.slice(slash + 1)}</span>
    </>
  );
}

function SubmoduleRow({ submodule }: { submodule: SubmoduleStatus }) {
  const tip = useViewportTooltip();
  const expected = submodule.indexCommit ?? submodule.pinnedCommit;
  const stagedPinMoved =
    submodule.indexCommit !== undefined &&
    submodule.indexCommit !== submodule.pinnedCommit;
  const activeChange = submoduleHasActiveChange(submodule);
  const showRelationChip =
    submodule.checkoutState === "checked_out" ||
    submodule.relation !== "unknown";
  const seenRemedies = new Set<string>();
  const renderedIssues = submodule.issues.map((problem) => {
    const remedy =
      problem.remedy !== undefined && !seenRemedies.has(problem.remedy)
        ? problem.remedy
        : undefined;
    if (remedy !== undefined) seenRemedies.add(remedy);
    return { problem, remedy };
  });

  return (
    <details
      className="submodule-row"
      style={{ "--submodule-depth": submodule.depth } as CSSProperties}
      open={activeChange || undefined}
    >
      <summary className="submodule-row__summary">
        <span
          className="submodule-row__path"
          {...hoverTooltip(tip, submodule.path)}
        >
          {renderSubmodulePath(submodule.path)}
        </span>
        {submodule.dirty === true && (
          <span className="submodule-chip submodule-chip--warn">Dirty</span>
        )}
        {showRelationChip && (
          <span
            className={`submodule-chip submodule-chip--${relationTone(submodule.relation)}`}
          >
            {RELATION_LABEL[submodule.relation]}
          </span>
        )}
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
            {...hoverTooltip(tip, submodule.pinnedCommit)}
          >
            {shortSha(submodule.pinnedCommit)}
          </span>
          {submodule.pinnedTags.map((tag) => (
            <span
              className="submodule-tag"
              key={tag}
              {...hoverTooltip(tip, `Tag ${tag}`)}
            >
              {tag}
            </span>
          ))}
        </div>
        {stagedPinMoved && (
          <div className="submodule-fact">
            <span className="submodule-fact__label">Next pin</span>
            <span
              className="submodule-fact__value"
              {...hoverTooltip(tip, submodule.indexCommit)}
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
            {...hoverTooltip(tip, submodule.checkedOutCommit)}
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
            {...hoverTooltip(tip, submodule.configuredUrl)}
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
                {...hoverTooltip(tip, submodule.initializedUrl)}
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

        {renderedIssues.length > 0 && (
          <ul className="submodule-issues">
            {renderedIssues.map(({ problem, remedy }, index) => (
              <li
                className={`submodule-issue submodule-issue--${problem.severity}`}
                key={`${problem.code}-${index}`}
              >
                <span>{problem.message}</span>
                {remedy !== undefined && <small>{remedy}</small>}
              </li>
            ))}
          </ul>
        )}
      </div>
      {tip.tooltipNode}
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
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
  // Ignore an older request that resolves after a worktree switch or refresh.
  const requestRef = useRef(0);
  // One scan per selected worktree at a time. A PwrGit mutation can emit both
  // worktree:changed and changes:changed; those signals describe the same new
  // state and must not queue two 20-child walks back to back.
  const inFlightRef = useRef(false);
  // An event that lands after the running scan read its state but before the
  // promise settles represents potentially newer state. Coalesce any number
  // of such events into exactly one trailing scan instead of dropping them.
  const pendingRefreshRef = useRef(false);

  const load = useCallback(() => {
    if (inFlightRef.current) {
      pendingRefreshRef.current = true;
      return;
    }
    inFlightRef.current = true;
    const run = async (): Promise<void> => {
      while (true) {
        pendingRefreshRef.current = false;
        const request = ++requestRef.current;
        setLoading(true);
        try {
          const result = await dispatch("submodules:list", { worktreeId });
          if (request !== requestRef.current) return;
          if (result.ok) {
            setSnapshot(result.value);
            setError(null);
            onConcernChange?.(snapshotHasActiveChange(result.value));
          } else {
            setError(result.error.message);
            onConcernChange?.(true);
          }
        } catch (cause) {
          if (request !== requestRef.current) return;
          setError(cause instanceof Error ? cause.message : String(cause));
          onConcernChange?.(true);
        }
        setLoading(false);
        if (!pendingRefreshRef.current) {
          inFlightRef.current = false;
          return;
        }
      }
    };
    void run();
  }, [onConcernChange, worktreeId]);

  useEffect(() => {
    setSnapshot(null);
    setError(null);
    setUserExpanded(null);
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
      pendingRefreshRef.current = false;
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

  const defaultExpanded =
    error !== null || (snapshot !== null && snapshotHasActiveChange(snapshot));
  const expanded = userExpanded ?? defaultExpanded;
  const workingCount =
    snapshot === null
      ? null
      : snapshot.submodules.filter(submoduleIsWorking).length;
  const summaryBadges = summaryBadgesFor(snapshot, error);

  return (
    <section className="submodule-panel" aria-label="Submodules">
      <div className={`submodule-panel__head${expanded ? " is-open" : ""}`}>
        <button
          type="button"
          className="submodule-panel__toggle"
          aria-expanded={expanded}
          onClick={() => setUserExpanded(!expanded)}
        >
          <SectionChevron open={expanded} />
          <span>Submodules</span>
          {workingCount !== null && (
            <span className="submodule-panel__count">{workingCount}</span>
          )}
          {summaryBadges.map((badge) => (
            <span
              key={badge.label}
              className={`submodule-chip submodule-chip--${badge.tone}`}
            >
              {badge.label}
            </span>
          ))}
        </button>
        <button
          type="button"
          className="submodule-panel__refresh"
          /* Busy is aria-disabled, not `disabled`: Chromium blurs an element
             the moment it becomes disabled, so refreshing from the keyboard
             threw focus back to <body> (SC 2.4.3). The guard below is what
             makes it inert. Same fix as .wt-refresh and .ref-fetch-all. */
          aria-disabled={loading}
          aria-busy={loading}
          onClick={() => {
            if (loading) return;
            load();
          }}
          aria-label="Refresh submodules"
        >
          <RefreshGlyph size={11} />
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {expanded && (
        <>
          {error !== null && (
            <div className="submodule-panel__error" role="alert">
              <strong>Submodule scan failed.</strong>
              <span>{error}</span>
              <small>
                Parent status is still available. Open Logs for the Git
                diagnostic.
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
              Pins come from Git’s 160000 entries. URL and branch are
              .gitmodules hints.
            </p>
          )}
        </>
      )}
    </section>
  );
}
