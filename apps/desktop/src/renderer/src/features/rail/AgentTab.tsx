import { useEffect, useState } from "react";
import type { AgentStatus, RebaseCommitRef, RebasePlan } from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";
import { notifyDialog } from "../shell/dialogs";

async function orderedSelection(
  worktreeId: string,
  selectedHashes: string[]
): Promise<RebaseCommitRef[]> {
  const r = await dispatch("graph:log", { worktreeId });
  if (!r.ok) return [];
  const set = new Set(selectedHashes);
  return r.value.commits
    .filter((c) => set.has(c.hash))
    .map((c) => ({ hash: c.hash, subject: c.subject }));
}

const STEP_COLOR: Record<string, string> = {
  pick: "var(--success-bright)",
  squash: "var(--accent)"
};

export function AgentTab({
  worktreeId,
  selectedHashes,
  op,
  onClear
}: {
  worktreeId: string | null;
  selectedHashes: string[];
  op: "squash" | "reorder" | null;
  onClear: () => void;
}) {
  const [agent, setAgent] = useState<AgentStatus | null>(null);
  const [plan, setPlan] = useState<RebasePlan | null>(null);
  const [commits, setCommits] = useState<RebaseCommitRef[]>([]);
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState(false);

  useEffect(() => {
    void dispatch("agent:status", undefined).then((r) => {
      if (r.ok) setAgent(r.value);
    });
  }, []);

  const key = selectedHashes.join(",");
  useEffect(() => {
    if (worktreeId === null || op === null || selectedHashes.length === 0) {
      setPlan(null);
      setCommits([]);
      return;
    }
    let active = true;
    setApplied(false);
    void orderedSelection(worktreeId, selectedHashes).then((ordered) => {
      if (!active) return;
      setCommits(ordered);
      void dispatch("rebase:draft", { worktreeId, commits: ordered, op }).then(
        (r) => {
          if (active && r.ok) setPlan(r.value);
        }
      );
    });
    return () => {
      active = false;
    };
  }, [worktreeId, op, key]);

  const apply = async (): Promise<void> => {
    if (worktreeId === null || op === null || plan === null || !plan.valid) {
      return;
    }
    setApplying(true);
    const r = await dispatch("rebase:apply", { worktreeId, commits, op });
    setApplying(false);
    if (r.ok) {
      setApplied(true);
      setTimeout(onClear, 900);
    } else {
      void notifyDialog({ title: "Rebase failed", message: r.error.message });
    }
  };

  return (
    <div className="agent-tab">
      <div className="agent-head">
        <span className="agent-head__icon">✦</span>
        <div>
          <div className="agent-head__title">Rebase assistant</div>
          <div className="agent-head__sub">
            {agent === null
              ? "Codex · ACP"
              : agent.available
                ? "Codex · ready"
                : "Codex · not signed in"}
          </div>
        </div>
      </div>

      {op === null || plan === null ? (
        <div className="agent-empty">
          Select commits in the graph, then choose{" "}
          <span className="agent-accent">Squash</span> or{" "}
          <span className="agent-accent">Reorder</span>. The assistant drafts a
          plan you approve before it runs.
        </div>
      ) : (
        <>
          <div className="agent-section">
            {op === "squash" ? "Squash" : "Reorder"} · {commits.length} commits
          </div>
          <div className="agent-commits">
            {commits.map((c) => (
              <div key={c.hash} className="agent-commit">
                <span className="agent-commit__dot" />
                <span className="agent-commit__msg">{c.subject}</span>
                <span className="agent-commit__hash">{c.hash.slice(0, 7)}</span>
              </div>
            ))}
          </div>

          <div className="agent-section">Proposed plan</div>
          <div className="agent-plan">
            {plan.valid ? (
              <>
                {plan.steps.map((s, i) => (
                  <div key={i} className="agent-plan__row">
                    <span style={{ color: STEP_COLOR[s.action] }}>
                      {s.action}
                    </span>
                    <span className="agent-plan__text">
                      {s.shortHash} {s.subject}
                    </span>
                  </div>
                ))}
                <div className="agent-plan__row agent-plan__summary">
                  <span>#</span>
                  <span className="agent-plan__text">{plan.summary}</span>
                </div>
              </>
            ) : (
              <div className="agent-plan__invalid">{plan.reason}</div>
            )}
          </div>

          <div className="agent-actions">
            <button
              className="agent-apply"
              disabled={!plan.valid || applying || applied}
              onClick={() => void apply()}
            >
              {applied ? "Applied ✓" : applying ? "Running…" : "Apply rebase"}
            </button>
            <button className="agent-discard" onClick={onClear}>
              Discard
            </button>
          </div>
          <div className="agent-note">
            Runs locally on the worktree. Nothing is pushed until you press Push.
          </div>
        </>
      )}
    </div>
  );
}
