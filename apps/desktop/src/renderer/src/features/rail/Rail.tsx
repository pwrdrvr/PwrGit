import { useCallback, useEffect, useRef, useState } from "react";
import type {
  OperationState,
  StashEntry,
  Worktree,
  WorktreeState
} from "@pwrgit/shared";
import { dispatch, subscribe } from "../../lib/pwrgit";
import { OperationBanner } from "./OperationBanner";
import { RebaseTab } from "./RebaseTab";
import { ChangesTab } from "./ChangesTab";
import { CommitTab } from "./CommitTab";
import { StashesTab } from "./StashesTab";

type RailTab = "changes" | "stashes" | "rebase";

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
  onOpenStashPatch,
  onClearSelection,
  onCollapse,
  onOpenDiff,
  onOpenFileInsight,
  activeFile,
  commitView
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
  onOpenStashPatch: (hash: string, subject: string) => void;
  onClearSelection: () => void;
  onCollapse: () => void;
  onOpenDiff: (path: string, staged: boolean) => void;
  onOpenFileInsight: (
    path: string,
    tab: "history" | "blame",
    staged?: boolean
  ) => void;
  /** What the main pane is showing, so its row can say so. `staged: null`
   *  means the surface has no staged/unstaged notion (a commit, file details). */
  activeFile: { path: string; staged: boolean | null } | null;
  /** What the main pane shows OF THE FOCUSED COMMIT, if anything. */
  commitView: { kind: "full" } | { kind: "file"; path: string } | null;
}) {
  const [tab, setTab] = useState<RailTab>("changes");
  const [stashes, setStashes] = useState<StashEntry[]>([]);
  const [stashesLoading, setStashesLoading] = useState(false);
  const stashLoadGeneration = useRef(0);
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
      // Keep the last good state on failure. A transient read error (index.lock
      // contention, a failed spawn) must not take the banner — and with it the
      // only in-app Abort/Continue — away mid-operation. Switching worktrees
      // clears it explicitly below, so this cannot leak across checkouts.
      if (result.ok) setOperation(result.value);
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

  const reloadStashes = useCallback(async (): Promise<void> => {
    const worktreeId = worktree?.id;
    const generation = ++stashLoadGeneration.current;
    if (worktreeId === undefined) {
      setStashes([]);
      setStashesLoading(false);
      return;
    }
    setStashesLoading(true);
    const result = await dispatch("stash:list", { worktreeId });
    if (generation !== stashLoadGeneration.current) return;
    if (result.ok) setStashes(result.value);
    setStashesLoading(false);
  }, [worktree?.id]);

  useEffect(() => {
    void reloadStashes();
    if (worktree === null) return;
    return subscribe("stash:changed", ({ repoId }) => {
      if (repoId === worktree.repoId) void reloadStashes();
    });
  }, [reloadStashes, worktree]);

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
          className={`rail-tab${tab === "stashes" ? " is-active" : ""}`}
          onClick={() => setTab("stashes")}
        >
          Stashes
          {stashes.length > 0 && (
            <span className="rail-tab__badge">{stashes.length}</span>
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
            view={commitView}
            onOpenFullDiff={onOpenFullCommitDiff}
            onClose={onCloseCommit}
          />
        ) : (
          <ChangesTab
            worktree={worktree}
            activeEmail={activeEmail}
            onOpenDiff={onOpenDiff}
            onOpenFileInsight={onOpenFileInsight}
            activeFile={activeFile}
          />
        )
      ) : tab === "stashes" ? (
        <StashesTab
          worktree={worktree}
          entries={stashes}
          loading={stashesLoading}
          reload={reloadStashes}
          onOpenPatch={onOpenStashPatch}
        />
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
