import { useCallback, useEffect, useState } from "react";
import type { ConflictState, Worktree, WorktreeState } from "@pwrgit/shared";
import { dispatch, subscribe } from "../../lib/pwrgit";
import { RebaseTab } from "./RebaseTab";
import { ChangesTab } from "./ChangesTab";
import { CommitTab } from "./CommitTab";
import { ConflictResolver } from "./ConflictResolver";

type RailTab = "changes" | "rebase";

export type CommitFocus = { hash: string; subject: string };

export function Rail({
  worktree,
  state,
  activeEmail,
  selectedHashes,
  rebaseAction,
  commitFocus,
  onCloseCommit,
  onOpenCommitFile,
  onOpenFullCommitDiff,
  onClearSelection,
  onCollapse,
  onOpenDiff
}: {
  worktree: Worktree | null;
  state: WorktreeState | null;
  activeEmail: string;
  selectedHashes: string[];
  rebaseAction: "squash" | "reorder" | null;
  /** A commit clicked in the lineage — the Changes tab shows ITS files. */
  commitFocus: CommitFocus | null;
  onCloseCommit: () => void;
  onOpenCommitFile: (path: string) => void;
  onOpenFullCommitDiff: () => void;
  onClearSelection: () => void;
  onCollapse: () => void;
  onOpenDiff: (path: string, staged: boolean) => void;
}) {
  const [tab, setTab] = useState<RailTab>("changes");
  const [conflictState, setConflictState] = useState<ConflictState | null>(null);
  const [conflictCheckError, setConflictCheckError] = useState<string | null>(
    null
  );
  const dirty = state?.dirty ?? worktree?.dirty ?? 0;
  const worktreeId = worktree?.id ?? null;
  const conflictActive =
    conflictState !== null &&
    (conflictState.operation !== null || conflictState.conflicts.length > 0);

  const refreshConflicts = useCallback(async (): Promise<void> => {
    if (worktreeId === null) {
      setConflictState(null);
      setConflictCheckError(null);
      return;
    }
    setConflictCheckError(null);
    const result = await dispatch("conflict:state", { worktreeId });
    if (result.ok) setConflictState(result.value);
    else setConflictCheckError(result.error.message);
  }, [worktreeId]);

  useEffect(() => {
    let active = true;
    setConflictState(null);
    setConflictCheckError(null);
    if (worktreeId === null) return;
    const load = (): void => {
      void dispatch("conflict:state", { worktreeId }).then((result) => {
        if (active) {
          if (result.ok) {
            setConflictState(result.value);
            setConflictCheckError(null);
          } else {
            setConflictCheckError(result.error.message);
          }
        }
      });
    };
    load();
    const offWorktree = subscribe("worktree:changed", (event) => {
      if (event.worktreeId === worktreeId) load();
    });
    const offChanges = subscribe("changes:changed", (event) => {
      if (event.worktreeId === worktreeId) load();
    });
    return () => {
      active = false;
      offWorktree();
      offChanges();
    };
  }, [worktreeId]);

  useEffect(() => {
    if (rebaseAction !== null) setTab("rebase");
  }, [rebaseAction]);

  // Clicking a commit pulls the rail to the (commit-scoped) changes view.
  useEffect(() => {
    if (commitFocus !== null) setTab("changes");
  }, [commitFocus]);

  useEffect(() => {
    if (conflictActive) setTab("changes");
  }, [conflictActive]);

  return (
    <aside className="pane pane--rail" data-testid="rail">
      <div className="rail__bar">
        <button
          className={`rail-tab${tab === "changes" ? " is-active" : ""}`}
          onClick={() => setTab("changes")}
        >
          {conflictActive
            ? "Resolve"
            : commitFocus !== null
              ? "Commit"
              : "Changes"}
          {conflictActive ? (
            conflictState.conflicts.length > 0 && (
              <span className="rail-tab__badge">{conflictState.conflicts.length}</span>
            )
          ) : commitFocus === null && dirty > 0 ? (
            <span className="rail-tab__badge">{dirty}</span>
          ) : null}
        </button>
        {!conflictActive && (
          <button
            className={`rail-tab${tab === "rebase" ? " is-active" : ""}`}
            onClick={() => setTab("rebase")}
          >
            Rebase
            {selectedHashes.length > 0 && (
              <span className="rail-tab__badge">{selectedHashes.length}</span>
            )}
          </button>
        )}
        <span style={{ flex: 1 }} />
        <button
          className="icon-btn"
          onClick={onCollapse}
          title="Collapse panel"
          aria-label="Collapse panel"
        >
          ›
        </button>
      </div>

      {worktreeId !== null && conflictState === null ? (
        <div className="rail-empty">
          {conflictCheckError === null ? (
            "Checking Git operation state…"
          ) : (
            <>
              <div>Could not safely check Git operation state.</div>
              <div>{conflictCheckError}</div>
              <button
                className="conflict-refresh"
                onClick={() => void refreshConflicts()}
              >
                Retry
              </button>
            </>
          )}
        </div>
      ) : conflictActive && worktreeId !== null ? (
        <ConflictResolver
          worktreeId={worktreeId}
          state={conflictState}
          onRefresh={refreshConflicts}
        />
      ) : tab === "changes" ? (
        commitFocus !== null && worktree !== null ? (
          <CommitTab
            worktreeId={worktree.id}
            hash={commitFocus.hash}
            subject={commitFocus.subject}
            onOpenFile={onOpenCommitFile}
            onOpenFullDiff={onOpenFullCommitDiff}
            onClose={onCloseCommit}
          />
        ) : (
          <ChangesTab
            worktree={worktree}
            activeEmail={activeEmail}
            onOpenDiff={onOpenDiff}
          />
        )
      ) : (
        <RebaseTab
          worktreeId={worktree?.id ?? null}
          sourceHead={state?.head ?? null}
          selectedHashes={selectedHashes}
          op={rebaseAction}
          onClear={onClearSelection}
        />
      )}
    </aside>
  );
}
