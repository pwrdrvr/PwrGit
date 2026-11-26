import { useEffect, useRef, useState } from "react";
import type {
  HistoryEditProgram,
  RebaseCommitRef,
  RebaseOperation,
  RebasePlan,
  RebaseProof,
  RebaseSnagDetail
} from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";
import { RebaseGlyph } from "../../lib/RebaseGlyph";
import {
  joinedSubjects,
  ledgerRows,
  short,
  squashProgram,
  type LedgerCheck,
  type LedgerRow
} from "./history-edit";
import { CheckGlyph } from "../../lib/CheckGlyph";
import { CloseGlyph } from "../../lib/CloseGlyph";
import { rebaseIdentityLine } from "../identity/identity-view";
import { useCommitIdentity } from "../identity/useCommitIdentity";
import { DotGlyph } from "../../lib/DotGlyph";

async function orderedSelection(
  worktreeId: string,
  selectedHashes: string[]
): Promise<RebaseCommitRef[]> {
  // The selection is HEAD's newest N commits, so read exactly N. The default
  // window (200) silently dropped the oldest commits of a longer run, and the
  // newest 200 still passed as a valid run of their own.
  const r = await dispatch("graph:log", {
    worktreeId,
    limit: selectedHashes.length
  });
  if (!r.ok) return [];
  const set = new Set(selectedHashes);
  const ordered = r.value.commits
    .filter((c) => set.has(c.hash))
    .map((c) => ({ hash: c.hash, subject: c.subject }));
  // A selection that is no longer HEAD's newest N (HEAD moved) is sent whole,
  // so main refuses it by name instead of rewriting the subset still on top.
  const found = new Set(ordered.map((c) => c.hash));
  return [
    ...ordered,
    ...selectedHashes
      .filter((hash) => !found.has(hash))
      .map((hash) => ({ hash, subject: short(hash) }))
  ];
}

const STEP_CLASS: Record<string, string> = {
  pick: "rebase-op--pick",
  squash: "rebase-op--squash"
};

const OP_LABEL: Record<RebaseOperation, string> = {
  squash: "Squash",
  reorder: "Reorder"
};

type CheckState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "clean"; approvalToken: string; proof: RebaseProof }
  | {
      kind: "snag";
      code: string;
      message: string;
      detail?: RebaseSnagDetail;
      /** Apply was refused only because Git could not sign. Main kept the
       *  approval, for exactly one explicit unsigned apply. */
      unsignedRetry?: { approvalToken: string };
    };

export function ProofLedger({ rows }: { rows: LedgerRow[] }) {
  return (
    <div className="proof-ledger" aria-label="What the check proves">
      {rows.map((row) => (
        <div key={row.label} className={`proof-ledger__row proof-ledger__row--${row.state}`}>
          <span className="proof-ledger__glyph" aria-hidden="true">
            {row.state === "ok" ? (
              <CheckGlyph size={11} />
            ) : row.state === "bad" ? (
              <CloseGlyph size={11} />
            ) : (
              <DotGlyph size={11} hollow />
            )}
          </span>
          <span>{row.label}</span>
          <span className="proof-ledger__value">{row.value}</span>
        </div>
      ))}
    </div>
  );
}

function conflictSentence(detail: Extract<RebaseSnagDetail, { kind: "conflict" }>): string {
  const files = detail.files.length > 0 ? ` in ${detail.files.join(", ")}` : "";
  return `Step ${detail.step} of ${detail.total}: ${short(detail.hash)} “${detail.subject}” conflicted${files}.`;
}

export function CheckResult({
  check,
  resultCommits
}: {
  check: CheckState;
  resultCommits: number;
}) {
  const [showFiles, setShowFiles] = useState(false);
  if (check.kind === "idle") return null;
  if (check.kind === "checking") {
    return (
      <div className="rebase-check-result" role="status">
        <span>Checking</span>
        Running the exact plan in a disposable local repository…
      </div>
    );
  }
  if (check.kind === "clean") {
    // The ledger's ticks and the Checked button already say this on screen;
    // a screen reader hears neither change, so it gets the sentence.
    return (
      <div className="a11y-sr-only rebase-check-result--clean" role="status">
        Clean. Check passed: the isolated copy produced {resultCommits} commit
        {resultCommits === 1 ? "" : "s"} with an identical tree.
      </div>
    );
  }
  const detail = check.detail;
  if (detail?.kind === "tree_changed") {
    return (
      <div className="rebase-check-result rebase-check-result--bad" role="status">
        <span>Blocked</span>
        <div>
          {check.message}
          {detail.files.length > 0 && (
            <>
              {" "}
              <button
                type="button"
                className="rebase-tree-link"
                aria-expanded={showFiles}
                onClick={() => setShowFiles((v) => !v)}
              >
                {showFiles ? "Hide files" : "Show files"}
              </button>
              {showFiles && (
                <div className="rebase-tree-diff">
                  {detail.files.map((file) => (
                    <div key={file.path}>
                      <span>{file.path}</span>
                      <span>
                        +{file.added} −{file.removed}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="rebase-check-result rebase-check-result--snag" role="status">
      <span>{detail?.kind === "conflict" ? "Conflict" : "Snag"}</span>
      <div>
        {check.message}
        {detail?.kind === "conflict" && (
          <div className="rebase-check-result__detail">{conflictSentence(detail)}</div>
        )}
      </div>
    </div>
  );
}

export function RebaseTab({
  worktreeId,
  sourceHead,
  selectedHashes,
  op,
  branch = null,
  onClear
}: {
  worktreeId: string | null;
  sourceHead: string | null;
  selectedHashes: string[];
  op: RebaseOperation | null;
  branch?: string | null;
  onClear: () => void;
}) {
  const [plan, setPlan] = useState<RebasePlan | null>(null);
  const [message, setMessage] = useState("");
  const [commits, setCommits] = useState<RebaseCommitRef[]>([]);
  const [check, setCheck] = useState<CheckState>({ kind: "idle" });
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState(false);
  // Apply rewrites every commit with the profile as committer, signed when Git
  // is set to sign: both are said beside the button before anyone presses it.
  const identity = useCommitIdentity(worktreeId, sourceHead);
  const checkGeneration = useRef(0);
  // A new selection, a later Apply, or unmount invalidates both the response
  // and its delayed Clear. An old completion must never unlock a newer Apply.
  const applyAttempt = useRef(0);
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const invalidateApply = (): void => {
    applyAttempt.current += 1;
    if (clearTimer.current !== null) {
      clearTimeout(clearTimer.current);
      clearTimer.current = null;
    }
  };

  const key = selectedHashes.join(",");
  useEffect(() => {
    invalidateApply();
    checkGeneration.current += 1;
    setCheck({ kind: "idle" });
    setApplying(false);
    setApplied(false);
    setPlan(null);
    setCommits([]);
    setMessage("");
    if (worktreeId === null || op === null || selectedHashes.length === 0) {
      return;
    }
    let active = true;
    void orderedSelection(worktreeId, selectedHashes).then((ordered) => {
      if (!active) return;
      setCommits(ordered);
      if (op === "squash") setMessage(joinedSubjects(ordered));
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

  useEffect(
    () => () => {
      checkGeneration.current += 1;
      invalidateApply();
    },
    []
  );

  const program: HistoryEditProgram | null =
    op === "squash" && message.trim() !== "" ? squashProgram(commits, message) : null;

  const hasRequiredMessage = op !== "squash" || program !== null;

  const runCheck = async (): Promise<void> => {
    if (worktreeId === null || op === null || plan === null || !plan.valid) return;
    if (!hasRequiredMessage) return;
    checkGeneration.current += 1;
    const generation = checkGeneration.current;
    setCheck({ kind: "checking" });
    const result = await dispatch("rebase:check", {
      worktreeId,
      commits,
      op,
      ...(program !== null ? { program } : {})
    });
    if (generation !== checkGeneration.current) return;
    if (!result.ok) {
      setCheck({ kind: "snag", code: result.error.code, message: result.error.message });
      return;
    }
    const value = result.value;
    if (value.status === "clean") {
      setCheck({
        kind: "clean",
        approvalToken: value.approvalToken,
        proof: value.proof
      });
      return;
    }
    setCheck({
      kind: "snag",
      code: value.code,
      message: value.message,
      ...(value.detail !== undefined ? { detail: value.detail } : {})
    });
  };

  const apply = async (unsigned = false): Promise<void> => {
    if (worktreeId === null || op === null || plan === null || !plan.valid || applying || applied) return;
    const approvalToken =
      check.kind === "clean"
        ? check.approvalToken
        : unsigned && check.kind === "snag"
          ? check.unsignedRetry?.approvalToken
          : undefined;
    if (approvalToken === undefined) return;
    if (!hasRequiredMessage) return;
    const attempt = ++applyAttempt.current;
    setApplying(true);
    const result = await dispatch("rebase:apply", {
      worktreeId,
      commits,
      op,
      approvalToken,
      ...(program !== null ? { program } : {}),
      ...(unsigned ? { unsigned: true } : {})
    });
    if (attempt !== applyAttempt.current) return;
    setApplying(false);
    if (result.ok) {
      setApplied(true);
      // Held so it can be cancelled: firing after a new selection was made
      // would clear that one instead of this finished rebase.
      clearTimer.current = setTimeout(() => {
        if (attempt !== applyAttempt.current) return;
        clearTimer.current = null;
        onClear();
      }, 900);
    } else {
      setCheck({
        kind: "snag",
        code: result.error.code,
        message: result.error.message,
        ...(result.error.code === "signing_failed" && !unsigned
          ? { unsignedRetry: { approvalToken } }
          : {})
      });
    }
  };

  const resultCommits = op === "squash" ? 1 : commits.length;
  const headSub =
    op === null || commits.length === 0
      ? "Isolated check · hooks off, nothing signed"
      : `${commits.length} → ${resultCommits}${branch !== null && branch !== "" ? ` · ${branch}` : ""}`;
  const ledgerCheck: LedgerCheck =
    check.kind === "clean"
      ? { kind: "clean", proof: check.proof }
      : check.kind === "snag"
        ? check.detail !== undefined
          ? { kind: "snag", detail: check.detail }
          : { kind: "snag" }
        : check;
  const canCheck =
    plan?.valid === true &&
    hasRequiredMessage &&
    check.kind !== "checking" &&
    check.kind !== "clean" &&
    !applying &&
    !applied;

  return (
    <div className="rebase-tab">
      <div className="rebase-head">
        <span className="rebase-head__icon">
          <RebaseGlyph />
        </span>
        <div className="rebase-head__text">
          <div className="rebase-head__title">{op === null ? "Rebase tool" : OP_LABEL[op]}</div>
          <div className="rebase-head__sub">{headSub}</div>
        </div>
      </div>

      {op === null || plan === null ? (
        <div className="rebase-empty">
          Right-click the oldest commit you want to change in the graph and
          choose <span className="rebase-accent">Squash</span> or{" "}
          <span className="rebase-accent">Reorder</span>
          {" "}under “Edit history from here”. Every commit from there up to HEAD
          is included. You can inspect the exact plan and check it safely
          before changing the worktree.
        </div>
      ) : (
        <>
          <div className="rebase-section">
            {OP_LABEL[op]} · {commits.length} commits
          </div>
          <div className="rebase-commits">
            {commits.map((c) => (
              <div key={c.hash} className="rebase-commit">
                <span className="rebase-commit__dot" />
                <span className="rebase-commit__msg">{c.subject}</span>
                <span className="rebase-commit__hash">{short(c.hash)}</span>
              </div>
            ))}
          </div>

          {op === "squash" && plan.valid && (
            <>
              <div className="rebase-section">Commit message</div>
              <div className="msg-box">
                <textarea
                  className="msg-box__input"
                  aria-label="Commit message"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  spellCheck={false}
                  disabled={applying || applied}
                />
              </div>
              {message.trim() === "" && (
                <div className="rebase-note">Write a commit message to check and apply.</div>
              )}
            </>
          )}

          <div className="rebase-section">
            Plan <span className="rebase-section__aside">oldest first</span>
          </div>
          <div className="rebase-plan">
            {plan.valid ? (
              <>
                {plan.steps.map((s, i) => (
                  <div key={i} className="rebase-plan__row">
                    <span className={`rebase-op ${STEP_CLASS[s.action] ?? ""}`}>{s.action}</span>
                    <span className="rebase-plan__text">
                      {s.shortHash} {s.subject}
                    </span>
                  </div>
                ))}
                <div className="rebase-plan__row rebase-plan__summary">
                  <span className="rebase-op">#</span>
                  <span className="rebase-plan__text">{plan.summary}</span>
                </div>
              </>
            ) : (
              <div className="rebase-plan__invalid">{plan.reason}</div>
            )}
          </div>

          {plan.valid && (
            <ProofLedger rows={ledgerRows(commits, ledgerCheck)} />
          )}

          <CheckResult check={check} resultCommits={resultCommits} />

          {applied && (
            <div className="rebase-applied" role="status">
              Applied locally · {resultCommits} commit
              {resultCommits === 1 ? "" : "s"} · nothing pushed.
            </div>
          )}

          <div className="rebase-actions">
            <button
              type="button"
              className={`rebase-check${check.kind === "clean" ? " rebase-check--done" : ""}`}
              disabled={!canCheck}
              onClick={() => void runCheck()}
            >
              {check.kind === "checking" ? (
                "Checking…"
              ) : check.kind === "clean" ? (
                <>
                  Checked <CheckGlyph />
                </>
              ) : (
                "Check in isolated copy"
              )}
            </button>
            <div className="rebase-actions__row">
              <button
                type="button"
                className="rebase-apply"
                disabled={!plan.valid || !hasRequiredMessage || check.kind !== "clean" || applying || applied}
                onClick={() => void apply()}
              >
                {applied ? (
                  <>
                    Applied <CheckGlyph />
                  </>
                ) : applying ? (
                  "Applying…"
                ) : (
                  "Apply rebase"
                )}
              </button>
              <button type="button" className="rebase-discard" onClick={onClear}>
                Clear
              </button>
            </div>
            {check.kind === "snag" && check.unsignedRetry !== undefined && !applied && (
              <button
                type="button"
                className="rebase-check"
                disabled={applying || !hasRequiredMessage}
                onClick={() => void apply(true)}
              >
                {applying ? "Applying…" : "Apply without signing, this once"}
              </button>
            )}
          </div>
          {identity.inspection !== null && identity.inspection.worktreeId === worktreeId && (
            <div className="rebase-note rebase-note--identity">
              {rebaseIdentityLine(identity.inspection)}
            </div>
          )}
          <div className="rebase-note">
            Hooks and rerere are off for both check and apply. The check
            signs nothing; Apply signs only if Git is set to sign commits.
            Other repo-local Git settings can still affect Apply. Nothing is
            pushed.
          </div>
        </>
      )}
    </div>
  );
}
