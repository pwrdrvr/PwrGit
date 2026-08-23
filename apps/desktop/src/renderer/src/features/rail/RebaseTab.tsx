import { useEffect, useRef, useState } from "react";
import type {
  AgentAvailability,
  AgentRebaseProposal,
  RebaseCheckResult,
  RebaseCommitRef,
  RebaseOperation,
  RebasePlan
} from "@pwrgit/shared";
import {
  dispatch,
  subscribe,
  windowProfileId
} from "../../lib/pwrgit";

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
  pick: "var(--success-text)",
  squash: "var(--accent)"
};

type CheckState = "idle" | "checking" | RebaseCheckResult;

type AvailabilityState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "resolved"; value: AgentAvailability }
  | { kind: "error"; message: string };

type ProposalState =
  | { kind: "idle" }
  | { kind: "requesting" }
  | { kind: "complete"; value: AgentRebaseProposal }
  | { kind: "error"; message: string };

export function AgentProposalPanel({
  availability,
  proposal,
  onRequest,
  onCancel
}: {
  availability: AvailabilityState;
  proposal: ProposalState;
  onRequest: () => void;
  onCancel: () => void;
}) {
  const snapshot =
    availability.kind === "resolved" ? availability.value : null;
  const codex = snapshot?.providers.find((provider) => provider.id === "codex");
  const detectedAcp =
    snapshot?.providers.filter(
      (provider) => provider.kind === "acp" && provider.status === "unsupported"
    ) ?? [];
  const canRequest = snapshot?.status === "ready";

  return (
    <div className="rebase-agent">
      <div className="rebase-section">Agent proposal</div>
      {availability.kind === "idle" || availability.kind === "checking" ? (
        <div className="rebase-agent__status" role="status">
          <span>Discovering</span>
          Looking for a safe local Codex session…
        </div>
      ) : availability.kind === "error" ? (
        <div className="rebase-agent__status rebase-agent__status--warning">
          <span>Unavailable</span>
          {availability.message} The deterministic plan remains usable.
        </div>
      ) : snapshot?.status === "unavailable" ? (
        <div className="rebase-agent__status rebase-agent__status--warning">
          <span>No safe agent</span>
          <div>
            {snapshot.message}
            {detectedAcp.length > 0 && (
              <div className="rebase-agent__detail">
                {detectedAcp.map((provider) => provider.displayName).join(", ")} detected,
                but ACP cannot enforce the no-tools boundary required here.
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="rebase-agent__status rebase-agent__status--ready">
          <span>Ready</span>
          {codex?.displayName ?? "Codex"}
          {codex?.version !== undefined ? ` ${codex.version}` : ""} will review
          this exact plan without tools or repo access.
        </div>
      )}

      {proposal.kind === "complete" && (
        <div className="rebase-agent__proposal">
          <div className="rebase-agent__proposal-head">
            <span>
              {proposal.value.providerName} proposes · {proposal.value.confidence}
              {" "}confidence
            </span>
            <span
              className={`rebase-agent__verdict rebase-agent__verdict--${proposal.value.verdict}`}
            >
              {proposal.value.verdict === "proceed" ? "Proceed" : "Use caution"}
            </span>
          </div>
          <div className="rebase-agent__title">{proposal.value.title}</div>
          <div className="rebase-agent__summary">{proposal.value.summary}</div>
          <ul>
            {proposal.value.rationale.map((reason, index) => (
              <li key={`${index}:${reason}`}>{reason}</li>
            ))}
          </ul>
          {proposal.value.risks.length > 0 && (
            <div className="rebase-agent__risks">
              <strong>Watch for</strong>
              <ul>
                {proposal.value.risks.map((risk, index) => (
                  <li key={`${index}:${risk}`}>{risk}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="rebase-agent__guard">
            Proposal only. Codex cannot run Git. PwrGit still requires an isolated
            check and your explicit Apply click.
          </div>
        </div>
      )}

      {proposal.kind === "error" && (
        <div className="rebase-agent__status rebase-agent__status--warning" role="status">
          <span>Agent stopped</span>
          {proposal.message}
        </div>
      )}

      {canRequest && proposal.kind !== "complete" && (
        <div className="rebase-agent__actions">
          {proposal.kind === "requesting" ? (
            <button type="button" className="rebase-agent__cancel" onClick={onCancel}>
              Cancel proposal
            </button>
          ) : (
            <button type="button" className="rebase-agent__ask" onClick={onRequest}>
              {proposal.kind === "error" ? "Retry Codex proposal" : "Ask Codex to review"}
            </button>
          )}
        </div>
      )}
      {proposal.kind === "requesting" && (
        <div className="rebase-agent__scan" role="status">
          Codex is reviewing commit intent and the canonical steps…
        </div>
      )}
    </div>
  );
}

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
  const [availability, setAvailability] = useState<AvailabilityState>({
    kind: "idle"
  });
  const [proposal, setProposal] = useState<ProposalState>({ kind: "idle" });
  const checkGeneration = useRef(0);
  const activeRequestId = useRef<string | null>(null);
  const profileId = windowProfileId();

  const key = selectedHashes.join(",");
  useEffect(() => {
    const requestId = activeRequestId.current;
    if (requestId !== null) {
      activeRequestId.current = null;
      void dispatch("agent:cancel", { requestId });
    }
    checkGeneration.current += 1;
    setCheck("idle");
    setApplied(false);
    setPlan(null);
    setCommits([]);
    setProposal({ kind: "idle" });
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

  useEffect(() => {
    if (profileId === null || worktreeId === null || plan?.valid !== true) {
      setAvailability({ kind: "idle" });
      return;
    }
    let active = true;
    setAvailability({ kind: "checking" });
    void dispatch("agent:availability", { profileId }).then((result) => {
      if (!active) return;
      setAvailability(
        result.ok
          ? { kind: "resolved", value: result.value }
          : { kind: "error", message: result.error.message }
      );
    });
    return () => {
      active = false;
    };
  }, [profileId, worktreeId, plan?.valid, key]);

  useEffect(
    () =>
      subscribe("agent:requestState", (state) => {
        if (state.requestId !== activeRequestId.current) return;
        if (
          state.phase === "cancelled" ||
          state.phase === "timed_out" ||
          state.phase === "failed"
        ) {
          activeRequestId.current = null;
          setProposal({
            kind: "error",
            message:
              state.message ??
              (state.phase === "timed_out"
                ? "The proposal timed out. Nothing changed."
                : "The proposal stopped. Nothing changed.")
          });
        }
      }),
    []
  );

  useEffect(
    () => () => {
      const requestId = activeRequestId.current;
      if (requestId !== null) {
        activeRequestId.current = null;
        void dispatch("agent:cancel", { requestId });
      }
    },
    []
  );

  const requestProposal = async (): Promise<void> => {
    if (
      worktreeId === null ||
      op === null ||
      plan?.valid !== true ||
      availability.kind !== "resolved" ||
      availability.value.status !== "ready"
    ) {
      return;
    }
    const requestId = crypto.randomUUID();
    activeRequestId.current = requestId;
    setProposal({ kind: "requesting" });
    const result = await dispatch("agent:rebaseDraft", {
      requestId,
      worktreeId,
      commits,
      op
    });
    if (activeRequestId.current !== requestId) return;
    activeRequestId.current = null;
    setProposal(
      result.ok
        ? { kind: "complete", value: result.value }
        : { kind: "error", message: result.error.message }
    );
  };

  const cancelProposal = (): void => {
    const requestId = activeRequestId.current;
    if (requestId === null) return;
    void dispatch("agent:cancel", { requestId });
  };

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

          <div className="rebase-section">PwrGit safe plan</div>
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

          <AgentProposalPanel
            availability={availability}
            proposal={proposal}
            onRequest={() => void requestProposal()}
            onCancel={cancelProposal}
          />

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
