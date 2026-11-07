import {
  BRANCH_CLEANUP_KEEP_DAYS,
  STALE_AGE_DAYS,
  WORKTREE_FINISHED_AFTER_DAYS,
  type BranchCleanupKeepDays,
  type BranchCleanupOptions,
  type GarbageCollectionMode,
  type WorktreeFinishedAfterDays
} from "@pwrgit/shared";
import { StatusGlyph } from "./BulkSyncStatus";
import type { StepIssue } from "./maintenance-issues";
import { StepLine } from "./MaintenanceProblem";

export type MaintenancePlan = { repair: boolean; worktrees: boolean; branches: boolean; clones: boolean; gc: boolean };
/** Combined's plan on open: everything but Repair, which is for a repository
 *  that moved. */
export const DEFAULT_MAINTENANCE_PLAN: MaintenancePlan = { repair: false, worktrees: true, branches: true, clones: true, gc: true };
/** The Clones offer's plan: share files, nothing else. */
export const CLONES_ONLY_PLAN: MaintenancePlan = { repair: false, worktrees: false, branches: false, clones: true, gc: false };
/** Whether the Git in use can re-share (`git worktree reflink`). */
export type ClonesSupport = "checking" | "available" | "unavailable";
export type StepKey = keyof MaintenancePlan;
export type StepResult = {
  state: "done" | "partial" | "skipped" | "failed";
  summary: string;
  detail?: string;
  items?: { label: string; detail: string }[];
  /** What the step left behind, one row per branch or repository. Carried
   *  whatever the state: a skipped deletion can follow a failed review. */
  issues?: StepIssue[];
};

const steps: { key: StepKey; title: string }[] = [
  { key: "repair", title: "Repair links" },
  { key: "worktrees", title: "Worktrees" },
  { key: "branches", title: "Local branches" },
  { key: "clones", title: "Clones" },
  { key: "gc", title: "Garbage collection" }
];
/** The order Combined runs in, which the receipt follows. Clones comes after
 *  the cleanup steps, so no time goes into sharing files in a worktree about
 *  to be removed, and before garbage collection, which packs what Clones'
 *  main-checkout fetch brought in and never touches working files. */
export const STEP_ORDER: StepKey[] = steps.map((step) => step.key);
export const daysLabel = (days: number) => `${days} ${days === 1 ? "day" : "days"}`;
const finishedAfterLabel = (days: number) => days === 0 ? "right away" : `after ${daysLabel(days)}`;

/** Step 1's sentence, which follows the finished-after setting. */
export function finishedWorktreesSentence(finishedAfterDays: number): string {
  return finishedAfterDays === 0
    ? "Clean worktrees whose pull request merged, or whose branch is merged into the default branch."
    : `Clean worktrees whose pull request merged, or whose branch is merged into the default branch and has had no commits for ${daysLabel(finishedAfterDays)}.`;
}

/** The "Count a merged branch as finished" select, shared by both tabs. */
export function FinishedAfterSelect({ value, onChange, disabled = false, label }: {
  value: number;
  onChange: (days: WorktreeFinishedAfterDays) => void;
  disabled?: boolean;
  label: string;
}) {
  return <select aria-label={label} value={value} disabled={disabled}
    onChange={(event) => onChange(Number(event.target.value) as WorktreeFinishedAfterDays)}>
    {WORKTREE_FINISHED_AFTER_DAYS.map((days) => <option key={days} value={days}>{finishedAfterLabel(days)}</option>)}
  </select>;
}

export function MaintenanceSteps({ plan, current, results, branchMode, gcMode, progress, clonesAvailable = true }: {
  plan: MaintenancePlan;
  current: StepKey | "done";
  results: Partial<Record<StepKey, StepResult>>;
  branchMode: "review" | "auto";
  gcMode: GarbageCollectionMode;
  progress?: string;
  /** False on a Git that cannot re-share: the step is not drawn at all. */
  clonesAvailable?: boolean;
}) {
  const visibleSteps = steps.filter((step) =>
    step.key === "repair" ? plan.repair : step.key === "clones" ? clonesAvailable || plan.clones : true);
  const currentIndex = visibleSteps.findIndex((step) => step.key === current);
  return <div className="maintenance__steps" aria-label="Maintenance steps" style={{ gridTemplateColumns: `repeat(${visibleSteps.length}, minmax(0, 1fr))` }}>
    {visibleSteps.map((step, index) => {
      const result = results[step.key];
      // The running step is live whatever an earlier attempt recorded, and
      // shows its progress, not a stale summary.
      const state = current === step.key ? "on" :
        result?.state === "failed" || result?.state === "partial" || (result?.issues?.length ?? 0) > 0 ? "stop" :
          result?.state === "done" ? "done" : !plan[step.key] || result?.state === "skipped" ? "off" :
            current === "done" || index < currentIndex ? "off" : "next";
      const detail = state === "on" ? progress ?? "Running" : result?.summary !== undefined ? <StepLine line={result.summary} /> : (state === "off" ? current === "done" && plan[step.key] ? "Not started" : "Skipped" :
        step.key === "repair" ? "first · reconnects worktrees" : step.key === "worktrees" ? "next · pauses for review" :
          step.key === "branches" ? `next · ${branchMode === "review" ? "pauses for review" : "deletes without asking"}` :
            step.key === "clones" ? "next · no pause" : `last · ${gcMode}`);
      return <div key={step.key} className={`maintenance__step is-${state}`}>
        <span className="maintenance__step-num">{state === "done" ? <StatusGlyph mark="ok" /> : state === "stop" ? <StatusGlyph mark="failed" /> : index + 1}</span>
        <div><strong>{step.title}</strong><small>{detail}</small></div>
      </div>;
    })}
  </div>;
}

export function MaintenanceRulesApplied({ kind, branchOptions, protectRecent, protectionDays, finishedAfterDays = STALE_AGE_DAYS, onChange }: {
  kind: "worktrees" | "branches";
  branchOptions?: BranchCleanupOptions;
  protectRecent?: boolean;
  protectionDays?: number;
  finishedAfterDays?: number;
  onChange: () => void;
}) {
  return <div className="maintenance__applied">
    <div><em>Rules</em><span>{kind === "worktrees" ? <>
      {protectRecent ? <>Keep if touched in the last <b>{daysLabel(protectionDays ?? 7)}</b></> : <b>Recent protection off</b>}
      <span className="maintenance__separator">·</span> finished = <b>merged PR</b> or {finishedAfterDays === 0
        ? <b>merged into the default branch</b>
        : <b>merged, no commits for {daysLabel(finishedAfterDays)}</b>}
    </> : <>
      {branchOptions?.keepDays === null ? <b>Age guard off</b> : <>Keep if touched in the last <b>{daysLabel(branchOptions?.keepDays ?? 7)}</b></>}
      <span className="maintenance__separator">·</span> {branchOptions?.prProof ? <><b>Merged PR</b> counts as proof when the tip is its head</> : <b>PR proof off</b>}
    </>}</span><button onClick={onChange}>Change</button></div>
    <div className="maintenance__applied-never"><em>Never</em><span>{kind === "worktrees" ? <>
      <b>uncommitted changes</b><span className="maintenance__separator">·</span><b>main checkout</b><span className="maintenance__separator">·</span><b>activity unreadable</b>
    </> : <>
      <b>never pushed</b><span className="maintenance__separator">·</span><b>commits not in HEAD or a merged PR</b><span className="maintenance__separator">·</span><b>checked out in a worktree</b><span className="maintenance__separator">·</span><b>main, master, trunk, develop</b>
    </>}</span></div>
  </div>;
}

export function MaintenancePlanForm({
  plan, onChange, branchMode, onBranchMode, options, onOptions, gcMode, onGcMode,
  protectRecent, protectionDays, onProtectRecent, onProtectionDays, lastKeepDays,
  finishedAfterDays, onFinishedAfterDays,
  clonesSupport, gitVersion, updateMain, onUpdateMain, onOpenGitSettings
}: {
  plan: MaintenancePlan;
  onChange: (plan: MaintenancePlan) => void;
  branchMode: "review" | "auto";
  onBranchMode: (mode: "review" | "auto") => void;
  options: BranchCleanupOptions;
  onOptions: (options: BranchCleanupOptions) => void;
  gcMode: GarbageCollectionMode;
  onGcMode: (mode: GarbageCollectionMode) => void;
  protectRecent: boolean;
  protectionDays: number;
  onProtectRecent: (enabled: boolean) => void;
  onProtectionDays: (days: number) => void;
  /** The branch age guard's last notch, restored when the guard is switched back on. */
  lastKeepDays: BranchCleanupKeepDays;
  finishedAfterDays: number;
  onFinishedAfterDays: (days: WorktreeFinishedAfterDays) => void;
  clonesSupport: ClonesSupport;
  /** The Git in use, for the "needs PwrGit's Git" line. */
  gitVersion: string | null;
  updateMain: boolean;
  onUpdateMain: (updateMain: boolean) => void;
  onOpenGitSettings: () => void;
}) {
  const clonesUnavailable = clonesSupport === "unavailable";
  return <div className="maintenance__body">
    <p className="maintenance__help">Runs top to bottom in this window’s profile. Each step works on what the step before it left.</p>
    <div className="maintenance__plan">
      <article className={`maintenance__plan-step${plan.repair ? "" : " is-off"}`}>
        <input aria-label="Repair broken worktree links" type="checkbox" checked={plan.repair} onChange={(event) => onChange({ ...plan, repair: event.target.checked })} />
        <span className="maintenance__step-num">1</span><div>
          <div className="maintenance__plan-head"><h3>Repair broken worktree links</h3><span className="maintenance__pause is-last">Runs first, no pause</span></div>
          <p>Reconnect known worktrees after their repository moves. Keeps files and branches unchanged; missing folders remain registered.</p>
        </div>
      </article>
      <article className={`maintenance__plan-step${plan.worktrees ? "" : " is-off"}`}>
        <input aria-label="Remove finished worktrees" type="checkbox" checked={plan.worktrees} onChange={(event) => onChange({ ...plan, worktrees: event.target.checked })} />
        <span className="maintenance__step-num">2</span><div>
          <div className="maintenance__plan-head"><h3>Remove finished worktrees</h3><span className="maintenance__pause">Pauses for review</span></div>
          <p>{finishedWorktreesSentence(finishedAfterDays)}</p>
          {plan.worktrees && <div className="maintenance__plan-rules"><div className="maintenance__plan-rule"><label><input type="checkbox" checked={protectRecent} onChange={(event) => onProtectRecent(event.target.checked)} />Keep worktrees touched in the last</label>
            <select aria-label="Combined worktree age guard" value={protectionDays} disabled={!protectRecent} onChange={(event) => onProtectionDays(Number(event.target.value))}>
              {BRANCH_CLEANUP_KEEP_DAYS.map((days) => <option key={days} value={days}>{daysLabel(days)}</option>)}
            </select><small>commits and file changes, ignored files included</small></div>
            <div className="maintenance__plan-rule is-indented"><span>Count a branch merged into the default branch as finished</span>
            <FinishedAfterSelect label="Combined worktree finished after" value={finishedAfterDays} onChange={onFinishedAfterDays} /></div></div>}
        </div>
      </article>
      <article className={`maintenance__plan-step${plan.branches ? "" : " is-off"}`}>
        <input aria-label="Delete finished local branches" type="checkbox" checked={plan.branches} onChange={(event) => onChange({ ...plan, branches: event.target.checked })} />
        <span className="maintenance__step-num">3</span><div>
          <div className="maintenance__plan-head"><h3>Delete finished local branches</h3><span className={`maintenance__pause${branchMode === "auto" ? " is-auto" : ""}`}>{branchMode === "auto" ? "Deletes without asking" : "Pauses for review"}</span></div>
          <p>Branches whose upstream is gone and whose commits are proven to exist elsewhere.</p>
          {plan.branches && <div className="maintenance__plan-rules">
            <div className="maintenance__plan-rule">
            <label><input type="checkbox" checked={options.prProof} onChange={(event) => onOptions({ ...options, prProof: event.target.checked })} />Count a merged pull request as proof</label><small>when the tip is the PR’s final head</small>
            </div><div className="maintenance__plan-rule">
            <label><input type="checkbox" checked={options.keepDays !== null} onChange={(event) => onOptions({ ...options, keepDays: event.target.checked ? lastKeepDays : null })} />Keep branches touched in the last</label>
            <select aria-label="Combined branch age guard" disabled={options.keepDays === null} value={options.keepDays ?? lastKeepDays} onChange={(event) => onOptions({ ...options, keepDays: Number(event.target.value) as BranchCleanupKeepDays })}>
              {BRANCH_CLEANUP_KEEP_DAYS.map((days) => <option key={days} value={days}>{daysLabel(days)}</option>)}
            </select>
            </div><div className="maintenance__plan-rule">
            <label className="maintenance__plan-mode">When the list is ready <select aria-label="Branch removal" value={branchMode} onChange={(event) => onBranchMode(event.target.value as "review" | "auto")}>
              <option value="review">Let me review it</option><option value="auto">Delete without asking</option>
            </select></label></div>
          </div>}
        </div>
      </article>
      <article className={`maintenance__plan-step${plan.clones && !clonesUnavailable ? "" : " is-off"}`}>
        <input aria-label="Share unchanged files with clones" type="checkbox" checked={plan.clones && !clonesUnavailable}
          disabled={clonesUnavailable} onChange={(event) => onChange({ ...plan, clones: event.target.checked })} />
        <span className="maintenance__step-num">4</span><div>
          <div className="maintenance__plan-head"><h3>Share unchanged files with clones</h3><span className="maintenance__pause is-last">{clonesUnavailable ? "Needs PwrGit’s Git" : "No pause"}</span></div>
          {clonesUnavailable ? <>
            <p>The Git in use{gitVersion === null ? "" : ` (${gitVersion})`} has no <code>git worktree reflink</code>. Choose PwrGit’s Git in Settings › Git.</p>
            <button type="button" className="maintenance__clones-link" onClick={onOpenGitSettings}>Open Git settings</button>
          </> : <p>Turn files a worktree holds unchanged back into copy-on-write clones of its main checkout. Edited, untracked and ignored files stay exactly as they are; every Git client and tool still sees ordinary files.</p>}
          {plan.clones && !clonesUnavailable && <div className="maintenance__plan-rules"><div className="maintenance__plan-rule">
            <label><input type="checkbox" checked={updateMain} onChange={(event) => onUpdateMain(event.target.checked)} />Update main checkouts first</label>
            <small>fetch, then fast-forward a clean main checkout on its default branch</small>
          </div></div>}
        </div>
      </article>
      <article className={`maintenance__plan-step${plan.gc ? "" : " is-off"}`}>
        <input aria-label="Collect garbage" type="checkbox" checked={plan.gc} onChange={(event) => onChange({ ...plan, gc: event.target.checked })} />
        <span className="maintenance__step-num">5</span><div>
          <div className="maintenance__plan-head"><h3>Collect garbage</h3><span className="maintenance__pause is-last">Runs last, no pause</span></div>
          <p>Repacks objects and expires unreachable ones. Runs last, after worktree and branch cleanup.</p>
          {plan.gc && <div className="maintenance__plan-rules"><label>Mode <select aria-label="Combined Git collection mode" value={gcMode} onChange={(event) => onGcMode(event.target.value as GarbageCollectionMode)}>
            <option value="standard">Standard (recommended)</option><option value="keep-largest">Keep largest pack</option><option value="aggressive">Aggressive compression (slower)</option>
          </select></label></div>}
        </div>
      </article>
    </div>
    <div className="maintenance__never"><em>Never removed</em><span><code>worktrees</code> Worktrees with uncommitted or untracked changes, the main checkout, and any whose activity could not be read</span><span><code>branches</code> Branches never pushed, checked out in a worktree, or with commits no merged PR or HEAD contains</span><span><code>names</code> main, master, trunk, develop, and each remote’s default branch</span></div>
  </div>;
}
