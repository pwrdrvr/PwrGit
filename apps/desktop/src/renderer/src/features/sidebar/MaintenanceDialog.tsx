import { useEffect, useRef, useState } from "react";
import {
  BRANCH_CLEANUP_KEEP_DAYS,
  DEFAULT_BRANCH_CLEANUP_OPTIONS,
  type BranchCleanupKeepDays,
  type BranchCleanupOptions,
  type DeletedBranchResult,
  type GarbageCollectionMode,
  type KeptBranch,
  type KeptBranchReason,
  type MaintenanceAction,
  type MaintenanceRepo,
  type MaintenanceRepoResult,
  type MaintenanceSummary,
  type StaleBranch
} from "@pwrgit/shared";
import { dispatch, subscribe } from "../../lib/pwrgit";
import { displayPath } from "../../lib/platform";
import { useModal } from "../../lib/useModal";
import { MaintenancePlanForm, MaintenanceSteps, MaintenanceRulesApplied, type MaintenancePlan, type StepKey, type StepResult } from "./MaintenancePlan";
import { PruneWorktreesPanel } from "./PruneWorktreesPanel";
import { BulkSyncStatus } from "./BulkSyncStatus";
import { countOutcomes } from "./bulk-sync-progress";

const branchKey = (branch: StaleBranch): string =>
  `${branch.repoId}:${branch.branch}`;
/** How many Finished rows a repository shows before "Show all". One
 *  repository with 200 finished branches must not push the others away. */
const FINISHED_SLICE = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

/** "today", "3 days ago", "5 weeks ago", "4 months ago". */
function ago(at: number, now: number): string {
  const days = Math.max(0, Math.floor((now - at) / DAY_MS));
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  if (days < 730) return `${Math.round(days / 30)} months ago`;
  return `${Math.round(days / 365)} years ago`;
}

/** The evidence line under a Finished row. */
export function finishedEvidence(branch: StaleBranch, now: number): string {
  const touched =
    branch.touchedAt === undefined ? "" : ` · touched ${ago(branch.touchedAt, now)}`;
  if (branch.evidence === "ancestry") return `Already in HEAD${touched}`;
  const merged =
    branch.pr?.mergedAt === undefined ? "" : ` ${ago(branch.pr.mergedAt, now)}`;
  return `#${branch.pr?.number ?? "?"} merged${merged} · tip is its head${touched}`;
}

/** A Kept chip's words, per reason. `keepDays` names the guard that held. */
function keptLabel(
  reason: KeptBranchReason,
  keepDays: BranchCleanupKeepDays | null
): string {
  switch (reason) {
    case "worktree":
      return "checked out in a worktree";
    case "unmerged_commits":
      return "commits not in their PR";
    case "pr_closed":
      return "closed without merging";
    case "pr_open":
      return "PR still open";
    case "no_proof":
      return "no merged PR";
    case "pr_proof_off":
      return "squash merges, PR proof off";
    case "recent":
      return keepDays === null
        ? "touched recently"
        : `touched in the last ${keepDays} ${keepDays === 1 ? "day" : "days"}`;
  }
}

const bytes = (value: number): string => {
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 * 1024 * 1024)
    return `${(value / 1024 / 1024).toFixed(1)} MiB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GiB`;
};

export function MaintenanceDialog({
  profileId,
  platform,
  onClose,
  onRemoveWorktrees,
  initialTab = "combined",
  repoScope,
  autoReview = false,
  now = Date.now
}: {
  profileId: string;
  platform: string;
  onClose: () => void;
  onRemoveWorktrees: (ids: string[]) => Promise<void>;
  initialTab?: "combined" | "gc" | "branches" | "worktrees";
  /** Review one repository only — the refs browser's "Clean up finished
   *  branches…" opens the dialog on the repository it was showing. */
  repoScope?: { id: string; name: string } | undefined;
  /** Start the branch review on open, with the saved options. Set only by
   *  that same hand-off: the reader already asked for exactly this. */
  autoReview?: boolean;
  now?: () => number;
}) {
  const [tab, setTab] = useState<"combined" | "gc" | "branches" | "worktrees">(initialTab);
  const [worktreesBusy, setWorktreesBusy] = useState(false);
  const [worktreeCandidateCount, setWorktreeCandidateCount] = useState<number | null>(null);
  const [scopeRepoCount, setScopeRepoCount] = useState<number | null>(null);
  const [plan, setPlan] = useState<MaintenancePlan>({ worktrees: true, branches: true, gc: true });
  const [branchMode, setBranchMode] = useState<"review" | "auto">("review");
  const [workflowStep, setWorkflowStep] = useState<"setup" | "worktrees" | "branches" | "gc" | "done">("setup");
  const [workflowStopped, setWorkflowStopped] = useState(false);
  const [stepResults, setStepResults] = useState<Partial<Record<StepKey, StepResult>>>({});
  const [receiptExpanded, setReceiptExpanded] = useState<Set<StepKey>>(new Set(["branches"]));
  const [branchReceipt, setBranchReceipt] = useState<MaintenanceSummary | null>(null);
  const [gcReceipt, setGcReceipt] = useState<MaintenanceSummary | null>(null);
  const [protectRecent, setProtectRecent] = useState(true);
  const [protectionDays, setProtectionDays] = useState(7);
  const workflowStarted = useRef(false);
  const workflowStartedAt = useRef(0);
  const [workflowDurationMs, setWorkflowDurationMs] = useState(0);
  const workflowActive = tab === "combined" && workflowStep !== "setup" && workflowStep !== "done";
  const taskTab = tab === "combined" ? (workflowStep === "branches" ? "branches" : "gc") : tab;

  const [mode, setMode] = useState<GarbageCollectionMode>("standard");
  const [allProfiles, setAllProfiles] = useState(false);
  const [action, setAction] = useState<MaintenanceAction | null>(null);
  const [running, setRunning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [repos, setRepos] = useState<MaintenanceRepo[]>([]);
  const [current, setCurrent] = useState<Set<string>>(new Set());
  const [details, setDetails] = useState<Map<string, string>>(new Map());
  const [results, setResults] = useState<Map<string, MaintenanceRepoResult>>(
    new Map()
  );
  const [summary, setSummary] = useState<MaintenanceSummary | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [options, setOptions] = useState<BranchCleanupOptions>(
    DEFAULT_BRANCH_CLEANUP_OPTIONS
  );
  // The saved rules arrive after the first paint; a review started before
  // they land would run on the defaults instead of what the reader chose.
  const [optionsLoaded, setOptionsLoaded] = useState(false);
  /** The age guard's last notch, kept while the guard is switched off so
   *  switching it back on restores it instead of the default. */
  const [lastKeepDays, setLastKeepDays] = useState<BranchCleanupKeepDays>(
    DEFAULT_BRANCH_CLEANUP_OPTIONS.keepDays ?? 7
  );
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showQuietRepos, setShowQuietRepos] = useState(false);
  const [restores, setRestores] = useState<
    Map<string, "restoring" | "restored" | string>
  >(new Map());
  const [error, setError] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState(0);
  const active = useRef<string | null>(null);
  const live = useRef(true);
  const offProgress = useRef<(() => void) | null>(null);
  const footerFocus = useRef<HTMLButtonElement>(null);
  const modalRef = useModal<HTMLDivElement>({
    onClose: () => {
      if (!active.current && !worktreesBusy) onClose();
    }
  });

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      offProgress.current?.();
      if (active.current !== null)
        void dispatch("maintenance:cancel", { operationId: active.current });
    };
  }, []);

  useEffect(() => {
    if (action !== null) footerFocus.current?.focus({ preventScroll: true });
  }, [running, action]);

  useEffect(() => {
    let cancelled = false;
    void dispatch("settings:read", undefined)
      .catch(() => null)
      .then((result) => {
        if (cancelled) return;
        // Unreadable settings: review on the defaults rather than never.
        if (result?.ok === true) {
          const general = result.value.general;
          setBranchMode(general.maintenanceBranchMode === "auto" ? "auto" : "review");
          setOptions({
            prProof: general.branchCleanupPrProof,
            keepDays: general.branchCleanupKeepDays
          });
          if (general.branchCleanupKeepDays !== null)
            setLastKeepDays(general.branchCleanupKeepDays);
        }
        setOptionsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void dispatch("repo:list", { profileId }).then((response) => {
      if (!cancelled && response.ok && Array.isArray(response.value)) setScopeRepoCount(response.value.length);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [profileId]);

  /** Change the rules, remember them, and drop a review they no longer
   *  describe — a list reviewed under a 7-day guard is not a 30-day list. */
  const changeOptions = (next: BranchCleanupOptions): void => {
    setOptions(next);
    if (next.keepDays !== null) setLastKeepDays(next.keepDays);
    reset();
    void dispatch("settings:update", {
      patch: {
        general: {
          branchCleanupPrProof: next.prProof,
          branchCleanupKeepDays: next.keepDays
        }
      }
    });
  };

  const reset = (): void => {
    setSummary(null);
    setResults(new Map());
    setDetails(new Map());
    setRepos([]);
    setSelected(new Set());
    setExpanded(new Set());
    setShowQuietRepos(false);
    setRestores(new Map());
    setError(null);
    setAction(null);
  };

  const run = async (next: MaintenanceAction): Promise<MaintenanceSummary | null> => {
    if (active.current !== null) return null;
    const operationId = crypto.randomUUID();
    active.current = operationId;
    setRunning(true);
    setCancelling(false);
    setAction(next);
    setSummary(null);
    setResults(new Map());
    setDetails(new Map());
    setRepos([]);
    setCurrent(new Set());
    setError(null);
    setSelected(new Set());
    // Keyed by branch name, so a later receipt for the same name must not
    // inherit this one's "Restored".
    setRestores(new Map());
    setStartedAt(Date.now());
    offProgress.current = subscribe("maintenance:progress", (event) => {
      if (
        !live.current ||
        event.operationId !== operationId ||
        event.profileId !== profileId
      )
        return;
      if (event.repos !== undefined) setRepos(event.repos);
      if (event.phase === "repo_started" && event.repo !== undefined) {
        const id = event.repo.id;
        setCurrent((old) => new Set(old).add(id));
      }
      if (event.repo !== undefined && event.detail !== undefined) {
        const { repo, detail } = event;
        setDetails((old) => new Map(old).set(repo.id, detail));
      }
      if (event.result !== undefined) {
        const result = event.result;
        setResults((old) => new Map(old).set(result.repo.id, result));
        setCurrent((old) => {
          const next = new Set(old);
          next.delete(result.repo.id);
          return next;
        });
      }
    });
    try {
      const response = await dispatch("maintenance:run", {
        operationId,
        profileId,
        allProfiles: tab === "combined" ? false : allProfiles,
        ...(repoScope === undefined ? {} : { repoIds: [repoScope.id] }),
        action: next
      });
      if (!live.current) return null;
      if (response.ok) {
        setSummary(response.value);
        setRepos(response.value.results.map((result) => result.repo));
        setResults(
          new Map(
            response.value.results.map((result) => [result.repo.id, result])
          )
        );
        // Finished is checked by default: each row carries its proof, and
        // the reader came here to clear them. Unticking is the exception.
        if (next.kind === "scan-branches")
          setSelected(
            new Set(
              response.value.results.flatMap((result) =>
                (result.candidates ?? []).map(branchKey)
              )
            )
          );
        return response.value;
      } else setError(response.error.message);
      return null;
    } catch (cause) {
      if (live.current)
        setError(cause instanceof Error ? cause.message : String(cause));
      return null;
    } finally {
      offProgress.current?.();
      offProgress.current = null;
      active.current = null;
      if (live.current) {
        setRunning(false);
        setCurrent(new Set());
      }
    }
  };

  const recordStep = (key: StepKey, result: StepResult): void =>
    setStepResults((old) => ({ ...old, [key]: result }));
  const combinedOptions = (): BranchCleanupOptions => options;
  const stopped = (result: MaintenanceSummary | null, task: StepKey): boolean => {
    if (!live.current) return true;
    if (result === null || result.cancelled || result.results.some((row) =>
      row.outcome === "failed" || row.outcome === "partial" || row.outcome === "cancelled")) {
      recordStep(task, { state: "failed", summary: "Stopped · needs attention" });
      setWorkflowStopped(true);
      setWorkflowDurationMs(Date.now() - workflowStartedAt.current);
      setWorkflowStep("done");
      return true;
    }
    return false;
  };
  const finishWorkflow = async (): Promise<void> => {
    if (!live.current || active.current !== null) return;
    if (plan.gc) {
      setWorkflowStep("gc");
      const result = await run({ kind: "gc", mode });
      setGcReceipt(result);
      if (stopped(result, "gc")) return;
      const measured = result!.results.filter((row) => row.beforeBytes !== undefined && row.afterBytes !== undefined);
      const storage = measured.length > 0 ? ` · ${bytes(measured.reduce((sum, row) => sum + row.beforeBytes!, 0))} → ${bytes(measured.reduce((sum, row) => sum + row.afterBytes!, 0))}` : "";
      recordStep("gc", { state: "done", summary: `${result!.results.filter((row) => row.outcome === "success").length} collected${storage}` });
    }
    setWorkflowDurationMs(Date.now() - workflowStartedAt.current);
    setWorkflowStep("done");
  };
  const removeBranchesAndContinue = async (branches: StaleBranch[]): Promise<void> => {
    if (!live.current || active.current !== null) return;
    if (branches.length > 0) {
      const result = await run({ kind: "delete-branches", branches, options: combinedOptions() });
      if (live.current) setBranchReceipt(result);
      if (stopped(result, "branches")) return;
      const deleted = result!.results.flatMap((row) => row.branches ?? []).filter((branch) => branch.deleted).length;
      recordStep("branches", { state: "done", summary: `${deleted} deleted in ${result!.results.filter((row) => (row.branches ?? []).some((branch) => branch.deleted)).length} repositories` });
    } else recordStep("branches", { state: "skipped", summary: "No branches deleted" });
    await finishWorkflow();
  };
  const continueAfterWorktrees = async (): Promise<void> => {
    if (!live.current || active.current !== null) return;
    if (plan.branches) {
      setWorkflowStep("branches");
      const result = await run({ kind: "scan-branches", options: combinedOptions() });
      if (stopped(result, "branches")) return;
      const branches = result!.results.flatMap((row) => row.candidates ?? []);
      if (branchMode === "review" && branches.length > 0) return;
      await removeBranchesAndContinue(branches);
    } else await finishWorkflow();
  };
  const analyze = (): void => {
    if (workflowStarted.current || !optionsLoaded || !Object.values(plan).some(Boolean)) return;
    workflowStarted.current = true;
    workflowStartedAt.current = Date.now();
    reset();
    setWorktreeCandidateCount(null);
    setStepResults({});
    setWorkflowStopped(false);
    setBranchReceipt(null);
    // The whole combined run stays in the profile named above, regardless of
    // what scope an individual task tab was last used with.
    if (plan.worktrees) setWorkflowStep("worktrees");
    else void continueAfterWorktrees();
  };
  const changeBranchMode = (next: "auto" | "review"): void => {
    setBranchMode(next);
    void dispatch("settings:update", { patch: { general: { maintenanceBranchMode: next } } })
      .then((result) => { if (!result.ok) setError(result.error.message); })
      .catch((cause: unknown) => setError(String(cause)));
  };
  const restartWorkflow = (): void => {
    workflowStarted.current = false;
    setWorktreeCandidateCount(null);
    setWorkflowDurationMs(0);
    setWorkflowStep("setup");
    setStepResults({});
    setWorkflowStopped(false);
    setBranchReceipt(null);
    setGcReceipt(null);
    reset();
  };

  const cancel = async (): Promise<void> => {
    if (active.current === null || cancelling) return;
    setCancelling(true);
    try {
      const response = await dispatch("maintenance:cancel", {
        operationId: active.current
      });
      if (!response.ok) {
        setError(response.error.message);
        setCancelling(false);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setCancelling(false);
    }
  };

  useEffect(() => {
    // The refs browser's hand-off: review on open, once the saved rules are in.
    if (!autoReview || !optionsLoaded || action !== null || running) return;
    void run({ kind: "scan-branches", options });
    // Only ever the first review: `action` is set from here on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoReview, optionsLoaded]);

  const candidates =
    action?.kind === "scan-branches" && summary !== null
      ? summary.results.flatMap((result) => result.candidates ?? [])
      : [];
  /** Garbage collection's hand-off: branches its per-repository review found. */
  const collectedFinished =
    action?.kind === "gc" && summary !== null
      ? summary.results.reduce(
          (total, result) => total + (result.candidates?.length ?? 0),
          0
        )
      : 0;
  const collectedRepos =
    action?.kind === "gc" && summary !== null
      ? summary.results.filter((result) => (result.candidates?.length ?? 0) > 0)
          .length
      : 0;
  /** Open the Local branches tab on what the collection already reviewed —
   *  no second scan, and nothing deleted until the reader chooses. */
  const reviewCollected = (): void => {
    if (summary === null) return;
    const seeded = summary.results.map(
      (result): MaintenanceRepoResult => ({
        repo: result.repo,
        outcome: result.outcome,
        message: `${result.candidates?.length ?? 0} finished · ${result.kept?.length ?? 0} kept.`,
        ...(result.candidates === undefined
          ? {}
          : { candidates: result.candidates }),
        ...(result.kept === undefined ? {} : { kept: result.kept })
      })
    );
    setTab("branches");
    setAction({ kind: "scan-branches", options });
    setSummary({ ...summary, results: seeded });
    setResults(new Map(seeded.map((result) => [result.repo.id, result])));
    setSelected(
      new Set(seeded.flatMap((result) => (result.candidates ?? []).map(branchKey)))
    );
  };
  const restore = async (
    repoId: string,
    deleted: DeletedBranchResult
  ): Promise<void> => {
    const key = `${repoId}:${deleted.branch}`;
    if (restores.get(key) === "restoring") return;
    setRestores((old) => new Map(old).set(key, "restoring"));
    let outcome: string;
    try {
      const response = await dispatch("maintenance:restoreBranch", {
        repoId,
        branch: deleted.branch,
        head: deleted.head
      });
      outcome = response.ok ? "restored" : response.error.message;
    } catch (cause) {
      outcome = cause instanceof Error ? cause.message : String(cause);
    }
    if (!live.current) return;
    setRestores((old) => new Map(old).set(key, outcome));
  };
  const counts = countOutcomes(
    [...results.values()].map((result) => result.outcome)
  );
  const currentRepo = repos.find((repo) => current.has(repo.id));
  const complete = summary !== null;
  const scanComplete = complete && action?.kind === "scan-branches";
  const branchScan = action?.kind === "scan-branches";
  const proposingRepos = branchScan ? [...repos].filter((repo) => current.has(repo.id) ||
    ["failed", "partial", "cancelled"].includes(results.get(repo.id)?.outcome ?? "") ||
    (results.get(repo.id)?.candidates?.length ?? 0) > 0).sort((a, b) =>
      (results.get(b.id)?.candidates?.length ?? 0) - (results.get(a.id)?.candidates?.length ?? 0)) : repos;
  const quietRepos = branchScan ? repos.filter((repo) => !proposingRepos.some((shown) => shown.id === repo.id) && results.has(repo.id)) : [];
  const quietWithKept = quietRepos.filter((repo) => (results.get(repo.id)?.kept?.length ?? 0) > 0).length;
  const deletedCount = branchReceipt?.results.flatMap((row) => row.branches ?? []).filter((branch) => branch.deleted).length ?? 0;
  const collectedBefore = gcReceipt?.results.reduce((sum, row) => sum + (row.beforeBytes ?? 0), 0) ?? 0;
  const collectedAfter = gcReceipt?.results.reduce((sum, row) => sum + (row.afterBytes ?? 0), 0) ?? 0;
  const toggleBranch = (key: string): void =>
    setSelected((old) => {
      const next = new Set(old);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div
      className="overlay-backdrop bulk-sync-backdrop"
      onClick={running || worktreesBusy ? undefined : onClose}
    >
      <section
        ref={modalRef}
        tabIndex={-1}
        className="modal bulk-sync maintenance"
        role="dialog"
        aria-modal="true"
        aria-label="Repository maintenance"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="bulk-sync__head">
          <div>
            <h2>Repository maintenance</h2>
            <p>
              Clean up finished worktrees, leftover local branches and Git storage
              across your repositories.
            </p>
          </div>
          {action !== null && (
            <span className="bulk-sync__count">
              {tab === "combined" && workflowStep === "done" ? scopeRepoCount ?? repos.length : results.size} / {tab === "combined" && workflowStep === "done" ? scopeRepoCount ?? repos.length : repos.length}
            </span>
          )}
        </div>
        <div
          className="maintenance__tabs"
          role="group"
          aria-label="Maintenance task"
        >
          {repoScope === undefined && (
            <button aria-pressed={tab === "combined"}
              disabled={running || worktreesBusy || workflowActive}
              onClick={() => { setTab("combined"); restartWorkflow(); }}>
              Combined
            </button>
          )}
          {repoScope === undefined && (
            <button aria-pressed={tab === "worktrees"}
              disabled={running || worktreesBusy || workflowActive}
              onClick={() => setTab("worktrees")}>Worktrees</button>
          )}
          <button
            aria-pressed={tab === "branches"}
            disabled={running || worktreesBusy || workflowActive}
            onClick={() => {
              setTab("branches");
              reset();
            }}
          >
            Local branches
          </button>
          <button aria-pressed={tab === "gc"} disabled={running || worktreesBusy || workflowActive}
            onClick={() => { setTab("gc"); reset(); }}>Garbage collection</button>
        </div>
        {tab === "combined" && workflowStep !== "setup" && workflowStep !== "done" &&
          <MaintenanceSteps plan={plan} current={workflowStep} results={stepResults} branchMode={branchMode}
            gcMode={mode} progress={workflowStep === "worktrees" ? worktreeCandidateCount === null ? "scanning" : `review · ${worktreeCandidateCount} finished` : running && workflowStep === "branches" ? `reviewing ${results.size} of ${repos.length}` : workflowStep === "branches" && scanComplete ? `review · ${candidates.length} in ${summary?.results.filter((row) => (row.candidates?.length ?? 0) > 0).length ?? 0} repos` : "running"} />}
        {tab === "combined" && workflowStep === "setup" ? (
          <>
            <MaintenancePlanForm plan={plan} onChange={setPlan}
              branchMode={branchMode} onBranchMode={changeBranchMode}
              options={combinedOptions()} onOptions={changeOptions}
              gcMode={mode} onGcMode={setMode} protectRecent={protectRecent} protectionDays={protectionDays}
              onProtectRecent={setProtectRecent} onProtectionDays={setProtectionDays} />
            {error !== null && <div className="modal__error">{error}</div>}
            <div className="modal__actions">
              <span className="maintenance__footer-lead">{scopeRepoCount === null ? "This profile" : `${scopeRepoCount} ${scopeRepoCount === 1 ? "repository" : "repositories"}`} · {plan.worktrees && plan.branches && branchMode === "review" ? "stops twice for you" : plan.worktrees || plan.branches && branchMode === "review" ? "stops once for you" : "runs without stopping"}</span>
              <button className="modal__cancel" onClick={onClose}>Close</button>
              <button className="modal__create"
                disabled={!optionsLoaded || !Object.values(plan).some(Boolean)}
                onClick={analyze}>Start</button>
            </div>
          </>
        ) : tab === "worktrees" || (tab === "combined" && workflowStep === "worktrees") ? (
          <PruneWorktreesPanel
            profileId={profileId}
            onRemove={onRemoveWorktrees}
            onClose={onClose}
            onBusyChange={setWorktreesBusy}
            onCandidateCount={setWorktreeCandidateCount}
            autoStart={tab === "combined"}
            step={tab === "combined"}
            {...(tab === "combined" ? { protectRecent, protectionDays } : {})}
            {...(tab === "combined" ? { onContinue: (count: number, size: string, items: { label: string; detail: string }[]) => {
              recordStep("worktrees", { state: count > 0 ? "done" : "skipped", summary: count > 0 ? `${count} removed · ${size}` : "Skipped", items });
              void continueAfterWorktrees();
            }, onChangeRules: restartWorkflow } : {})}
          />
        ) : (
          <>
        {tab === "combined" && workflowStep === "done" ? <>
          <div className={`maintenance__done-status${workflowStopped ? " is-stopped" : ""}`}><span>✓</span><div><strong>{workflowStopped ? "Maintenance stopped" : "Maintenance finished"}</strong><small>{Object.values(stepResults).filter((result) => result?.state === "done").length} of {Object.values(plan).filter(Boolean).length} steps · {stepResults.worktrees?.items?.length ?? 0} {stepResults.worktrees?.items?.length === 1 ? "worktree" : "worktrees"}, {deletedCount} {deletedCount === 1 ? "branch" : "branches"}{collectedBefore > collectedAfter ? `, ${bytes(collectedBefore - collectedAfter)} of object storage` : ""}</small></div><time>took {workflowDurationMs >= 60_000 ? `${Math.floor(workflowDurationMs / 60_000)}m ` : ""}{Math.round(workflowDurationMs % 60_000 / 1000)}s</time></div>
          <div className="maintenance__body">
            <div className="maintenance__receipt-steps">
              {(["worktrees", "branches", "gc"] as StepKey[]).map((key, index) => {
                const result = stepResults[key];
                const state = result?.state ?? (plan[key] ? "not-started" : "skipped");
                const title = key === "gc" ? "Garbage collection" : key === "branches" ? "Local branches" : "Worktrees";
                const expandedNow = receiptExpanded.has(key);
                return <article key={key} className={`maintenance__receipt-step is-${state}`}>
                  <div className="maintenance__receipt-head"><span className="maintenance__step-num">{index + 1}</span><strong>{title}</strong><span>{result?.summary ?? (state === "not-started" ? "Not started" : "Skipped")}</span>
                    {result !== undefined && result.state === "done" && <button onClick={() => setReceiptExpanded((old) => { const next = new Set(old); if (next.has(key)) next.delete(key); else next.add(key); return next; })}>{expandedNow ? "Hide" : "Show"}</button>}
                  </div>
                  {expandedNow && key === "branches" && branchReceipt?.results.flatMap((row) => (row.branches ?? []).filter((branch) => branch.deleted).map((branch) => {
                    const state = restores.get(`${row.repo.id}:${branch.branch}`);
                    return <div className="maintenance__receipt-row" key={`${row.repo.id}:${branch.branch}`}><strong>{row.repo.name} · {branch.branch}</strong><code>{branch.head.slice(0, 8)}</code><button className="maintenance__restore" disabled={state === "restored" || state === "restoring"} onClick={() => void restore(row.repo.id, branch)}>{state ?? "Restore"}</button></div>;
                  }))}
                  {expandedNow && key === "gc" && gcReceipt?.results.map((row) => <div className="maintenance__receipt-row" key={row.repo.id}><strong>{row.repo.name}</strong><span>{row.beforeBytes !== undefined && row.afterBytes !== undefined ? `${bytes(row.beforeBytes)} → ${bytes(row.afterBytes)}` : row.message}</span></div>)}
                  {expandedNow && key === "worktrees" && result?.items?.map((item) => <div className="maintenance__receipt-row" key={item.detail}><strong>{item.label}</strong><code className="selectable">{displayPath(item.detail, platform)}</code></div>)}
                </article>;
              })}
            </div>
            <p className="maintenance__help">Restore recreates a branch at the tip it had when it was deleted, for as long as Git still holds that commit. Removed worktrees cannot be restored.</p>
          </div>
          <div className="modal__actions"><button className="modal__cancel" onClick={onClose}>Close</button><button className="modal__cancel" onClick={restartWorkflow}>New plan</button></div>
        </> : <>
        {(running || complete) && (
          <BulkSyncStatus
            compactWhenFinished
            phase={
              running
                ? cancelling
                  ? "cancelling"
                  : "running"
                : summary?.cancelled
                  ? "cancelled"
                  : "finished"
            }
            hasFailures={counts.failed + counts.partial > 0}
            title={
              running
                ? cancelling
                  ? "Stopping after active repository operations…"
                  : current.size > 1
                    ? `${action?.kind === "gc" ? "Collecting" : "Reviewing"} ${current.size} repositories`
                    : currentRepo
                      ? `${action?.kind === "gc" ? "Collecting" : action?.kind === "scan-branches" ? "Reviewing" : "Cleaning branches in"} ${currentRepo.name}`
                      : "Waiting for the next repository…"
                : summary?.cancelled
                  ? "Cancelled"
                  : scanComplete
                    ? `${candidates.length} finished ${candidates.length === 1 ? "branch" : "branches"} in ${summary?.results.filter((row) => (row.candidates?.length ?? 0) > 0).length ?? 0} of ${repos.length} ${repos.length === 1 ? "repository" : "repositories"}`
                    : "Finished"
            }
            detail={
              running
                ? currentRepo
                  ? {
                      kind: "path",
                      text:
                        current.size > 1
                          ? repos
                              .filter((repo) => current.has(repo.id))
                              .map((repo) => repo.name)
                              .join(" · ")
                          : displayPath(currentRepo.path, platform)
                    }
                  : null
                : {
                    kind: "summary",
                    text: scanComplete ? `${repos.length} reviewed · ${counts.failed + counts.partial} need attention · ${summary?.results.reduce((total, row) => total + (row.kept?.length ?? 0), 0) ?? 0} kept` : `${counts.success} succeeded · ${counts.skipped} skipped · ${counts.failed + counts.partial} need attention`
                  }
            }
            counts={counts}
            inFlight={current.size}
            queued={Math.max(0, repos.length - results.size - current.size)}
            startedAt={startedAt}
            durationMs={
              summary === null
                ? null
                : Date.parse(summary.finishedAt) - Date.parse(summary.startedAt)
            }
          />
        )}
        <div className="maintenance__body">
          {tab !== "combined" && <>
          {repoScope === undefined ? (
            <>
              <label className="maintenance__scope">
                <input
                  type="checkbox"
                  checked={allProfiles}
                  disabled={running}
                  onChange={(event) => {
                    setAllProfiles(event.target.checked);
                    reset();
                  }}
                />{" "}
                Include all profiles
              </label>
              <p className="maintenance__help">
                {allProfiles
                  ? "Every known repository across all profiles."
                  : "Every known repository in this window’s profile."}{" "}
                Shared object stores are processed once per scan or collection.
              </p>
            </>
          ) : (
            <p className="maintenance__help">
              Only <strong>{repoScope.name}</strong>, from its branch list.
            </p>
          )}
          {taskTab === "gc" ? (
            <fieldset
              className="maintenance__options"
              disabled={running}
              hidden={action !== null}
            >
              <legend>Garbage collection options</legend>
              <label>
                <input
                  type="radio"
                  name="gc-mode"
                  checked={mode === "standard"}
                  onChange={() => setMode("standard")}
                />
                <span>
                  <strong>Standard (recommended)</strong>
                  <small>
                    <code>git gc</code> repacks objects and expires unused
                    history according to your Git retention settings. Start here
                    for routine cleanup.
                  </small>
                </span>
              </label>
              <label>
                <input
                  type="radio"
                  name="gc-mode"
                  checked={mode === "keep-largest"}
                  onChange={() => setMode("keep-largest")}
                />
                <span>
                  <strong>Keep the largest pack</strong>
                  <small>
                    <code>--keep-largest-pack</code> leaves the largest pack
                    intact to reduce repacking work. It may leave more storage
                    in use.
                  </small>
                </span>
              </label>
              <label>
                <input
                  type="radio"
                  name="gc-mode"
                  checked={mode === "aggressive"}
                  onChange={() => setMode("aggressive")}
                />
                <span>
                  <strong>Aggressive compression</strong>
                  <small>
                    <code>--aggressive</code> recalculates compression more
                    thoroughly. It can take much longer and use more CPU and
                    memory, with no guaranteed size reduction.
                  </small>
                </span>
              </label>
            </fieldset>
          ) : (
            <>
              <fieldset
                className="maintenance__options"
                disabled={running}
                hidden={action !== null}
              >
                <legend>Finished branches</legend>
                <label>
                  <input
                    type="checkbox"
                    checked={options.prProof}
                    onChange={(event) =>
                      changeOptions({ ...options, prProof: event.target.checked })
                    }
                  />
                  <span>
                    <strong>Count a merged pull request as proof</strong>
                    <small>
                      Finds squash and rebase merges. Offered only when the
                      branch’s tip is the pull request’s final head commit, so
                      nothing added after merging is lost.
                    </small>
                  </span>
                </label>
                <div className="maintenance__option">
                  <input
                    id="maintenance-keep-guard"
                    type="checkbox"
                    checked={options.keepDays !== null}
                    onChange={(event) =>
                      changeOptions({
                        ...options,
                        keepDays: event.target.checked ? lastKeepDays : null
                      })
                    }
                  />
                  <span>
                    <span className="maintenance__inline">
                      <label htmlFor="maintenance-keep-guard">
                        <strong>Keep branches touched in the last</strong>
                      </label>
                      <select
                        aria-label="Age guard"
                        value={options.keepDays ?? lastKeepDays}
                        disabled={running || options.keepDays === null}
                        onChange={(event) =>
                          changeOptions({
                            ...options,
                            keepDays: Number(
                              event.target.value
                            ) as BranchCleanupKeepDays
                          })
                        }
                      >
                        {BRANCH_CLEANUP_KEEP_DAYS.map((days) => (
                          <option key={days} value={days}>
                            {days} {days === 1 ? "day" : "days"}
                          </option>
                        ))}
                      </select>
                    </span>
                    <small>
                      Touched is the newest of the last commit and the last
                      checkout. Remembered for next time.
                    </small>
                  </span>
                </div>
              </fieldset>
              {action === null && (
                <div className="maintenance__never">
                  <em>Never offered</em>
                  <span>
                    Branches that were never pushed, or have commits no merged
                    pull request or HEAD contains
                  </span>
                  <span>Branches checked out in any worktree</span>
                  <span>
                    main, master, trunk, develop, and each remote’s default
                    branch
                  </span>
                </div>
              )}
              {action === null && (
                <p className="maintenance__help">
                  Only local branch names are removed; nothing on a remote is
                  deleted. Each branch is checked again at its reviewed tip just
                  before deletion. Fetch all repos first if remote information
                  is stale — PwrGit’s fetches prune deleted remote branches,
                  which is what marks a branch gone.
                </p>
              )}
            </>
          )}
          {taskTab === "gc" && action === null && (
            <details className="maintenance__help">
              <summary>What gets cleaned up?</summary>
              <p>
                Pack files compress commits, file contents, and directory
                information. Repacking reorganizes them; pruning expires
                unreachable objects. Files in retained history still take space
                even if you deleted them in a later commit.
              </p>
              <p>
                Git normally runs some maintenance automatically. PwrGit runs
                collection in the foreground with up to four repositories at a
                time, capped at half the available CPU cores (at least one). It
                preserves missing-worktree registrations. It does not request
                immediate object pruning or force a competing collection. Your
                existing Git retention configuration still applies.
              </p>
              <p>
                Storage figures measure loose objects and pack files, not free
                disk space. Temporary repacking needs extra space; snapshots and
                shared blocks can delay space returning to the volume. Garbage
                collection does not remove local branch names.
              </p>
            </details>
          )}
          </>}
          {action?.kind === "gc" && (
            <p className="maintenance__help">
              {mode === "standard"
                ? "Standard collection"
                : mode === "keep-largest"
                  ? "Keeping the largest pack"
                  : "Aggressive compression"}
              . Git retention settings apply; missing-worktree registrations are
              preserved. Sizes measure object storage, not free disk space.
            </p>
          )}
          {tab !== "combined" && collectedFinished > 0 && !running && (
            <div className="maintenance__offer">
              <div>
                <strong>
                  {collectedFinished} finished local{" "}
                  {collectedFinished === 1 ? "branch" : "branches"} across{" "}
                  {collectedRepos}{" "}
                  {collectedRepos === 1 ? "repository" : "repositories"}
                </strong>
                <small>
                  Their pull requests merged or their commits are already in
                  HEAD. Garbage collection never removes branch names.
                </small>
              </div>
              <button className="modal__create" onClick={reviewCollected}>
                Review…
              </button>
            </div>
          )}
          {error !== null && (
            <div className="modal__error" role="alert">
              {error}
            </div>
          )}
          {scanComplete && (
            <MaintenanceRulesApplied kind="branches" branchOptions={tab === "combined" ? combinedOptions() : action.options ?? options} onChange={() => {
              if (tab === "combined") restartWorkflow(); else reset();
            }} />
          )}
          {scanComplete && candidates.length > 0 && (
            <label className="maintenance__scope">
              <input
                type="checkbox"
                checked={selected.size === candidates.length}
                onChange={(event) =>
                  setSelected(
                    event.target.checked
                      ? new Set(candidates.map(branchKey))
                      : new Set()
                  )
                }
              />{" "}
              Select all {candidates.length} finished{" "}
              {candidates.length === 1 ? "branch" : "branches"}
            </label>
          )}
          {complete && repos.length === 0 && (
            <p className="maintenance__help">
              No known repositories in the selected scope.
            </p>
          )}
          {scanComplete && candidates.length === 0 && (
            <p className="maintenance__help">
              {counts.failed > 0 || summary?.cancelled
                ? "No eligible branches were reported by completed reviews. Resolve failures or cancellation and review again."
                : "No finished branches found. Fetch first if remote information is stale; each kept branch says why it was kept."}
            </p>
          )}
          <div className="maintenance__results" aria-label="Repository results">
            {(showQuietRepos ? [...proposingRepos, ...quietRepos] : proposingRepos).map((repo) => {
              const result = results.get(repo.id);
              const status =
                result?.outcome ??
                (current.has(repo.id)
                  ? "running"
                  : running
                    ? "queued"
                    : "incomplete");
              return (
                <article
                  className={`bulk-sync__repo is-${status}`}
                  key={repo.id}
                >
                  <div className="bulk-sync__repo-head">
                    <div>
                      <strong>
                        {repo.name}
                        {allProfiles ? ` · ${repo.profileName}` : ""}
                      </strong>
                      <small className="selectable">
                        {displayPath(repo.path, platform)}
                      </small>
                    </div>
                    {scanComplete && (result?.candidates?.length ?? 0) > 0 ? <span className="maintenance__repo-count">{(result?.candidates ?? []).filter((branch) => selected.has(branchKey(branch))).length} of {result?.candidates?.length ?? 0} selected</span> : <span className={`bulk-sync__repo-status is-${status}`}>{status}</span>}
                  </div>
                  <p className="selectable">
                    {result?.message ??
                      details.get(repo.id) ??
                      (current.has(repo.id)
                        ? "Git is working…"
                        : running
                          ? "Queued"
                          : "No result received.")}
                  </p>
                  {result?.beforeBytes !== undefined &&
                    result.afterBytes !== undefined && (
                      <p>
                        Object storage: {bytes(result.beforeBytes)} →{" "}
                        {bytes(result.afterBytes)}
                      </p>
                    )}
                  {scanComplete && result !== undefined && (
                    <BranchReview
                      result={result}
                      now={now()}
                      keepDays={options.keepDays}
                      selected={selected}
                      onToggle={toggleBranch}
                      showAll={expanded.has(`finished:${repo.id}`)}
                      showKept={expanded.has(`kept:${repo.id}`)}
                      onExpand={(what) =>
                        setExpanded((old) => {
                          const next = new Set(old);
                          const key = `${what}:${repo.id}`;
                          if (next.has(key)) next.delete(key);
                          else next.add(key);
                          return next;
                        })
                      }
                    />
                  )}
                  {result?.branches !== undefined && (
                    <ul className="bulk-sync__details maintenance__receipt">
                      {result.branches.map((branch) => {
                        const state = restores.get(`${repo.id}:${branch.branch}`);
                        return (
                          <li key={branch.branch}>
                            <span>
                              <strong>{branch.branch}</strong>: {branch.message}
                              {branch.deleted && (
                                <>
                                  {" "}
                                  <code className="selectable">
                                    {branch.head.slice(0, 8)}
                                  </code>
                                </>
                              )}
                              {state !== undefined &&
                                state !== "restoring" &&
                                state !== "restored" && (
                                  <span className="maintenance__restore-error">
                                    {" "}
                                    {state}
                                  </span>
                                )}
                            </span>
                            {branch.deleted && (
                              <button
                                className="maintenance__restore"
                                disabled={
                                  state === "restoring" || state === "restored"
                                }
                                aria-label={`Restore ${branch.branch} at ${branch.head.slice(0, 8)}`}
                                onClick={() => void restore(repo.id, branch)}
                              >
                                {state === "restored"
                                  ? "Restored"
                                  : state === "restoring"
                                    ? "Restoring…"
                                    : "Restore"}
                              </button>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </article>
              );
            })}
            {branchScan && quietRepos.length > 0 && <div className="maintenance__quiet"><strong>{quietRepos.length}</strong> repositories with nothing to delete · <strong>{quietWithKept}</strong> of them keep branches <button onClick={() => setShowQuietRepos((old) => !old)}>{showQuietRepos ? "Hide" : "Show"}</button></div>}
          </div>
        </div>
        <div className="modal__actions">
          {running ? (
            <button
              ref={footerFocus}
              className="modal__cancel"
              aria-disabled={cancelling}
              onClick={() => void cancel()}
            >
              {cancelling ? "Cancelling…" : "Cancel"}
            </button>
          ) : tab === "combined" ? (
            <>
              {workflowStep === "branches" && scanComplete && <span className="maintenance__footer-lead">{selected.size} selected · {plan.gc ? "then garbage collection" : "last step"}</span>}
              {!scanComplete && <button ref={footerFocus} className="modal__cancel" onClick={onClose}>Close</button>}
              {workflowStep === "branches" && scanComplete ? (
                <>
                  <button className="modal__cancel" onClick={() => {
                    recordStep("branches", { state: "skipped", summary: "Skipped" });
                    void finishWorkflow();
                  }}>Skip branches</button>
                  <button className="modal__create" onClick={() => void removeBranchesAndContinue(
                    candidates.filter((branch) => selected.has(branchKey(branch)))
                  )}>Delete {selected.size} {selected.size === 1 ? "branch" : "branches"} and continue</button>
                </>
              ) : null}
            </>
          ) : (
            <>
              <button
                ref={footerFocus}
                className="modal__cancel"
                onClick={onClose}
              >
                Close
              </button>
              {action !== null && tab === "gc" && (
                <button className="modal__cancel" onClick={reset}>
                  Change options
                </button>
              )}
              {taskTab === "gc" ? (
                <button
                  className="modal__create"
                  onClick={() =>
                    void run({ kind: "gc", mode, branchOptions: options })
                  }
                >
                  Run garbage collection
                </button>
              ) : (
                <>
                  <button
                    className="modal__cancel"
                    onClick={() => void run({ kind: "scan-branches", options })}
                  >
                    {action === null ? "Review local branches" : "Review again"}
                  </button>
                  {scanComplete && (
                    <button
                      className="modal__create"
                      disabled={selected.size === 0}
                      onClick={() =>
                        void run({
                          kind: "delete-branches",
                          branches: candidates.filter((branch) =>
                            selected.has(branchKey(branch))
                          ),
                          options
                        })
                      }
                    >
                      Delete {selected.size} selected local{" "}
                      {selected.size === 1 ? "branch" : "branches"}
                    </button>
                  )}
                </>
              )}
            </>
          )}
        </div>
        </>}
          </>
        )}
      </section>
    </div>
  );
}

/**
 * One repository's review: Finished rows, checked, each with its evidence,
 * oldest-touched first; then Kept, counted by reason and collapsed.
 */
function BranchReview({
  result,
  now,
  keepDays,
  selected,
  onToggle,
  showAll,
  showKept,
  onExpand
}: {
  result: MaintenanceRepoResult;
  now: number;
  keepDays: BranchCleanupKeepDays | null;
  selected: ReadonlySet<string>;
  onToggle: (key: string) => void;
  showAll: boolean;
  showKept: boolean;
  onExpand: (what: "finished" | "kept") => void;
}) {
  const finished = [...(result.candidates ?? [])].sort(
    (a, b) => (a.touchedAt ?? 0) - (b.touchedAt ?? 0)
  );
  const kept: KeptBranch[] = result.kept ?? [];
  if (finished.length === 0 && kept.length === 0) return null;
  const shown = showAll ? finished : finished.slice(0, FINISHED_SLICE);
  const tally = new Map<KeptBranchReason, number>();
  for (const branch of kept)
    tally.set(branch.reason, (tally.get(branch.reason) ?? 0) + 1);
  const reasons = [...tally].sort((a, b) => b[1] - a[1]);
  return (
    <>
      {finished.length > 0 && (
        <div className="maintenance__group">
          <span>
            Finished <b>{finished.length}</b>
          </span>
          {finished.length > FINISHED_SLICE && (
            <button onClick={() => onExpand("finished")}>
              {showAll ? "Show fewer" : `Show all ${finished.length}`}
            </button>
          )}
        </div>
      )}
      {shown.map((branch) => (
        <label className="maintenance__branch" key={branch.branch}>
          <input
            type="checkbox"
            checked={selected.has(branchKey(branch))}
            onChange={() => onToggle(branchKey(branch))}
          />
          <span>
            <strong>{branch.branch}</strong>
            <small>{finishedEvidence(branch, now)}</small>
          </span>
        </label>
      ))}
      {kept.length > 0 && (
        <>
          <div className="maintenance__group">
            <span>
              Kept <b>{kept.length}</b>
            </span>
            <button
              aria-expanded={showKept}
              onClick={() => onExpand("kept")}
            >
              {showKept ? "Hide" : "Show"}
            </button>
          </div>
          <div className="maintenance__kept-reasons">
            {reasons.map(([reason, n]) => (
              <span key={reason}>
                <b>{n}</b> {keptLabel(reason, keepDays)}
              </span>
            ))}
          </div>
          {showKept && (
            <ul className="maintenance__kept">
              {kept.map((branch) => (
                <li key={branch.branch}>
                  <strong>{branch.branch}</strong>
                  <small>{branch.detail}</small>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </>
  );
}
