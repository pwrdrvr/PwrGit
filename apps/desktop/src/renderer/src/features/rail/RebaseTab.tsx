import { useEffect, useRef, useState } from "react";
import type {
  RebaseCheckResult,
  RebaseCommitRef,
  RebaseOperation,
  RebasePlan
} from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";

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

type CheckState = "idle" | "checking" | RebaseCheckResult;

export function RebaseTab({
  worktreeId,
  sourceHead,
  selectedHashes,
  op,
  onClear
}: {
  worktreeId: string | null;
  sourceHead: string | null;
  selectedHashes: string[];
  op: RebaseOperation | null;
  onClear: () => void;
}) {
  const [plan, setPlan] = useState<RebasePlan | null>(null);
  const [commits, setCommits] = useState<RebaseCommitRef[]>([]);
  const [check, setCheck] = useState<CheckState>("idle");
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState(false);
  const checkGeneration = useRef(0);

  const key = selectedHashes.join(",");
  useEffect(() => {
    checkGeneration.current += 1;
    setCheck("idle");
    setApplied(false);
    setPlan(null);
    setCommits([]);
    if (worktreeId === null || op === null || selectedHashes.length === 0) {
      return;
    }
    let active = true;
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
  }, [worktreeId, sourceHead, op, key]);

  const runCheck = async (): Promise<void> => {
    if (worktreeId === null || op === null || plan === null || !plan.valid) {
      return;
    }
    const generation = checkGeneration.current;
    setCheck("checking");
    const result = await dispatch("rebase:check", { worktreeId, commits, op });
    if (generation !== checkGeneration.current) return;
    if (result.ok) {
      setCheck(result.value);
    } else {
      setCheck({
        status: "snag",
        code: result.error.code,
        message: result.error.message
      });
    }
  };

  const apply = async (): Promise<void> => {
    if (
      worktreeId === null ||
      op === null ||
      plan === null ||
      !plan.valid ||
      typeof check === "string" ||
      check.status !== "clean"
    ) {
      return;
    }
    setApplying(true);
    const result = await dispatch("rebase:apply", {
      worktreeId,
      commits,
      op,
      approvalToken: check.approvalToken
    });
    setApplying(false);
    if (result.ok) {
      setApplied(true);
      setTimeout(onClear, 900);
    } else {
      setCheck({
        status: "snag",
        code: result.error.code,
        message: result.error.message
      });
    }
  };

  const checkedClean =
    typeof check !== "string" && check.status === "clean";

  return (
    <div className="rebase-tab">
      <div className="rebase-head">
        <span className="rebase-head__icon">↻</span>
        <div>
          <div className="rebase-head__title">Rebase tool</div>
          <div className="rebase-head__sub">
            Isolated check · hooks and signing disabled
          </div>
        </div>
      </div>

      {op === null || plan === null ? (
        <div className="rebase-empty">
          Select commits in the graph, then choose{" "}
          <span className="rebase-accent">Squash</span> or{" "}
          <span className="rebase-accent">Reorder</span>. You can inspect the
          exact plan and check it safely before changing the worktree.
        </div>
      ) : (
        <>
          <div className="rebase-section">
            {op === "squash" ? "Squash" : "Reorder"} · {commits.length} commits
          </div>
          <div className="rebase-commits">
            {commits.map((c) => (
              <div key={c.hash} className="rebase-commit">
                <span className="rebase-commit__dot" />
                <span className="rebase-commit__msg">{c.subject}</span>
                <span className="rebase-commit__hash">{c.hash.slice(0, 7)}</span>
              </div>
            ))}
          </div>

          <div className="rebase-section">Plan</div>
          <div className="rebase-plan">
            {plan.valid ? (
              <>
                {plan.steps.map((s, i) => (
                  <div key={i} className="rebase-plan__row">
                    <span style={{ color: STEP_COLOR[s.action] }}>
                      {s.action}
                    </span>
                    <span className="rebase-plan__text">
                      {s.shortHash} {s.subject}
                    </span>
                  </div>
                ))}
                <div className="rebase-plan__row rebase-plan__summary">
                  <span>#</span>
                  <span className="rebase-plan__text">{plan.summary}</span>
                </div>
              </>
            ) : (
              <div className="rebase-plan__invalid">{plan.reason}</div>
            )}
          </div>

          {check === "checking" && (
            <div className="rebase-check-result" role="status">
              <span>Checking</span>
              Running the exact rebase in a disposable local repository…
            </div>
          )}
          {check !== "idle" && check !== "checking" && (
            <div
              className={`rebase-check-result rebase-check-result--${check.status}`}
              role="status"
            >
              <span>{check.status === "clean" ? "Clean" : "Snag"}</span>
              {check.message}
            </div>
          )}

          <div className="rebase-actions">
            <button
              className="rebase-check"
              disabled={!plan.valid || check === "checking" || applying || applied}
              onClick={() => void runCheck()}
            >
              {check === "checking" ? "Checking…" : "Check in isolated copy"}
            </button>
            <button
              className="rebase-apply"
              disabled={!plan.valid || !checkedClean || applying || applied}
              onClick={() => void apply()}
            >
              {applied ? "Applied ✓" : applying ? "Applying…" : "Apply rebase"}
            </button>
            <button className="rebase-discard" onClick={onClear}>
              Clear
            </button>
          </div>
          <div className="rebase-note">
            Hooks, signing, and rerere are disabled for both check and apply.
            Other repo-local Git settings can still affect Apply. Nothing is
            pushed.
          </div>
        </>
      )}
    </div>
  );
}
