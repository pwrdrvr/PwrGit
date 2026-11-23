import { useState } from "react";
import type { RepositoryStack, StackAction } from "@pwrgit/shared";
import { stackNextAction } from "./stack-presentation";

export function StackToolbar({ stack, disabled, onPlan }: {
  stack: RepositoryStack; disabled: boolean; onPlan: (action: StackAction) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [branch, setBranch] = useState("");
  if (stack.closed) return null;
  if (stack.source === "inferred") {
    return <button type="button" className="stack-button" disabled={disabled || stack.canTrack === false}
      onClick={() => onPlan({ kind: "adopt" })}>Track with gh stack…</button>;
  }
  const next = stackNextAction(stack, !disabled);
  return <div className="stack-tools" onKeyDown={event => {
    if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || disabled) return;
    const key = event.key.toLowerCase();
    if (key !== "r" && key !== "n") return;
    event.preventDefault();
    if (key === "r") onPlan(next?.action ?? { kind: "restack" });
    else setAdding(true);
  }}>
    <button type="button" className="stack-button stack-button--primary" disabled={disabled}
      onClick={() => onPlan(next?.action ?? { kind: "restack" })}>{next?.label ?? "Restack"}</button>
    <button type="button" className="stack-button" disabled={disabled} aria-expanded={adding}
      onClick={() => setAdding(value => !value)}>New branch on top</button>
    {adding && <form className="stack-tools__new-branch" onSubmit={event => {
      event.preventDefault();
      if (!branch.trim()) return;
      onPlan({ kind: "add_branch", branch: branch.trim() });
      setAdding(false);
      setBranch("");
    }}>
      <label>Branch <input autoFocus value={branch} onChange={event => setBranch(event.target.value)} /></label>
      <button type="submit" disabled={disabled || !branch.trim()} className="stack-button">Plan</button>
    </form>}
  </div>;
}

export function stackBranchActions(branch: string): [string, StackAction][] {
  return [
    ["Restack from here", { kind: "restack", from: branch }],
    ["Detach branch", { kind: "remove", branch, mode: "detach" }],
    ["Forget branch", { kind: "remove", branch, mode: "forget" }],
  ];
}

export function StackBranchActions({ name, onPlan }: { name: string; onPlan: (action: StackAction) => void }) {
  return <details className="stack-branch-actions">
    <summary aria-label={`Stack actions for ${name}`}>…</summary>
    <div className="stack-branch-actions__items">
      {stackBranchActions(name).map(([label, action]) => <button type="button" key={label}
        className="stack-button" onClick={event => {
          event.stopPropagation();
          event.currentTarget.closest("details")?.removeAttribute("open");
          onPlan(action);
        }}>{label}</button>)}
    </div>
  </details>;
}
