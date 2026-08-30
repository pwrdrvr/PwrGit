import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  BranchReveal,
  Commit,
  FileInsightContext,
  Profile,
  Repo,
  RepoSearchHit,
  Worktree
} from "@pwrgit/shared";
import { DiffPane, type DiffTarget } from "./features/diff/DiffPane";
import {
  FileInsightsPane,
  type FileInsightTab
} from "./features/diff/FileInsightsPane";
import { LineageGraph } from "./features/graph/LineageGraph";
import { SelectionBar } from "./features/graph/SelectionBar";
import { TitleBar } from "./features/chrome/TitleBar";
import { WorktreeHeader } from "./features/graph/WorktreeHeader";
import { DialogHost } from "./features/shell/DialogHost";
import { PaneResizer } from "./features/shell/PaneResizer";
import { ToastHost } from "./features/shell/ToastHost";
import { Rail } from "./features/rail/Rail";
import { ProfileModal } from "./features/sidebar/ProfileModal";
import { CloneRepoDialog } from "./features/sidebar/CloneRepoDialog";
import { ForkRepoDialog } from "./features/sidebar/ForkRepoDialog";
import { NewWorktreeModal } from "./features/sidebar/NewWorktreeModal";
import { RepoSwitcherOverlay } from "./features/sidebar/RepoSwitcherOverlay";
import {
  branchRevealForSearchHit,
  pendingRevealForCreatedWorktree,
  pendingRevealForSearchHit,
  resolveWorktreeReveal,
  type PendingRepoReveal
} from "./features/sidebar/search-reveal";
import { Sidebar } from "./features/sidebar/Sidebar";
import {
  readStoredWorktreeSelection,
  resolveWorktreeSelection,
  storeWorktreeSelection,
  type WorktreeSelection
} from "./features/sidebar/worktree-selection";
import { profileWindowTitle } from "./lib/profileTitle";
import { dispatch, subscribe, windowProfileId } from "./lib/pwrgit";
import { useColumnResize } from "./lib/useColumnResize";
import { useProfiles } from "./state/useProfiles";
import { useRepoTree } from "./state/useRepoTree";
import { useWorktreeState } from "./state/useWorktreeState";

export function App() {
  const sidebar = useColumnResize("pwrgit.sidebarWidth", 320, 240, 520, "left");
  const rail = useColumnResize("pwrgit.railWidth", 344, 280, 560, "right");
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [forkOpen, setForkOpen] = useState(false);
  // A ⌘F pick on a branch with no worktree — the New worktree modal, primed to
  // branch from a fetched ref (remote-only) or to check the branch out (local).
  const [searchNewWorktree, setSearchNewWorktree] = useState<{
    repo: Repo;
    branch: string;
    newBranch: boolean;
    startPoint?: string;
  } | null>(null);
  // Seed from the window-bound profile synchronously. Besides avoiding an
  // empty first frame, this lets Sidebar mount with the restored id and treat
  // it as continuity rather than as a new search jump that should widen the
  // user's persisted lens.
  const [selection, setSelection] = useState<WorktreeSelection | null>(() => {
    const profileId = windowProfileId();
    return profileId === null ? null : readStoredWorktreeSelection(profileId);
  });
  const restoredSelectionForProfileRef = useRef<string | null>(null);
  const worktreePrMonitorIdRef = useRef(crypto.randomUUID());
  // A queued "jump to this repo (and optionally this worktree)" — from ⌘F
  // picks and cross-window reveals — resolved once the repo list has it.
  const [pendingReveal, setPendingReveal] =
    useState<PendingRepoReveal | null>(null);

  const {
    profiles,
    activeProfile,
    loadState: profileLoadState,
    retry: retryProfiles,
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
    loadState: repoLoadState,
    retry: retryRepos,
    removalProgress,
    refreshingRepoIds,
    setRepoPin,
    setWorktreePin,
    createWorktree,
    removeWorktrees,
    persistWorktreeOrder,
    persistRepoOrder,
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
  const [fileInsightTarget, setFileInsightTarget] = useState<{
    path: string;
    context: FileInsightContext;
    tab: FileInsightTab;
    /** Blame opens with this line in view. */
    line?: number;
  } | null>(null);
  const closeDiff = useCallback(() => {
    setFileInsightTarget(null);
    setDiffTarget(null);
  }, []);
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
    setFileInsightTarget(null);
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

  // A branch with no worktree can't be selected — offer to give it one. A
  // remote-only branch is created from the fetched ref; a local branch already
  // exists, so the modal checks it out rather than creating it again.
  const openBranchWorktreeModal = useCallback(
    (repo: Repo, branch: BranchReveal) => {
      setSearchNewWorktree(
        branch.kind === "remote"
          ? {
              repo,
              branch: branch.name,
              newBranch: true,
              startPoint: branch.fullName
            }
          : { repo, branch: branch.name, newBranch: false }
      );
    },
    []
  );

  // Creating a worktree is a "take me there" action, not a filing action: the
  // user named a branch because they want to work on it. Select the worktree
  // the create just indexed, so it doesn't land unfound among a repo's other
  // hundred. Reports the failure message the modals render, as before.
  const createAndRevealWorktree = useCallback(
    async (
      repoId: string,
      branch: string,
      newBranch: boolean,
      startPoint?: string
    ): Promise<string | null> => {
      const result = await createWorktree(repoId, branch, newBranch, startPoint);
      if (!result.ok) return result.message;
      if (result.worktreeId !== null) {
        setPendingReveal(
          pendingRevealForCreatedWorktree(repoId, result.worktreeId)
        );
      }
      return null;
    },
    [createWorktree]
  );

  // Resolve a reveal once this window's repos have loaded: the named worktree
  // if given (⌘F branch hit), else the repo's primary.
  useEffect(() => {
    if (pendingReveal === null) return;
    const repo = repos.find((r) => r.id === pendingReveal.repoId);
    if (repo === undefined) return;
    if (pendingReveal.branch !== null) {
      openBranchWorktreeModal(repo, pendingReveal.branch);
      setPendingReveal(null);
      return;
    }
    const resolved = resolveWorktreeReveal(pendingReveal, repo.worktrees);
    // A freshly created worktree may not be in this copy of the tree yet; keep
    // the reveal queued rather than falling back to the primary.
    if (resolved.kind === "wait") return;
    if (resolved.kind === "select") {
      setSelection({ repoId: repo.id, worktreeId: resolved.worktreeId });
    }
    setPendingReveal(null);
  }, [openBranchWorktreeModal, pendingReveal, repos]);

  // One window per profile: on boot, pick up any reveal queued for this
  // window (a cross-profile ⌘F pick that opened it); afterwards, reveals for
  // an already-open window arrive as ui:revealRepo events.
  useEffect(() => {
    const profileId = windowProfileId();
    if (profileId === null) return;
    void dispatch("window:consumeReveal", { profileId }).then((r) => {
      if (r.ok && r.value.repoId !== null) {
        setPendingReveal({
          repoId: r.value.repoId,
          worktreeId: r.value.worktreeId,
          branch: r.value.branch
        });
      }
    });
    return subscribe("ui:revealRepo", (p) => {
      if (p.profileId === profileId) {
        setPendingReveal({
          repoId: p.repoId,
          worktreeId: p.worktreeId,
          branch: p.branch
        });
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
      const branch = branchRevealForSearchHit(hit);
      if (activeProfile !== null && hit.profileId !== activeProfile.id) {
        // Another profile's hit → open/focus THAT profile's window and
        // reveal it there; this window stays put.
        void openProfile(
          hit.profileId,
          hit.repoId,
          hit.worktreeId,
          branch ?? undefined
        );
        return;
      }
      if (branch !== null) {
        const repo = repos.find((candidate) => candidate.id === hit.repoId);
        if (repo !== undefined) {
          openBranchWorktreeModal(repo, branch);
          return;
        }
      }
      setPendingReveal(pendingRevealForSearchHit(hit));
    },
    [activeProfile, openBranchWorktreeModal, openProfile, repos]
  );

  const onPickCommitSearch = useCallback((commit: Commit) => {
    setOverlayOpen(false);
    setFileInsightTarget(null);
    setDiffTarget(null);
    setCommitFocus({ hash: commit.hash, subject: commit.subject });
    setRailCollapsed(false);
    setCommitReveal((current) => ({
      hash: commit.hash,
      requestId: (current?.requestId ?? 0) + 1
    }));
  }, []);

  // A file picked in the command palette opens its details directly. The diff
  // behind the pane is dropped: it belongs to whatever the user was looking at
  // before, and offering to "go back" to an unrelated file's patch is worse
  // than returning to the lineage.
  const onPickFileSearch = useCallback((path: string) => {
    setOverlayOpen(false);
    setDiffTarget(null);
    setCommitFocus(null);
    setFileInsightTarget({
      path,
      context: { kind: "workingTree" },
      tab: "history"
    });
  }, []);

  const showLineageCommit = useCallback((hash: string, subject: string) => {
    if (!searchableCommits.some((commit) => commit.hash === hash)) return false;
    setFileInsightTarget(null);
    setDiffTarget(null);
    setCommitFocus({ hash, subject });
    setRailCollapsed(false);
    setCommitReveal((current) => ({
      hash,
      requestId: (current?.requestId ?? 0) + 1
    }));
    return true;
  }, [searchableCommits]);

  // What the main pane is showing, so the rail can mark it. Split in two
  // because the two lists answer different questions, and a single loose
  // "active path" got the commit list wrong: focusing another commit in the
  // lineage does NOT close an open diff, so a file open at commit A would
  // light up in commit B's list wherever B touched the same path.
  const changesActiveFile = useMemo<{
    path: string;
    staged: boolean | null;
  } | null>(() => {
    if (fileInsightTarget?.context.kind === "workingTree") {
      return { path: fileInsightTarget.path, staged: null };
    }
    if (diffTarget?.kind === "file") {
      return { path: diffTarget.path, staged: diffTarget.staged };
    }
    return null;
  }, [fileInsightTarget, diffTarget]);

  const commitView = useMemo<
    { kind: "full" } | { kind: "file"; path: string } | null
  >(() => {
    if (commitFocus === null) return null;
    if (diffTarget?.kind === "commit" && diffTarget.hash === commitFocus.hash) {
      return { kind: "full" };
    }
    if (
      diffTarget?.kind === "commitFile" &&
      diffTarget.hash === commitFocus.hash
    ) {
      return { kind: "file", path: diffTarget.path };
    }
    if (
      fileInsightTarget?.context.kind === "commit" &&
      fileInsightTarget.context.hash === commitFocus.hash
    ) {
      return { kind: "file", path: fileInsightTarget.path };
    }
    return null;
  }, [commitFocus, diffTarget, fileInsightTarget]);

  const selectedRepo = useMemo(
    () => repos.find((r) => r.id === selection?.repoId) ?? null,
    [repos, selection]
  );
  const selectedWorktree =
    selectedRepo?.worktrees.find((w) => w.id === selection?.worktreeId) ?? null;

  // A returning profile opens exactly where it left off. Reconcile once, when
  // that profile's repository tree first arrives, so an id that went stale
  // between launches falls back safely. Live removals remain different: they
  // deliberately clear the current timeline instead of silently switching the
  // user to another checkout mid-session.
  useEffect(() => {
    // A queued reveal is an explicit navigation request. Let it select (or
    // keep waiting for) its target before stale boot state chooses a fallback.
    if (
      activeProfile === null ||
      repoLoadState.status === "loading" ||
      pendingReveal !== null ||
      restoredSelectionForProfileRef.current === activeProfile.id
    ) {
      return;
    }
    const preferred =
      selection ?? readStoredWorktreeSelection(activeProfile.id);
    if (preferred === null) {
      restoredSelectionForProfileRef.current = activeProfile.id;
      return;
    }
    // A stored selection can outlive every indexed repo. Wait for a real
    // candidate before choosing a safe fallback instead of clearing it during
    // a transient empty load.
    if (repos.length === 0) return;
    const resolved = resolveWorktreeSelection(repos, preferred);
    restoredSelectionForProfileRef.current = activeProfile.id;
    if (
      resolved !== null &&
      (resolved.repoId !== selection?.repoId ||
        resolved.worktreeId !== selection?.worktreeId)
    ) {
      setSelection(resolved);
    }
  }, [
    activeProfile,
    pendingReveal,
    repoLoadState.status,
    repos,
    selection
  ]);

  useEffect(() => {
    if (activeProfile !== null && selection !== null) {
      storeWorktreeSelection(activeProfile.id, selection);
    }
  }, [activeProfile, selection]);

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
      <TitleBar repo={selectedRepo} worktree={selectedWorktree} />

      <div className="app-body" style={{ gridTemplateColumns }}>
        <Sidebar
          profiles={profiles}
          activeProfile={activeProfile}
          profileLoadState={profileLoadState}
          onRetryProfiles={() => void retryProfiles()}
          onSwitchProfile={(id) => void openProfile(id)}
          repos={repos}
          repoLoadState={repoLoadState}
          onRetryRepos={() => void retryRepos()}
          selectedWorktreeId={selection?.worktreeId ?? null}
          onSelectWorktree={selectWorktree}
          onSetRepoPin={setRepoPin}
          onSetWorktreePin={setWorktreePin}
          onRemoveWorktree={(id) => void removeWorktrees([id])}
          onRemoveWorktrees={(ids) => void removeWorktrees(ids)}
          onCreateWorktree={createAndRevealWorktree}
          onPersistOrder={persistWorktreeOrder}
          onPersistRepoOrder={persistRepoOrder}
          onExpandRepo={computeRepoState}
          refreshingRepoIds={refreshingRepoIds}
          onRefreshRepo={(repo) => void refreshRepoWorktrees(repo)}
          onRefreshPullRequest={(repoId, branch) =>
            refreshPullRequest(repoId, branch, "user")
          }
          onCloneRepo={() => setCloneOpen(true)}
          onForkRepo={() => setForkOpen(true)}
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
                style={{
                  display:
                    diffTarget !== null || fileInsightTarget !== null
                      ? "none"
                      : "flex"
                }}
              >
                <LineageGraph
                  repoId={selectedRepo.id}
                  repoName={selectedRepo.name}
                  worktreeId={selectedWorktree.id}
                  worktreePath={selectedWorktree.path}
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
                  onRevealCreatedWorktree={(worktreeId) =>
                    setPendingReveal(
                      pendingRevealForCreatedWorktree(
                        selectedRepo.id,
                        worktreeId
                      )
                    )
                  }
                  onRevealWorktree={(worktreeId) => {
                    const repo = repos.find((r) =>
                      r.worktrees.some((w) => w.id === worktreeId)
                    );
                    if (repo !== undefined) {
                      setPendingReveal({
                        repoId: repo.id,
                        worktreeId,
                        branch: null
                      });
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
                  onOpenFile={(path, staged) =>
                    setDiffTarget({ kind: "file", path, staged })
                  }
                  hidden={fileInsightTarget !== null}
                  onOpenFileInsight={(path, context, tab, line) =>
                    setFileInsightTarget({
                      path,
                      context,
                      tab,
                      ...(line === undefined ? {} : { line })
                    })
                  }
                  onClose={closeDiff}
                />
              )}
              {fileInsightTarget !== null && (
                <FileInsightsPane
                  key={`${fileInsightTarget.path}:${
                    fileInsightTarget.context.kind === "commit"
                      ? fileInsightTarget.context.hash
                      : "working"
                  }:${fileInsightTarget.tab}:${fileInsightTarget.line ?? ""}`}
                  worktreeId={selectedWorktree.id}
                  path={fileInsightTarget.path}
                  context={fileInsightTarget.context}
                  initialTab={fileInsightTarget.tab}
                  {...(fileInsightTarget.line === undefined
                    ? {}
                    : { initialLine: fileInsightTarget.line })}
                  returnLabel={diffTarget === null ? "Lineage" : "Diff"}
                  onClose={() => setFileInsightTarget(null)}
                  onShowCommit={showLineageCommit}
                />
              )}
            </>
          ) : (
            <div className="main-empty">
              {profileLoadState.status === "loading"
                ? "Loading profiles…"
                : profileLoadState.status === "error"
                  ? "Profiles couldn’t be loaded. Try again from the sidebar."
                  : repoLoadState.status === "loading"
                    ? "Scanning repos…"
                    : repoLoadState.status === "error"
                      ? "Repositories couldn’t be loaded. Try again from the sidebar."
                      : "Select a worktree from the sidebar"}
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
                setFileInsightTarget(null);
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
                setFileInsightTarget(null);
                setDiffTarget({
                  kind: "commit",
                  hash: commitFocus.hash,
                  subject: commitFocus.subject
                });
              }
            }}
            onClearSelection={clearSelection}
            onCollapse={() => setRailCollapsed(true)}
            onOpenDiff={(path, staged) => {
              setFileInsightTarget(null);
              setDiffTarget({ kind: "file", path, staged });
            }}
            activeFile={changesActiveFile}
            commitView={commitView}
            onOpenFileInsight={(path, tab) => {
              setDiffTarget(null);
              setFileInsightTarget({
                path,
                context: { kind: "workingTree" },
                tab
              });
            }}
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
                  branch: selectedWorktree.branch,
                  worktreeId: selectedWorktree.id
                }
          }
          onClose={() => setOverlayOpen(false)}
          onPick={onPickSearch}
          onPickCommit={onPickCommitSearch}
          onPickFile={onPickFileSearch}
        />
      )}

      {searchNewWorktree !== null && (
        <NewWorktreeModal
          repo={searchNewWorktree.repo}
          initialBranch={searchNewWorktree.branch}
          initialNewBranch={searchNewWorktree.newBranch}
          {...(searchNewWorktree.startPoint !== undefined
            ? { startPoint: searchNewWorktree.startPoint }
            : {})}
          onCreate={(branch, newBranch, startPoint) =>
            createAndRevealWorktree(
              searchNewWorktree.repo.id,
              branch,
              newBranch,
              startPoint
            )
          }
          onClose={() => setSearchNewWorktree(null)}
        />
      )}

      {cloneOpen && activeProfile !== null && (
        <CloneRepoDialog
          profile={activeProfile}
          onCloned={(repo) => {
            setCloneOpen(false);
            setPendingReveal({
              repoId: repo.id,
              worktreeId: null,
              branch: null
            });
          }}
          onClose={() => setCloneOpen(false)}
        />
      )}

      {forkOpen && activeProfile !== null && (
        <ForkRepoDialog
          profile={activeProfile}
          onForked={(repo) => {
            setForkOpen(false);
            setPendingReveal({
              repoId: repo.id,
              worktreeId: null,
              branch: null
            });
          }}
          onReveal={(path) => {
            setForkOpen(false);
            void dispatch("shell:revealPath", { path });
          }}
          onClose={() => setForkOpen(false)}
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
