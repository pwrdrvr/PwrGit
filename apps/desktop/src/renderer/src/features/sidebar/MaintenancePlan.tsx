import {
  BRANCH_CLEANUP_KEEP_DAYS,
  type BranchCleanupKeepDays,
  type BranchCleanupOptions,
  type GarbageCollectionMode
} from "@pwrgit/shared";

export type MaintenancePlan = {
  worktrees: boolean;
  branches: boolean;
  gc: boolean;
};

/** Configuration only: mounting this view never starts an operation. */
export function MaintenancePlanForm({
  plan, onChange, branchMode, onBranchMode, options, onOptions, gcMode, onGcMode
}: {
  plan: MaintenancePlan;
  onChange: (plan: MaintenancePlan) => void;
  branchMode: "review" | "auto";
  onBranchMode: (mode: "review" | "auto") => void;
  options: BranchCleanupOptions;
  onOptions: (options: BranchCleanupOptions) => void;
  gcMode: GarbageCollectionMode;
  onGcMode: (mode: GarbageCollectionMode) => void;
}) {
  return (
    <div className="maintenance__body">
      <p className="maintenance__help">
        Choose what to do in this window’s profile, then Analyze. Tasks run in
        order: worktrees, gone local branches, then Git storage.
      </p>
      <fieldset className="maintenance__options">
        <legend>Maintenance plan</legend>
        <label>
          <input type="checkbox" checked={plan.worktrees}
            onChange={(event) => onChange({ ...plan, worktrees: event.target.checked })} />
          <span><strong>Propose Worktrees to Prune</strong>
            <small>Always pause for your review. Recently touched worktrees are protected by default.</small>
          </span>
        </label>
        <label>
          <input type="checkbox" checked={plan.branches}
            onChange={(event) => onChange({ ...plan, branches: event.target.checked })} />
          <span><strong>Remove Gone Branches</strong>
            <small>Only local branches whose upstream is gone and whose commits are proven merged.</small>
          </span>
        </label>
        {plan.branches && (
          <div className="maintenance__workflow-options">
            <label>Branch removal
              <select aria-label="Branch removal" value={branchMode}
                onChange={(event) => onBranchMode(event.target.value as "review" | "auto")}>
                <option value="review">Review / Edit List</option>
                <option value="auto">Auto</option>
              </select>
            </label>
            <label>Keep branches touched within
              <select aria-label="Combined branch age guard" value={options.keepDays ?? 7}
                onChange={(event) => onOptions({ ...options, keepDays: Number(event.target.value) as BranchCleanupKeepDays })}>
                {BRANCH_CLEANUP_KEEP_DAYS.map((days) => <option key={days} value={days}>{days} {days === 1 ? "day" : "days"}</option>)}
              </select>
            </label>
            <label>
              <input type="checkbox" checked={options.prProof}
                onChange={(event) => onOptions({ ...options, prProof: event.target.checked })} />
              Count merged pull requests as proof
            </label>
            <p className="maintenance__help">
              {branchMode === "auto" ? "Auto removes eligible branches without another prompt." : "Pause to review and edit the proposed list before removing branches."}
              {" "}This choice and the age guard are remembered. Never-pushed branches,
              active worktrees, protected branch names, and commits not contained in
              HEAD or a confirmed merged PR are kept. Each branch is checked again
              before deletion. Fetch first if upstream information is stale.
            </p>
          </div>
        )}
        <label>
          <input type="checkbox" checked={plan.gc}
            onChange={(event) => onChange({ ...plan, gc: event.target.checked })} />
          <span><strong>Garbage Collect / Repack Git</strong>
            <small>Run last, after the selected cleanup steps. Git retention settings apply.</small>
          </span>
        </label>
        {plan.gc && (
          <label className="maintenance__workflow-options">Git collection mode
            <select aria-label="Combined Git collection mode" value={gcMode}
              onChange={(event) => onGcMode(event.target.value as GarbageCollectionMode)}>
              <option value="standard">Standard (recommended)</option>
              <option value="keep-largest">Keep largest pack</option>
              <option value="aggressive">Aggressive compression (slower)</option>
            </select>
          </label>
        )}
      </fieldset>
    </div>
  );
}
