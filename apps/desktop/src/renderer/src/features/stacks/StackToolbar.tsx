import { useState } from "react";
import type { RepositoryStack, StackAction } from "@pwrgit/shared";

export function StackToolbar({ stack, disabled, onPlan }: {
  stack: RepositoryStack; disabled: boolean; onPlan: (action: StackAction) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [branch, setBranch] = useState("");
  if (stack.source === "inferred") {
    return <button type="button" className="stack-button stack-button--primary" disabled={disabled}
      onClick={() => onPlan({ kind: "adopt" })}>Adopt stack</button>;
  }
  return <div className="stack-tools" onKeyDown={event => {
    if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || disabled) return;
    const key = event.key.toLowerCase();
    if (key !== "r" && key !== "n") return;
    event.preventDefault();
    if (key === "r") onPlan({ kind: "restack" });
    else setAdding(true);
  }}>
    <button type="button" className="stack-button stack-button--primary" disabled={disabled}
      onClick={() => onPlan({ kind: "restack" })}>Restack</button>
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

export function StackBranchActions({ name, onPlan }: { name: string; onPlan: (action: StackAction) => void }) {
  return <details className="stack-branch-actions">
    <summary aria-label={`Stack actions for ${name}`}>…</summary>
    <div className="stack-branch-actions__items">
      {([
        ["Restack from here", { kind: "restack", from: name }],
        ["Detach branch", { kind: "remove", branch: name, mode: "detach" }],
        ["Forget branch", { kind: "remove", branch: name, mode: "forget" }],
      ] satisfies [string, StackAction][]).map(([label, action]) => <button type="button" key={label}
        className="stack-button" onClick={event => {
          event.stopPropagation();
          event.currentTarget.closest("details")?.removeAttribute("open");
          onPlan(action);
        }}>{label}</button>)}
    </div>
  </details>;
}
