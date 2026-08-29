import { useCallback, useEffect, useRef, useState } from "react";
import type { OperationState, Worktree, WorktreeState } from "@pwrgit/shared";
import { dispatch, subscribe } from "../../lib/pwrgit";
import { OperationBanner } from "./OperationBanner";
import { RebaseTab } from "./RebaseTab";
import { ChangesTab } from "./ChangesTab";
import { CommitTab } from "./CommitTab";

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
  const dirty = state?.dirty ?? worktree?.dirty ?? 0;
  const worktreeId = worktree?.id ?? null;

  // Operation state is advisory: the banner appears when it arrives and the
  // rest of the rail never waits on it. Blocking the file list on an extra
  // git round-trip would tax every worktree switch for a rare state.
  const [operation, setOperation] = useState<OperationState | null>(null);
  const latestRequest = useRef(0);

  const refreshOperation = useCallback((): void => {
    const request = ++latestRequest.current;
    if (worktreeId === null) {
      setOperation(null);
      return;
    }
    void dispatch("operation:state", { worktreeId }).then((result) => {
      // Drop anything a newer request or a worktree switch has superseded.
      if (latestRequest.current !== request) return;
      setOperation(result.ok ? result.value : null);
    });
  }, [worktreeId]);

  useEffect(() => {
    setOperation(null);
    refreshOperation();
    if (worktreeId === null) return;
    const offWorktree = subscribe("worktree:changed", (event) => {
      if (event.worktreeId === worktreeId) refreshOperation();
    });
    const offChanges = subscribe("changes:changed", (event) => {
      if (event.worktreeId === worktreeId) refreshOperation();
    });
    return () => {
      offWorktree();
      offChanges();
    };
  }, [refreshOperation, worktreeId]);

  useEffect(() => {
    if (rebaseAction !== null) setTab("rebase");
  }, [rebaseAction]);

  // Clicking a commit pulls the rail to the (commit-scoped) changes view.
  useEffect(() => {
    if (commitFocus !== null) setTab("changes");
  }, [commitFocus]);

  return (
    <aside className="pane pane--rail" data-testid="rail">
      <div className="rail__bar">
        <button
          className={`rail-tab${tab === "changes" ? " is-active" : ""}`}
          onClick={() => setTab("changes")}
        >
          {commitFocus !== null ? "Commit" : "Changes"}
          {commitFocus === null && dirty > 0 && (
            <span className="rail-tab__badge">{dirty}</span>
          )}
        </button>
        <button
          className={`rail-tab${tab === "rebase" ? " is-active" : ""}`}
          onClick={() => setTab("rebase")}
        >
          Rebase
          {selectedHashes.length > 0 && (
            <span className="rail-tab__badge">{selectedHashes.length}</span>
          )}
        </button>
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

      {operation !== null && worktreeId !== null && (
        <OperationBanner
          worktreeId={worktreeId}
          state={operation}
          onRefresh={refreshOperation}
        />
      )}

      {tab === "changes" ? (
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
