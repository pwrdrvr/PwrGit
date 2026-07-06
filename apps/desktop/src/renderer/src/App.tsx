import { useCallback, useEffect, useMemo, useState } from "react";
import type { Profile, Repo, RepoSearchHit, Worktree } from "@pwrgit/shared";
import { LineageGraph } from "./features/graph/LineageGraph";
import { SelectionBar } from "./features/graph/SelectionBar";
import { WorktreeHeader } from "./features/graph/WorktreeHeader";
import { PaneResizer } from "./features/shell/PaneResizer";
import { Rail } from "./features/rail/Rail";
import { ProfileModal } from "./features/sidebar/ProfileModal";
import { RepoSwitcherOverlay } from "./features/sidebar/RepoSwitcherOverlay";
import { Sidebar } from "./features/sidebar/Sidebar";
import { useAppearance } from "./lib/useAppearance";
import { useColumnResize } from "./lib/useColumnResize";
import { useProfiles } from "./state/useProfiles";
import { useRepoTree } from "./state/useRepoTree";
import { useWorktreeState } from "./state/useWorktreeState";

type Selection = { repoId: string; worktreeId: string };

export function App() {
  useAppearance();
  const sidebar = useColumnResize("pwrgit.sidebarWidth", 320, 240, 520, "left");
  const rail = useColumnResize("pwrgit.railWidth", 344, 280, 560, "right");
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [pendingRepoId, setPendingRepoId] = useState<string | null>(null);

  const {
    profiles,
    activeProfile,
    switchProfile,
    createProfile,
    updateProfile,
    setRoots,
    pickDirectories
  } = useProfiles();
  const [profileModal, setProfileModal] = useState<
    { mode: "create" } | { mode: "edit"; profile: Profile } | null
  >(null);
  const {
    repos,
    loading,
    removalProgress,
    setRepoPin,
    setWorktreePin,
    createWorktree,
    removeWorktrees,
    persistWorktreeOrder,
    computeRepoState
  } = useRepoTree(activeProfile?.id ?? null);

  // Add one or more folders to the active profile in a single native dialog.
  const addFolders = useCallback(async () => {
    if (activeProfile === null) return;
    const picked = await pickDirectories();
    if (picked.length === 0) return;
    await setRoots(activeProfile.id, [...activeProfile.roots, ...picked]);
  }, [activeProfile, pickDirectories, setRoots]);
  const worktreeState = useWorktreeState(selection?.worktreeId ?? null);
  const [selectedCommits, setSelectedCommits] = useState<Set<string>>(
    new Set()
  );
  const [agentAction, setAgentAction] = useState<"squash" | "reorder" | null>(
    null
  );

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

  const clearSelection = useCallback(() => {
    setSelectedCommits(new Set());
    setAgentAction(null);
  }, []);

  const startAgent = useCallback((op: "squash" | "reorder") => {
    setAgentAction(op);
    setRailCollapsed(false);
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

  const gridTemplateColumns = `${sidebar.width}px minmax(0, 1fr) ${
    railCollapsed ? "0px" : `${rail.width}px`
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
          onRemoveWorktree={(id) => void removeWorktrees([id])}
          onRemoveWorktrees={(ids) => void removeWorktrees(ids)}
          onCreateWorktree={createWorktree}
          onPersistOrder={persistWorktreeOrder}
          onExpandRepo={computeRepoState}
          onAddFolder={() => void addFolders()}
          onOpenSearch={() => setOverlayOpen(true)}
          onNewProfile={() => setProfileModal({ mode: "create" })}
          onManageProfile={() =>
            activeProfile !== null &&
            setProfileModal({ mode: "edit", profile: activeProfile })
          }
        />

        <PaneResizer
          side="left"
          offset={sidebar.width}
          width={sidebar.width}
          min={sidebar.min}
          max={sidebar.max}
          onPointerDown={sidebar.onPointerDown}
          onNudge={sidebar.nudge}
          onReset={sidebar.reset}
          ariaLabel="Resize sidebar"
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
                  onSquash={() => startAgent("squash")}
                  onReorder={() => startAgent("reorder")}
                  onAskAgent={() => startAgent(agentAction ?? "squash")}
                  onClear={clearSelection}
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
          <PaneResizer
            side="right"
            offset={rail.width}
            width={rail.width}
            min={rail.min}
            max={rail.max}
            onPointerDown={rail.onPointerDown}
            onNudge={rail.nudge}
            onReset={rail.reset}
            ariaLabel="Resize panel"
          />
        )}

        {!railCollapsed && (
          <Rail
            worktree={selectedWorktree}
            state={worktreeState}
            activeEmail={activeProfile?.email ?? ""}
            selectedHashes={Array.from(selectedCommits)}
            agentAction={agentAction}
            onClearSelection={clearSelection}
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

      {removalProgress !== null && (
        <div className="removal-toast" role="status" aria-live="polite">
          <span className="removal-toast__spinner" />
          <span>
            {removalProgress.done < removalProgress.total
              ? `Removing worktrees… ${removalProgress.done} / ${removalProgress.total}`
              : "Finishing up…"}
          </span>
        </div>
      )}

      {profileModal !== null && (
        <ProfileModal
          mode={profileModal.mode}
          profile={
            profileModal.mode === "edit" ? profileModal.profile : undefined
          }
          onCreate={createProfile}
          onUpdate={updateProfile}
          onSetRoots={setRoots}
          pickDirectories={pickDirectories}
          onClose={() => setProfileModal(null)}
        />
      )}
    </div>
  );
}
