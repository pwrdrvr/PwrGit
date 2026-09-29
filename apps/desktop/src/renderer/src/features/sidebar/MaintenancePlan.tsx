import {
  BRANCH_CLEANUP_KEEP_DAYS,
  type BranchCleanupKeepDays,
  type BranchCleanupOptions,
  type GarbageCollectionMode
} from "@pwrgit/shared";
import { StatusGlyph } from "./BulkSyncStatus";

export type MaintenancePlan = { worktrees: boolean; branches: boolean; gc: boolean };
export type StepKey = keyof MaintenancePlan;
export type StepResult = {
  state: "done" | "skipped" | "failed";
  summary: string;
  detail?: string;
  items?: { label: string; detail: string }[];
};

const steps: { key: StepKey; title: string }[] = [
  { key: "worktrees", title: "Worktrees" },
  { key: "branches", title: "Local branches" },
  { key: "gc", title: "Garbage collection" }
];
const daysLabel = (days: number) => `${days} ${days === 1 ? "day" : "days"}`;

export function MaintenanceSteps({ plan, current, results, branchMode, gcMode, progress }: {
  plan: MaintenancePlan;
  current: StepKey | "done";
  results: Partial<Record<StepKey, StepResult>>;
  branchMode: "review" | "auto";
  gcMode: GarbageCollectionMode;
  progress?: string;
}) {
  const currentIndex = steps.findIndex((step) => step.key === current);
  return <div className="maintenance__steps" aria-label="Maintenance steps">
    {steps.map((step, index) => {
      const result = results[step.key];
      const state = result?.state === "failed" ? "stop" : result?.state === "done" ? "done" :
        !plan[step.key] || result?.state === "skipped" ? "off" : current === step.key ? "on" :
          current === "done" || index < currentIndex ? "off" : "next";
      const detail = result?.summary ?? (state === "off" ? current === "done" && plan[step.key] ? "Not started" : "Skipped" :
        current === step.key ? progress ?? "Running" : step.key === "worktrees" ? "next · pauses for review" :
          step.key === "branches" ? `next · ${branchMode === "review" ? "pauses for review" : "deletes without asking"}` :
            `last · ${gcMode}`);
      return <div key={step.key} className={`maintenance__step is-${state}`}>
        <span className="maintenance__step-num">{state === "done" ? <StatusGlyph mark="ok" /> : state === "stop" ? <StatusGlyph mark="failed" /> : index + 1}</span>
        <div><strong>{step.title}</strong><small>{detail}</small></div>
      </div>;
    })}
  </div>;
}

export function MaintenanceRulesApplied({ kind, branchOptions, protectRecent, protectionDays, onChange }: {
  kind: "worktrees" | "branches";
  branchOptions?: BranchCleanupOptions;
  protectRecent?: boolean;
  protectionDays?: number;
  onChange: () => void;
}) {
  return <div className="maintenance__applied">
    <div><em>Rules</em><span>{kind === "worktrees" ? <>
      {protectRecent ? <>Keep if touched in the last <b>{daysLabel(protectionDays ?? 7)}</b></> : <b>Recent protection off</b>}
      <span className="maintenance__separator">·</span> finished = <b>merged PR</b> or <b>merged {14} days ago</b>
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
  protectRecent, protectionDays, onProtectRecent, onProtectionDays, lastKeepDays
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
}) {
  return <div className="maintenance__body">
    <p className="maintenance__help">Runs top to bottom in this window’s profile. Each step works on what the step before it left.</p>
    <div className="maintenance__plan">
      <article className={`maintenance__plan-step${plan.worktrees ? "" : " is-off"}`}>
        <input aria-label="Remove finished worktrees" type="checkbox" checked={plan.worktrees} onChange={(event) => onChange({ ...plan, worktrees: event.target.checked })} />
        <span className="maintenance__step-num">1</span><div>
          <div className="maintenance__plan-head"><h3>Remove finished worktrees</h3><span className="maintenance__pause">Pauses for review</span></div>
          <p>Clean worktrees whose branch merged, or that have been inactive for 14 days after merging into the default branch.</p>
          {plan.worktrees && <div className="maintenance__plan-rules"><div className="maintenance__plan-rule"><label><input type="checkbox" checked={protectRecent} onChange={(event) => onProtectRecent(event.target.checked)} />Keep worktrees touched in the last</label>
            <select aria-label="Combined worktree age guard" value={protectionDays} disabled={!protectRecent} onChange={(event) => onProtectionDays(Number(event.target.value))}>
              {BRANCH_CLEANUP_KEEP_DAYS.map((days) => <option key={days} value={days}>{daysLabel(days)}</option>)}
            </select><small>commits and file changes, ignored files included</small></div></div>}
        </div>
      </article>
      <article className={`maintenance__plan-step${plan.branches ? "" : " is-off"}`}>
        <input aria-label="Delete finished local branches" type="checkbox" checked={plan.branches} onChange={(event) => onChange({ ...plan, branches: event.target.checked })} />
        <span className="maintenance__step-num">2</span><div>
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
      <article className={`maintenance__plan-step${plan.gc ? "" : " is-off"}`}>
        <input aria-label="Collect garbage" type="checkbox" checked={plan.gc} onChange={(event) => onChange({ ...plan, gc: event.target.checked })} />
        <span className="maintenance__step-num">3</span><div>
          <div className="maintenance__plan-head"><h3>Collect garbage</h3><span className="maintenance__pause is-last">Runs last, no pause</span></div>
          <p>Repacks objects and expires unreachable ones. Runs last so it can reclaim what steps 1 and 2 freed.</p>
          {plan.gc && <div className="maintenance__plan-rules"><label>Mode <select aria-label="Combined Git collection mode" value={gcMode} onChange={(event) => onGcMode(event.target.value as GarbageCollectionMode)}>
            <option value="standard">Standard (recommended)</option><option value="keep-largest">Keep largest pack</option><option value="aggressive">Aggressive compression (slower)</option>
          </select></label></div>}
        </div>
      </article>
    </div>
    <div className="maintenance__never"><em>Never removed</em><span><code>worktrees</code> Worktrees with uncommitted or untracked changes, the main checkout, and any whose activity could not be read</span><span><code>branches</code> Branches never pushed, checked out in a worktree, or with commits no merged PR or HEAD contains</span><span><code>names</code> main, master, trunk, develop, and each remote’s default branch</span></div>
  </div>;
}
