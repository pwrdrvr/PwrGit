import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Commit,
  Profile,
  Repo,
  RepoSearchHit,
  Worktree
} from "@pwrgit/shared";
import { DiffPane, type DiffTarget } from "./features/diff/DiffPane";
import { LineageGraph } from "./features/graph/LineageGraph";
import { SelectionBar } from "./features/graph/SelectionBar";
import { WorktreeHeader } from "./features/graph/WorktreeHeader";
import { DialogHost } from "./features/shell/DialogHost";
import { PaneResizer } from "./features/shell/PaneResizer";
import { ToastHost } from "./features/shell/ToastHost";
import { Rail } from "./features/rail/Rail";
import { ProfileModal } from "./features/sidebar/ProfileModal";
import { CloneRepoDialog } from "./features/sidebar/CloneRepoDialog";
import { RepoSwitcherOverlay } from "./features/sidebar/RepoSwitcherOverlay";
import { Sidebar } from "./features/sidebar/Sidebar";
import { profileWindowTitle } from "./lib/profileTitle";
import { dispatch, subscribe, windowProfileId } from "./lib/pwrgit";
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
  const [cloneOpen, setCloneOpen] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const worktreePrMonitorIdRef = useRef(crypto.randomUUID());
  // A queued "jump to this repo (and optionally this worktree)" — from ⌘F
  // picks and cross-window reveals — resolved once the repo list has it.
  const [pendingReveal, setPendingReveal] = useState<{
    repoId: string;
    worktreeId: string | null;
  } | null>(null);

  const {
    profiles,
    activeProfile,
    openProfile,
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
    refreshingRepoIds,
    setRepoPin,
    setWorktreePin,
    createWorktree,
    removeWorktrees,
    persistWorktreeOrder,
    computeRepoState,
    refreshPullRequest,
    refreshRepoWorktrees
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
  const [rebaseAction, setRebaseAction] = useState<
    "squash" | "reorder" | null
  >(null);
  const [diffTarget, setDiffTarget] = useState<DiffTarget | null>(null);
  // A commit clicked in the lineage — the rail shows its file list, scoped
  // like the WIP Changes tab; files open one-file diffs in the main pane.
  const [commitFocus, setCommitFocus] = useState<{
    hash: string;
    subject: string;
  } | null>(null);
  const [searchableCommits, setSearchableCommits] = useState<Commit[]>([]);
  const [commitReveal, setCommitReveal] = useState<{
    hash: string;
    requestId: number;
  } | null>(null);

  // Clear commit selection + any open diff when the worktree changes.
  useEffect(() => {
    setSelectedCommits(new Set());
    setRebaseAction(null);
    setDiffTarget(null);
    setCommitFocus(null);
    setSearchableCommits([]);
    setCommitReveal(null);
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
    setRebaseAction(null);
  }, []);

  const startRebase = useCallback((op: "squash" | "reorder") => {
    setRebaseAction(op);
    setRailCollapsed(false);
  }, []);

  // ⌘K / ⌘F (and Ctrl variants) open the repo switcher; Escape closes it.
  // ⌘F is the muscle-memory "find" — nothing else claims find yet; if an
  // in-diff text search lands later, scope ⌘F by focus then.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const key = e.key.toLowerCase();
      if ((e.metaKey || e.ctrlKey) && (key === "k" || key === "f")) {
        e.preventDefault();
        setOverlayOpen(true);
      } else if (e.key === "Escape") {
        setOverlayOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Resolve a reveal once this window's repos have loaded: the named worktree
  // if given (⌘F branch hit), else the repo's primary.
  useEffect(() => {
    if (pendingReveal === null) return;
    const repo = repos.find((r) => r.id === pendingReveal.repoId);
    if (repo === undefined) return;
    const target =
      (pendingReveal.worktreeId !== null
        ? repo.worktrees.find((w) => w.id === pendingReveal.worktreeId)
        : undefined) ??
      repo.worktrees.find((w) => w.isPrimary) ??
      repo.worktrees[0];
    if (target !== undefined) {
      setSelection({ repoId: repo.id, worktreeId: target.id });
    }
    setPendingReveal(null);
  }, [pendingReveal, repos]);

  // One window per profile: on boot, pick up any reveal queued for this
  // window (a cross-profile ⌘F pick that opened it); afterwards, reveals for
  // an already-open window arrive as ui:revealRepo events.
  useEffect(() => {
    const profileId = windowProfileId();
    if (profileId === null) return;
    void dispatch("window:consumeReveal", { profileId }).then((r) => {
      if (r.ok && r.value.repoId !== null) {
        setPendingReveal({ repoId: r.value.repoId, worktreeId: r.value.worktreeId });
      }
    });
    return subscribe("ui:revealRepo", (p) => {
      if (p.profileId === profileId) {
        setPendingReveal({ repoId: p.repoId, worktreeId: p.worktreeId });
      }
    });
  }, []);

  // Native Profiles-menu actions land in the focused window.
  useEffect(() => {
    const offNew = subscribe("ui:newProfile", () => {
      if (document.hasFocus()) setProfileModal({ mode: "create" });
    });
    const offManage = subscribe("ui:manageProfile", () => {
      if (document.hasFocus() && activeProfile !== null) {
        setProfileModal({ mode: "edit", profile: activeProfile });
      }
    });
    return () => {
      offNew();
      offManage();
    };
  }, [activeProfile]);

  // Window title carries the profile so the Window menu / Mission Control can
  // tell the profile windows apart (email-disambiguated on name collisions).
  const windowTitle = profileWindowTitle(profiles, activeProfile);
  useEffect(() => {
    document.title = windowTitle;
  }, [windowTitle]);

  const selectWorktree = useCallback((repo: Repo, worktree: Worktree) => {
    setSelection({ repoId: repo.id, worktreeId: worktree.id });
  }, []);

  const onPickSearch = useCallback(
    (hit: RepoSearchHit) => {
      setOverlayOpen(false);
      if (activeProfile !== null && hit.profileId !== activeProfile.id) {
        // Another profile's hit → open/focus THAT profile's window and
        // reveal it there; this window stays put.
        void openProfile(hit.profileId, hit.repoId, hit.worktreeId);
        return;
      }
      setPendingReveal({ repoId: hit.repoId, worktreeId: hit.worktreeId ?? null });
    },
    [activeProfile, openProfile]
  );

  const onPickCommitSearch = useCallback((commit: Commit) => {
    setOverlayOpen(false);
    setDiffTarget(null);
    setCommitFocus({ hash: commit.hash, subject: commit.subject });
    setRailCollapsed(false);
    setCommitReveal((current) => ({
      hash: commit.hash,
      requestId: (current?.requestId ?? 0) + 1
    }));
  }, []);

  const selectedRepo = useMemo(
    () => repos.find((r) => r.id === selection?.repoId) ?? null,
    [repos, selection]
  );
  const selectedWorktree =
    selectedRepo?.worktrees.find((w) => w.id === selection?.worktreeId) ?? null;

  // Reconciliation can remove the selected worktree without changing its
  // persisted selection id. Do not leave that vanished timeline searchable.
  useEffect(() => {
    if (selectedWorktree !== null) return;
    setSearchableCommits([]);
    setCommitReveal(null);
    setCommitFocus(null);
  }, [selectedWorktree]);

  // A selected linked worktree contributes a durable reason to the same
  // main-process PR monitor used by visible commits. Replacing or unmounting
  // this reason cannot stop a PR that another surface still needs.
  useEffect(() => {
    const target =
      selectedRepo === null ||
      selectedWorktree === null ||
      selectedWorktree.isDefaultBranch
        ? undefined
        : {
            repoId: selectedRepo.id,
            worktreeId: selectedWorktree.id,
            branch: selectedWorktree.branch
          };
    void dispatch("pr:replaceWorktreeMonitor", {
      monitorId: worktreePrMonitorIdRef.current,
      ...(target === undefined ? {} : { target })
    });
    return () => {
      void dispatch("pr:replaceWorktreeMonitor", {
        monitorId: worktreePrMonitorIdRef.current
      });
    };
  }, [
    selectedRepo?.id,
    selectedWorktree?.branch,
    selectedWorktree?.id,
    selectedWorktree?.isDefaultBranch
  ]);

  // No PR and terminal PRs need an independent branch-name lookup: a branch
  // can be reused for a later PR that exact-number status polling cannot find.
  // Open PRs use only the shared status monitor until they become terminal.
  useEffect(() => {
    if (
      selectedRepo === null ||
      selectedWorktree === null ||
      selectedWorktree.isDefaultBranch ||
      selectedWorktree.pr?.state === "open"
    ) {
      return;
    }
    const intervalId = window.setInterval(() => {
      refreshPullRequest(selectedRepo.id, selectedWorktree.branch, "scheduled");
    }, 60_000);
    return () => window.clearInterval(intervalId);
  }, [
    refreshPullRequest,
    selectedRepo?.id,
    selectedWorktree?.branch,
    selectedWorktree?.isDefaultBranch,
    selectedWorktree?.pr
  ]);

  const gridTemplateColumns = `${sidebar.width}px minmax(0, 1fr) ${
    railCollapsed ? "0px" : `${rail.width}px`
  }`;

  return (
    <div className="app">
      <div className="titlebar">
        <div className="titlebar__gutter" />
        <div className="titlebar__title">{windowTitle}</div>
        <div className="titlebar__gutter" />
      </div>

      <div className="app-body" style={{ gridTemplateColumns }}>
        <Sidebar
          profiles={profiles}
          activeProfile={activeProfile}
          onSwitchProfile={(id) => void openProfile(id)}
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
          refreshingRepoIds={refreshingRepoIds}
          onRefreshRepo={(repo) => void refreshRepoWorktrees(repo)}
          onRefreshPullRequest={(repoId, branch) =>
            refreshPullRequest(repoId, branch, "user")
          }
          onCloneRepo={() => setCloneOpen(true)}
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
              {/* Keep the lineage graph mounted while a diff is shown — hidden,
                  not unmounted — so returning to it is instant (its multi-branch
                  query is expensive to re-run). */}
              <div
                className="graph-wrap"
                style={{ display: diffTarget !== null ? "none" : "flex" }}
              >
                <LineageGraph
                  repoId={selectedRepo.id}
                  worktreeId={selectedWorktree.id}
                  viewingBranch={selectedWorktree.branch}
                  activeEmail={activeProfile?.email ?? ""}
                  selectedCommits={selectedCommits}
                  focusedCommit={commitFocus?.hash ?? null}
                  revealCommit={commitReveal}
                  onToggleCommit={toggleCommit}
                  onCommitsChange={setSearchableCommits}
                  onOpenCommit={(hash, subject) => {
                    setCommitFocus({ hash, subject });
                    setRailCollapsed(false);
                  }}
                  onRevealWorktree={(worktreeId) => {
                    const repo = repos.find((r) =>
                      r.worktrees.some((w) => w.id === worktreeId)
                    );
                    if (repo !== undefined) {
                      setPendingReveal({ repoId: repo.id, worktreeId });
                    }
                  }}
                />
                {selectedCommits.size > 0 && (
                  <SelectionBar
                    count={selectedCommits.size}
                    onSquash={() => startRebase("squash")}
                    onReorder={() => startRebase("reorder")}
                    onOpenRebaseTool={() =>
                      startRebase(rebaseAction ?? "squash")
                    }
                    onClear={clearSelection}
                  />
                )}
              </div>
              {diffTarget !== null && (
                <DiffPane
                  worktreeId={selectedWorktree.id}
                  target={diffTarget}
                  onClose={() => setDiffTarget(null)}
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
            rebaseAction={rebaseAction}
            commitFocus={commitFocus}
            onCloseCommit={() => setCommitFocus(null)}
            onOpenCommitFile={(path) => {
              if (commitFocus !== null) {
                setDiffTarget({
                  kind: "commitFile",
                  hash: commitFocus.hash,
                  path,
                  subject: commitFocus.subject
                });
              }
            }}
            onOpenFullCommitDiff={() => {
              if (commitFocus !== null) {
                setDiffTarget({
                  kind: "commit",
                  hash: commitFocus.hash,
                  subject: commitFocus.subject
                });
              }
            }}
            onClearSelection={clearSelection}
            onCollapse={() => setRailCollapsed(true)}
            onOpenDiff={(path, staged) =>
              setDiffTarget({ kind: "file", path, staged })
            }
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
          commits={searchableCommits}
          commitContext={
            selectedRepo === null || selectedWorktree === null
              ? null
              : {
                  repoName: selectedRepo.name,
                  branch: selectedWorktree.branch
                }
          }
          onClose={() => setOverlayOpen(false)}
          onPick={onPickSearch}
          onPickCommit={onPickCommitSearch}
        />
      )}

      {cloneOpen && activeProfile !== null && (
        <CloneRepoDialog
          profile={activeProfile}
          onCloned={(repo) => {
            setCloneOpen(false);
            setPendingReveal({ repoId: repo.id, worktreeId: null });
          }}
          onClose={() => setCloneOpen(false)}
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

      <ToastHost />
      <DialogHost />
    </div>
  );
}
