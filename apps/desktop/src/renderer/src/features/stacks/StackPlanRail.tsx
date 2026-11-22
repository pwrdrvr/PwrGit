import { OperationBanner } from "../rail/OperationBanner";
import type { StackAction, StackPlanPreview } from "@pwrgit/shared";
import type { StackOperationControls } from "./useStackOperation";

export function stackActionLabel(action: StackAction): string {
  switch (action.kind) {
    case "restack": return action.from ? "Restack from here" : "Restack";
    case "add_branch": return "New branch on top";
    case "adopt": return "Adopt stack";
    case "remove": return action.mode === "detach" ? "Detach branch" : "Forget branch";
  }
}

function PlanSteps({ plan, applied }: { plan: StackPlanPreview; applied: boolean }) {
  return <ol className="stack-plan__steps">
    {plan.steps.map((step, index) => <li key={step.branch} data-conflict={step.conflict !== undefined}>
      <span className="stack-plan__step-state" aria-hidden="true">{applied ? "✓" : step.conflict ? "!" : index + 1}</span>
      <div>
        <strong>{step.branch}</strong>
        <span>onto {step.parent} <code>{step.newBase.slice(0, 8)}</code></span>
        {step.conflict && !applied && <div className="stack-plan__conflict">
          <span>Conflict at <code>{step.conflict.commit.slice(0, 8)}</code></span>
          <ul>{step.conflict.files.map(path => <li key={path} className="selectable">{path}</li>)}</ul>
        </div>}
        {step.resolved && <span>Resolved in worktree</span>}
        {step.proof && <span>{step.proof.preserved} {step.proof.preserved === 1 ? "patch" : "patches"} preserved
          {step.proof.dropped.length > 0 && <> · {step.proof.dropped.length} already upstream</>}
        </span>}
        {step.proof && step.proof.dropped.length > 0 && <ul>
          {step.proof.dropped.map(patch => <li key={patch.commit}><code>{patch.commit.slice(0, 8)}</code> already upstream</li>)}
        </ul>}
      </div>
    </li>)}
  </ol>;
}

export function StackPlanRail({
  controls, worktreeId, onCollapse, onOpenWorktree,
}: {
  controls: StackOperationControls;
  worktreeId?: string;
  onCollapse: () => void;
  onOpenWorktree: (worktreeId: string) => void;
}) {
  const { stage, pending, error } = controls;
  const plan = stage.phase === "plan" ? stage.plan : stage.phase === "done" ? stage.applied.plan :
    stage.phase === "conflict" ? stage.conflict.plan : undefined;
  const conflicted = plan?.steps.some(step => step.conflict);
  const applied = stage.phase === "done";
  const canRun = plan && !plan.blocked.length;
  return <aside className="pane pane--rail stack-rail stack-plan" aria-label={applied ? "Proof ledger" : "Stack operation plan"}>
    <div className="rail__bar">
      <strong>{applied ? "Proof ledger" : "Stack plan"}</strong>
      <button type="button" className="icon-btn rail__collapse" onClick={onCollapse} aria-label="Hide panel">→</button>
    </div>
    <div className="stack-plan__body" aria-busy={pending !== null}>
      {pending === "plan" && <p role="status">Checking replays…</p>}
      {error && <p role="alert" className="stack-plan__conflict">{error}</p>}
      {plan && <>
        <h2>{stackActionLabel(plan.action)}</h2>
        {plan.steps.length > 0 && <PlanSteps plan={plan} applied={applied} />}
        <h3>{applied ? "Ref transaction" : "Ref transaction preview"}</h3>
        {plan.moves.length ? <ul className="stack-plan__refs">
          {plan.moves.map(move => <li key={move.branch}>
            <code className="selectable">{move.branch}</code>
            <span>{move.old?.slice(0, 8) ?? "new"} → {move.next?.slice(0, 8) ?? "deleted"}</span>
          </li>)}
        </ul> : <p>Catalog only</p>}
        <p>Local operation</p>
        {plan.blocked.map(block => <div key={block.path} className="stack-plan__conflict">
          <strong>Local changes overlap this replay</strong>
          <p className="selectable">{block.path}</p>
          <ul>{block.files.map(file => <li key={file} className="selectable">{file}</li>)}</ul>
        </div>)}
      </>}
      {stage.phase === "plan" && <div className="stack-plan__actions">
        <button className="stack-button" type="button" disabled={pending !== null} onClick={controls.cancel}>Cancel</button>
        {conflicted
          ? <>
            {plan?.cleanPrefix && <button className="stack-button" type="button" disabled={pending !== null || !canRun}
              onClick={() => void controls.run(true, worktreeId)}>Apply clean steps</button>}
            <button className="stack-button stack-button--primary" type="button" disabled={pending !== null}
              onClick={() => void controls.resolve()}>Resolve in worktree</button>
          </>
          : <button className="stack-button stack-button--primary" type="button" disabled={pending !== null || !canRun}
            onClick={() => void controls.run(false, worktreeId)}>Run locally</button>}
      </div>}
      {stage.phase === "conflict" && <div className="stack-plan__pause">
        <strong>Restack paused at {stage.conflict.branch}</strong>
        <p className="selectable">{stage.conflict.worktreePath}</p>
        {stage.conflict.worktreeId && <button type="button" className="stack-button"
          onClick={() => onOpenWorktree(stage.conflict.worktreeId!)}>Open worktree</button>}
        {stage.conflict.worktreeId && controls.operation && <OperationBanner
          worktreeId={stage.conflict.worktreeId} state={controls.operation}
          onRefresh={() => void controls.loadConflict().then(conflict => {
            if (conflict && conflict.phase !== "resolving") void controls.finish();
          })}
        />}
        {stage.conflict.phase !== "resolving" && <button className="stack-button stack-button--primary" type="button"
          disabled={pending !== null} onClick={() => void controls.finish()}>
          {stage.conflict.phase === "aborted" ? "Close aborted rebase" : "Finish restack"}
        </button>}
      </div>}
    </div>
  </aside>;
}
