import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentTidyProposal,
  HistoryEditProgram,
  RebaseCommitRef,
  RebaseOperation,
  RebasePlan,
  RebaseProof,
  RebaseSnagDetail
} from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";
import { RebaseGlyph } from "../../lib/RebaseGlyph";
import { AgentChip } from "../agent/AgentChip";
import { AgentSaw } from "../agent/AgentSaw";
import { DraftFooter } from "../agent/DraftFooter";
import { useAgent } from "../agent/agent-store";
import { useMessageDraft } from "../agent/useMessageDraft";
import {
  bodyOf,
  joinedSubjects,
  ledgerRows,
  NO_EDITS,
  planDiff,
  programShapeKey,
  resultCount,
  short,
  squashProgram,
  subjectOf,
  tidyGroups,
  tidyProgram,
  type LedgerCheck,
  type LedgerRow,
  type TidyEdits,
  type TidyGroup
} from "./history-edit";

/** Matches the main process: a failed plan is revised at most twice. */
const MAX_REVISIONS = 2;

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

const STEP_CLASS: Record<string, string> = {
  pick: "rebase-op--pick",
  squash: "rebase-op--squash",
  fixup: "rebase-op--fixup"
};

const OP_LABEL: Record<RebaseOperation, string> = {
  squash: "Squash",
  reorder: "Reorder",
  tidy: "Tidy"
};

type CheckState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "clean"; approvalToken: string; proof: RebaseProof; shape: string }
  | { kind: "snag"; code: string; message: string; detail?: RebaseSnagDetail };

type TidyState =
  | { kind: "idle" }
  | { kind: "requesting"; revising: boolean }
  | {
      kind: "ready";
      proposal: AgentTidyProposal;
      revisions: number;
      /** The plan this one replaced, and why the check refused it. */
      revisedFrom: { program: HistoryEditProgram; detail: RebaseSnagDetail } | null;
    }
  | { kind: "failed"; code: string; message: string; afterMs: number };

export function ProofLedger({ rows }: { rows: LedgerRow[] }) {
  return (
    <div className="proof-ledger" aria-label="What the check proves">
      {rows.map((row) => (
        <div key={row.label} className={`proof-ledger__row proof-ledger__row--${row.state}`}>
          <span className="proof-ledger__glyph" aria-hidden="true">
            {row.state === "ok" ? "✓" : row.state === "bad" ? "✕" : "○"}
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
    return (
      <div className="rebase-check-result rebase-check-result--clean" role="status">
        <span>Clean</span>
        Check passed: the isolated copy produced {resultCommits} commit
        {resultCommits === 1 ? "" : "s"} with an identical tree.
      </div>
    );
  }
  const detail = check.detail;
  if (detail?.kind === "tree_changed") {
    return (
      <div className="rebase-check-result rebase-check-result--bad" role="status">
        <span>Discarded</span>
        <div>
          {check.message} A history edit can't change code.
          {detail.files.length > 0 && (
            <>
              {" "}
              <button
                type="button"
                className="agent-link"
                aria-expanded={showFiles}
                onClick={() => setShowFiles((v) => !v)}
              >
                {showFiles ? "Hide files" : "Show what changed"}
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

function GroupMessage({
  group,
  disabled,
  onEdit
}: {
  group: TidyGroup;
  disabled: boolean;
  onEdit: (message: string) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const subject = subjectOf(group.message, "");
  const body = bodyOf(group.message);
  if (editing !== null) {
    return (
      <div className="tidy-group__edit">
        <textarea
          className="tidy-group__input"
          aria-label="Commit message"
          value={editing}
          autoFocus
          onChange={(e) => setEditing(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setEditing(null);
          }}
        />
        <div className="tidy-group__edit-actions">
          <button
            type="button"
            className="agent-link"
            disabled={editing.trim() === ""}
            onClick={() => {
              onEdit(editing);
              setEditing(null);
            }}
          >
            Save
          </button>
          <button type="button" className="agent-link agent-link--quiet" onClick={() => setEditing(null)}>
            Cancel
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="tidy-group__head">
      <div className="tidy-group__subject">
        <span>{subject}</span>
        {!disabled && (
          <button
            type="button"
            className="agent-link agent-link--quiet"
            onClick={() => setEditing(group.message)}
          >
            Edit
          </button>
        )}
      </div>
      {body !== "" && <div className="tidy-group__body">{body}</div>}
    </div>
  );
}

export function TidyGroups({
  groups,
  locked,
  onToggle,
  onEditMessage
}: {
  groups: TidyGroup[];
  locked: boolean;
  onToggle: (hash: string) => void;
  onEditMessage: (index: number, message: string) => void;
}) {
  return (
    <div className="tidy-groups">
      {groups.map((group) => (
        <div key={group.index} className="tidy-group" data-lane={group.index % 8}>
          <GroupMessage
            group={group}
            disabled={locked}
            onEdit={(message) => onEditMessage(group.index, message)}
          />
          {group.rows.map((row) => (
            <div
              key={row.hash}
              className={`tidy-member${row.separated ? " tidy-member--separate" : ""}`}
            >
              <span className={`tidy-member__role tidy-member__role--${row.role}`}>{row.role}</span>
              <span className="tidy-member__hash">{short(row.hash)}</span>
              <span className="tidy-member__subject">{row.subject}</span>
              <span className="tidy-member__tools">
                {row.moved && <span className="tidy-member__moved">moved</span>}
                {row.canToggle && !locked && (
                  <button type="button" className="tidy-member__toggle" onClick={() => onToggle(row.hash)}>
                    {row.separated ? "Fold back" : "Keep separate"}
                  </button>
                )}
              </span>
            </div>
          ))}
        </div>
      ))}
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
  const agent = useAgent();
  const [plan, setPlan] = useState<RebasePlan | null>(null);
  const [commits, setCommits] = useState<RebaseCommitRef[]>([]);
  const [check, setCheck] = useState<CheckState>({ kind: "idle" });
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState(false);
  const [tidy, setTidy] = useState<TidyState>({ kind: "idle" });
  const [edits, setEdits] = useState<TidyEdits>(NO_EDITS);
  const [chipSignal, setChipSignal] = useState(0);
  const checkGeneration = useRef(0);
  const tidyRequest = useRef<{ id: string; startedAt: number } | null>(null);
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Read after an await: the revision that triggered a re-check has landed by
  // the time its result does, and a closure would still hold the old state.
  const tidyRef = useRef(tidy);
  tidyRef.current = tidy;

  const squash = useMessageDraft({
    worktreeId,
    source:
      op === "squash" && commits.length > 1 ? { kind: "commits", commits } : null,
    fallback: joinedSubjects(commits),
    autoStart: true
  });

  const cancelTidyRequest = (): void => {
    const active = tidyRequest.current;
    if (active === null) return;
    tidyRequest.current = null;
    void dispatch("agent:cancel", { requestId: active.id });
  };

  const key = selectedHashes.join(",");
  useEffect(() => {
    cancelTidyRequest();
    if (clearTimer.current !== null) {
      clearTimeout(clearTimer.current);
      clearTimer.current = null;
    }
    checkGeneration.current += 1;
    setCheck({ kind: "idle" });
    setApplied(false);
    setPlan(null);
    setCommits([]);
    setTidy({ kind: "idle" });
    setEdits(NO_EDITS);
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

  useEffect(
    () => () => {
      cancelTidyRequest();
      if (clearTimer.current !== null) clearTimeout(clearTimer.current);
    },
    []
  );

  const program: HistoryEditProgram | null = useMemo(() => {
    if (op === "squash") {
      return squash.text.trim() === "" ? null : squashProgram(commits, squash.text);
    }
    if (op === "tidy") {
      return tidy.kind === "ready" ? tidyProgram(tidy.proposal.program, edits) : null;
    }
    return null;
  }, [op, commits, squash.text, tidy, edits]);
  const shape = program === null ? "" : programShapeKey(program);

  // Keep separate changes what the check proved; a message edit does not.
  useEffect(() => {
    if (check.kind === "clean" && check.shape !== shape) {
      checkGeneration.current += 1;
      setCheck({ kind: "idle" });
    }
  }, [shape, check]);

  const runCheck = async (withProgram: HistoryEditProgram | null = program): Promise<void> => {
    if (worktreeId === null || op === null || plan === null || !plan.valid) return;
    if (op !== "reorder" && withProgram === null) return;
    checkGeneration.current += 1;
    const generation = checkGeneration.current;
    setCheck({ kind: "checking" });
    const result = await dispatch("rebase:check", {
      worktreeId,
      commits,
      op,
      ...(withProgram !== null ? { program: withProgram } : {})
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
        proof: value.proof,
        shape: withProgram === null ? "" : programShapeKey(withProgram)
      });
      return;
    }
    setCheck({
      kind: "snag",
      code: value.code,
      message: value.message,
      ...(value.detail !== undefined ? { detail: value.detail } : {})
    });
    // A conflict is information the agent can use: ask for a revision once
    // per failure, up to the limit, and re-check on arrival.
    const current = tidyRef.current;
    if (
      op === "tidy" &&
      value.detail?.kind === "conflict" &&
      withProgram !== null &&
      current.kind === "ready" &&
      current.revisions < MAX_REVISIONS
    ) {
      requestTidy({ program: withProgram, detail: value.detail, revisions: current.revisions });
    }
  };

  const requestTidy = (
    revision?: { program: HistoryEditProgram; detail: RebaseSnagDetail; revisions: number }
  ): void => {
    if (worktreeId === null || commits.length < 2) return;
    cancelTidyRequest();
    const id = crypto.randomUUID();
    const startedAt = Date.now();
    tidyRequest.current = { id, startedAt };
    setTidy({ kind: "requesting", revising: revision !== undefined });
    const choice = agent.state.choice;
    void dispatch("agent:tidyPlan", {
      requestId: id,
      worktreeId,
      commits,
      ...(revision !== undefined
        ? {
            revision: {
              program: revision.program,
              detail: revision.detail,
              attempt: revision.revisions + 1
            }
          }
        : {}),
      ...(choice.model !== undefined || choice.effort !== undefined ? { choice } : {})
    }).then((result) => {
      if (tidyRequest.current?.id !== id) return;
      tidyRequest.current = null;
      if (!result.ok) {
        setTidy({
          kind: "failed",
          code: result.error.code,
          message: result.error.message,
          afterMs: Date.now() - startedAt
        });
        return;
      }
      setEdits(NO_EDITS);
      setTidy({
        kind: "ready",
        proposal: result.value,
        revisions: revision === undefined ? 0 : revision.revisions + 1,
        revisedFrom:
          revision === undefined ? null : { program: revision.program, detail: revision.detail }
      });
      if (revision !== undefined) {
        void runCheck(tidyProgram(result.value.program, NO_EDITS));
      } else {
        checkGeneration.current += 1;
        setCheck({ kind: "idle" });
      }
    });
  };

  // Tidy is an agent action from the start: ask as soon as the selection is
  // known good and an agent is ready.
  useEffect(() => {
    if (op !== "tidy" || plan?.valid !== true || !agent.ready || tidy.kind !== "idle") return;
    requestTidy();
  }, [op, plan?.valid, agent.ready, key]);

  const apply = async (): Promise<void> => {
    if (worktreeId === null || op === null || plan === null || !plan.valid || check.kind !== "clean") {
      return;
    }
    if (op !== "reorder" && program === null) return;
    setApplying(true);
    const result = await dispatch("rebase:apply", {
      worktreeId,
      commits,
      op,
      approvalToken: check.approvalToken,
      ...(program !== null ? { program } : {})
    });
    setApplying(false);
    if (result.ok) {
      setApplied(true);
      // Held so it can be cancelled: firing after a new selection was made
      // would clear that one instead of this finished rebase.
      clearTimer.current = setTimeout(onClear, 900);
    } else {
      setCheck({ kind: "snag", code: result.error.code, message: result.error.message });
    }
  };

  const discard = (): void => {
    cancelTidyRequest();
    onClear();
  };

  const resultCommits =
    op === "squash"
      ? 1
      : op === "reorder"
        ? commits.length
        : program !== null
          ? resultCount(program)
          : null;
  const headSub =
    op === null || commits.length === 0
      ? "Isolated check · hooks and signing disabled"
      : `${commits.length} → ${resultCommits ?? "…"}${branch !== null && branch !== "" ? ` · ${branch}` : ""}`;
  const ledgerCheck: LedgerCheck =
    check.kind === "clean"
      ? { kind: "clean", proof: check.proof }
      : check.kind === "snag"
        ? check.detail !== undefined
          ? { kind: "snag", detail: check.detail }
          : { kind: "snag" }
        : check;
  const revised = tidy.kind === "ready" && tidy.revisedFrom !== null;
  const lastModel =
    op === "tidy" && tidy.kind === "ready"
      ? tidy.proposal.model
      : (squash.draft?.model ?? undefined);
  const needsProgram = op === "squash" || op === "tidy";
  const canCheck =
    plan?.valid === true &&
    (!needsProgram || program !== null) &&
    check.kind !== "checking" &&
    check.kind !== "clean" &&
    !applying &&
    !applied &&
    !(op === "tidy" && tidy.kind === "requesting");
  const treeChanged = check.kind === "snag" && check.detail?.kind === "tree_changed";

  return (
    <div className="rebase-tab">
      <div className="rebase-head">
        <span className="rebase-head__icon">
          {op === "tidy" ? "✦" : <RebaseGlyph />}
        </span>
        <div className="rebase-head__text">
          <div className="rebase-head__title">{op === null ? "Rebase tool" : OP_LABEL[op]}</div>
          <div className="rebase-head__sub">{headSub}</div>
        </div>
        {op !== null && <AgentChip {...(lastModel !== undefined ? { lastModel } : {})} openSignal={chipSignal} />}
      </div>

      {op === null || plan === null ? (
        <div className="rebase-empty">
          Select commits in the graph, then choose{" "}
          <span className="rebase-accent">Squash</span>,{" "}
          <span className="rebase-accent">Reorder</span> or{" "}
          <span className="rebase-accent">✦ Tidy</span>. You can inspect the
          exact plan and check it safely before changing the worktree.
        </div>
      ) : (
        <>
          {op !== "tidy" && (
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
            </>
          )}

          {op === "squash" && plan.valid && (
            <>
              <div className="rebase-section">Commit message</div>
              <div className={`msg-box${squash.origin === "agent" || squash.pending ? " msg-box--agent" : ""}`}>
                <textarea
                  className={`msg-box__input${squash.status.kind === "drafting" ? " msg-box__input--scan" : ""}`}
                  aria-label="Commit message"
                  value={squash.text}
                  onChange={(e) => squash.setText(e.target.value)}
                  spellCheck={false}
                  disabled={applying || applied}
                />
                <DraftFooter
                  draft={squash}
                  agentName={agent.name}
                  agentReady={agent.ready}
                  fallbackLabel={`Joined from ${commits.length} subjects`}
                  fallbackAction="Use subjects"
                  unitLabel={`${commits.length} diffs`}
                  onNoAgent={() => setChipSignal((n) => n + 1)}
                />
              </div>
              {squash.draft !== null && (
                <>
                  <div className="agent-style">
                    Style:{" "}
                    <b>
                      {squash.draft.style.convention === "conventional"
                        ? "conventional commits"
                        : "plain subjects"}
                    </b>
                    , matched from {squash.draft.style.matched} of the last{" "}
                    {squash.draft.style.sampled} subjects
                  </div>
                  <AgentSaw
                    manifest={squash.draft.saw}
                    providerName={squash.draft.providerName}
                    model={squash.draft.model}
                  />
                </>
              )}
              {squash.text.trim() === "" && (
                <div className="rebase-note">Write a commit message to check and apply.</div>
              )}
            </>
          )}

          {op === "tidy" && (
            <TidyBody
              tidy={tidy}
              commits={commits}
              edits={edits}
              agentName={agent.name}
              agentReady={agent.ready}
              locked={applying || applied || check.kind === "checking"}
              onRequest={() => requestTidy()}
              onCancel={cancelTidyRequest}
              onChooseAgent={() => setChipSignal((n) => n + 1)}
              onToggle={(hash) =>
                setEdits((current) => {
                  const separated = new Set(current.separated);
                  if (separated.has(hash)) separated.delete(hash);
                  else separated.add(hash);
                  return { ...current, separated };
                })
              }
              onEditMessage={(index, message) =>
                setEdits((current) => {
                  const messages = new Map(current.messages);
                  messages.set(index, message);
                  return { ...current, messages };
                })
              }
            />
          )}

          {op !== "tidy" && (
            <>
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
            </>
          )}

          {plan.valid && (op !== "tidy" || tidy.kind === "ready") && (
            <ProofLedger rows={ledgerRows(commits, ledgerCheck, revised && check.kind === "clean")} />
          )}

          <CheckResult check={check} resultCommits={resultCommits ?? commits.length} />

          {applied && (
            <div className="rebase-applied" role="status">
              Applied locally · {resultCommits ?? commits.length} commit
              {resultCommits === 1 ? "" : "s"} · nothing pushed.
            </div>
          )}

          {op === "tidy" && tidy.kind !== "ready" ? (
            // Nothing to check until there is a plan; the footer above says
            // what is happening and what to do about it.
            <div className="rebase-actions">
              <div className="rebase-actions__row">
                <button type="button" className="rebase-discard" onClick={discard}>
                  Discard
                </button>
              </div>
            </div>
          ) : (
            <div className="rebase-actions">
              {treeChanged && op === "tidy" ? (
                <button
                  type="button"
                  className="rebase-check"
                  disabled={!agent.ready || tidy.kind === "requesting"}
                  onClick={() => {
                    if (
                      tidy.kind === "ready" &&
                      program !== null &&
                      check.kind === "snag" &&
                      check.detail !== undefined &&
                      tidy.revisions < MAX_REVISIONS
                    ) {
                      requestTidy({ program, detail: check.detail, revisions: tidy.revisions });
                    } else {
                      requestTidy();
                    }
                    checkGeneration.current += 1;
                    setCheck({ kind: "idle" });
                  }}
                >
                  Ask {agent.name} for another plan
                </button>
              ) : (
                <button
                  type="button"
                  className={`rebase-check${check.kind === "clean" ? " rebase-check--done" : ""}`}
                  disabled={!canCheck}
                  onClick={() => void runCheck()}
                >
                  {check.kind === "checking"
                    ? "Checking…"
                    : check.kind === "clean"
                      ? "Checked ✓"
                      : "Check in isolated copy"}
                </button>
              )}
              <div className="rebase-actions__row">
                <button
                  type="button"
                  className="rebase-apply"
                  disabled={!plan.valid || check.kind !== "clean" || applying || applied}
                  onClick={() => void apply()}
                >
                  {applied
                    ? "Applied ✓"
                    : applying
                      ? "Applying…"
                      : op === "tidy"
                        ? revised
                          ? "Apply revised plan"
                          : `Apply ${resultCommits ?? commits.length} commits`
                        : "Apply rebase"}
                </button>
                <button type="button" className="rebase-discard" onClick={discard}>
                  {op === "tidy" ? "Discard" : "Clear"}
                </button>
              </div>
            </div>
          )}
          <div className="rebase-note">
            {op === "tidy"
              ? "Keep separate turns a fold back into its own commit with its original message, and resets the check. "
              : ""}
            Hooks, signing, and rerere are disabled for both check and apply.
            Other repo-local Git settings can still affect Apply. Nothing is
            pushed.
          </div>
        </>
      )}
    </div>
  );
}

function TidyBody({
  tidy,
  commits,
  edits,
  agentName,
  agentReady,
  locked,
  onRequest,
  onCancel,
  onChooseAgent,
  onToggle,
  onEditMessage
}: {
  tidy: TidyState;
  commits: RebaseCommitRef[];
  edits: TidyEdits;
  agentName: string;
  agentReady: boolean;
  locked: boolean;
  onRequest: () => void;
  onCancel: () => void;
  onChooseAgent: () => void;
  onToggle: (hash: string) => void;
  onEditMessage: (index: number, message: string) => void;
}) {
  if (tidy.kind === "ready") {
    const { proposal } = tidy;
    const diff =
      tidy.revisedFrom === null
        ? []
        : planDiff(commits, tidy.revisedFrom.program, proposal.program);
    const why = tidy.revisedFrom?.detail;
    return (
      <>
        {tidy.revisedFrom !== null && (
          <div className="tidy-revision">
            <div className="tidy-revision__head">
              ✦ {proposal.providerName} revised the plan
              <span>
                revision {tidy.revisions} of {MAX_REVISIONS}
              </span>
            </div>
            {why !== undefined && (
              <div className="tidy-revision__why">
                {why.kind === "conflict"
                  ? `The check stopped: ${conflictSentence(why)}`
                  : `The check found the code would change in ${why.files.map((f) => f.path).join(", ")}.`}
              </div>
            )}
            {proposal.note ?? "The plan was changed to avoid the conflict."}
            {diff.length > 0 && (
              <div className="tidy-revision__diff">
                {diff.map((line, index) => (
                  <div key={index} className={`tidy-revision__${line.kind}`}>
                    {line.kind === "del" ? "− " : "+ "}
                    {line.text}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        <div className="rebase-section">
          Proposed history <span className="rebase-section__aside">newest first</span>
        </div>
        {tidy.revisedFrom === null && proposal.note !== null && (
          <div className="tidy-note">{proposal.note}</div>
        )}
        <TidyGroups
          groups={tidyGroups(commits, proposal.program, edits)}
          locked={locked}
          onToggle={onToggle}
          onEditMessage={onEditMessage}
        />
        <AgentSaw manifest={proposal.saw} providerName={proposal.providerName} model={proposal.model} />
      </>
    );
  }

  let footer: { text: string; tone: "agent" | "quiet" | "warn"; link?: { label: string; quiet?: boolean; onClick: () => void } };
  if (tidy.kind === "requesting") {
    footer = {
      text: tidy.revising
        ? `✦ ${agentName} is revising the plan…`
        : `✦ ${agentName} is reading ${commits.length} diffs…`,
      tone: "agent",
      link: { label: "Cancel", quiet: true, onClick: onCancel }
    };
  } else if (tidy.kind === "failed") {
    footer = {
      text:
        tidy.code === "cancelled"
          ? "Cancelled. Nothing changed."
          : tidy.code === "timeout"
            ? `${agentName} stopped after ${Math.max(1, Math.round(tidy.afterMs / 1000))} s. Nothing changed.`
            : tidy.message,
      tone: tidy.code === "cancelled" ? "quiet" : "warn",
      ...(agentReady ? { link: { label: tidy.code === "cancelled" ? "✦ Tidy" : "Retry", onClick: onRequest } } : {})
    };
  } else if (!agentReady) {
    footer = {
      text: "No agent is set up for this profile",
      tone: "warn",
      link: { label: "Choose an agent…", onClick: onChooseAgent }
    };
  } else {
    footer = { text: "", tone: "quiet", link: { label: "✦ Tidy", onClick: onRequest } };
  }

  return (
    <>
      <div className="rebase-section">
        Proposed history <span className="rebase-section__aside">newest first</span>
      </div>
      <div className="msg-box">
        <div className={`msg-box__placeholder${tidy.kind === "requesting" ? " msg-box__input--scan" : ""}`}>
          {!agentReady && tidy.kind === "idle" ? (
            <span className="msg-box__hint">Tidy needs an agent. Squash and Reorder don't.</span>
          ) : (
            commits.map((commit) => (
              <div key={commit.hash} className="msg-box__line">
                <span>{short(commit.hash)}</span> {commit.subject}
              </div>
            ))
          )}
        </div>
        <div className="msg-foot" role="status">
          <span className={`msg-foot__src msg-foot__src--${footer.tone}`}>{footer.text}</span>
          <span className="msg-foot__sp" />
          {footer.link !== undefined && (
            <button
              type="button"
              className={`agent-link${footer.link.quiet === true ? " agent-link--quiet" : ""}`}
              onClick={footer.link.onClick}
            >
              {footer.link.label}
            </button>
          )}
        </div>
      </div>
    </>
  );
}
