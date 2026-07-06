import { useCallback, useEffect, useMemo, useState } from "react";
import type { Repo, RepoSearchHit, Worktree } from "@pwrgit/shared";
import { LineageGraph } from "./features/graph/LineageGraph";
import { SelectionBar } from "./features/graph/SelectionBar";
import { WorktreeHeader } from "./features/graph/WorktreeHeader";
import { Rail } from "./features/rail/Rail";
import { RepoSwitcherOverlay } from "./features/sidebar/RepoSwitcherOverlay";
import { Sidebar } from "./features/sidebar/Sidebar";
import { useAppearance } from "./lib/useAppearance";
import { useProfiles } from "./state/useProfiles";
import { useRepoTree } from "./state/useRepoTree";
import { useWorktreeState } from "./state/useWorktreeState";

type Selection = { repoId: string; worktreeId: string };

export function App() {
  useAppearance();
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [pendingRepoId, setPendingRepoId] = useState<string | null>(null);

  const { profiles, activeProfile, switchProfile } = useProfiles();
  const {
    repos,
    loading,
    setRepoPin,
    setWorktreePin,
    addFolder,
    createWorktree,
    removeWorktree,
    persistWorktreeOrder
  } = useRepoTree(activeProfile?.id ?? null);
  const worktreeState = useWorktreeState(selection?.worktreeId ?? null);
  const [selectedCommits, setSelectedCommits] = useState<Set<string>>(
    new Set()
  );
  const [, setAgentAction] = useState<"squash" | "reorder" | null>(null);

  // Clear commit selection when the worktree changes.
  useEffect(() => {
    setSelectedCommits(new Set());
    setAgentAction(null);
  }, [selection?.worktreeId]);

  const toggleCommit = useCallback((hash: string) => {
    setSelectedCommits((prev) => {
      const next = new Set(prev);
      if (next.has(hash)) next.delete(hash);
      else next.add(hash);
      return next;
    });
  }, []);

  // ⌘K / Ctrl+K opens the repo switcher; Escape closes it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOverlayOpen(true);
      } else if (e.key === "Escape") {
        setOverlayOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Resolve a cross-profile pick once the target profile's repos have loaded.
  useEffect(() => {
    if (pendingRepoId === null) return;
    const repo = repos.find((r) => r.id === pendingRepoId);
    if (repo === undefined) return;
    const primary =
      repo.worktrees.find((w) => w.isPrimary) ?? repo.worktrees[0];
    if (primary !== undefined) {
      setSelection({ repoId: repo.id, worktreeId: primary.id });
    }
    setPendingRepoId(null);
  }, [pendingRepoId, repos]);

  const selectWorktree = useCallback((repo: Repo, worktree: Worktree) => {
    setSelection({ repoId: repo.id, worktreeId: worktree.id });
  }, []);

  const onPickSearch = useCallback(
    (hit: RepoSearchHit) => {
      setOverlayOpen(false);
      if (activeProfile !== null && hit.profileId !== activeProfile.id) {
        switchProfile(hit.profileId);
      }
      setPendingRepoId(hit.repoId);
    },
    [activeProfile, switchProfile]
  );

  const selectedRepo = useMemo(
    () => repos.find((r) => r.id === selection?.repoId) ?? null,
    [repos, selection]
  );
  const selectedWorktree =
    selectedRepo?.worktrees.find((w) => w.id === selection?.worktreeId) ?? null;

  const gridTemplateColumns = `320px minmax(0, 1fr) ${
    railCollapsed ? "0px" : "344px"
  }`;

  return (
    <div className="app">
      <div className="titlebar">
        <div className="titlebar__gutter" />
        <div className="titlebar__title">PwrGit</div>
        <div className="titlebar__gutter" />
      </div>

      <div className="app-body" style={{ gridTemplateColumns }}>
        <Sidebar
          profiles={profiles}
          activeProfile={activeProfile}
          onSwitchProfile={switchProfile}
          repos={repos}
          loading={loading}
          selectedWorktreeId={selection?.worktreeId ?? null}
          onSelectWorktree={selectWorktree}
          onSetRepoPin={setRepoPin}
          onSetWorktreePin={setWorktreePin}
          onRemoveWorktree={(id) => void removeWorktree(id)}
          onCreateWorktree={createWorktree}
          onPersistOrder={persistWorktreeOrder}
          onAddFolder={() => void addFolder()}
          onOpenSearch={() => setOverlayOpen(true)}
        />

        <main className="pane pane--main" data-testid="main">
          {selectedRepo !== null && selectedWorktree !== null ? (
            <>
              <WorktreeHeader
                repo={selectedRepo}
                worktree={selectedWorktree}
                state={worktreeState}
              />
              <LineageGraph
                worktreeId={selectedWorktree.id}
                activeEmail={activeProfile?.email ?? ""}
                selectedCommits={selectedCommits}
                onToggleCommit={toggleCommit}
              />
              {selectedCommits.size > 0 && (
                <SelectionBar
                  count={selectedCommits.size}
                  onSquash={() => setAgentAction("squash")}
                  onReorder={() => setAgentAction("reorder")}
                  onAskAgent={() => setAgentAction((a) => a ?? "squash")}
                  onClear={() => setSelectedCommits(new Set())}
                />
              )}
            </>
          ) : (
            <div className="main-empty">
              {loading ? "Scanning repos…" : "Select a worktree from the sidebar"}
            </div>
          )}
        </main>

        {!railCollapsed && (
          <Rail
            worktree={selectedWorktree}
            state={worktreeState}
            activeEmail={activeProfile?.email ?? ""}
            onCollapse={() => setRailCollapsed(true)}
          />
        )}

        {railCollapsed && (
          <button className="rail-reopen" onClick={() => setRailCollapsed(false)}>
            ‹ Panel
          </button>
        )}
      </div>

      {overlayOpen && (
        <RepoSwitcherOverlay
          onClose={() => setOverlayOpen(false)}
          onPick={onPickSearch}
        />
      )}
    </div>
  );
}
