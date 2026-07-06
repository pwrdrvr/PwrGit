import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  Repo,
  RepoSearchHit,
  Worktree,
  WorktreeState
} from "@pwrgit/shared";
import { RepoSwitcherOverlay } from "./features/sidebar/RepoSwitcherOverlay";
import { Sidebar } from "./features/sidebar/Sidebar";
import { useAppearance } from "./lib/useAppearance";
import { useProfiles } from "./state/useProfiles";
import { useRepoTree } from "./state/useRepoTree";
import { useWorktreeState } from "./state/useWorktreeState";

type Selection = { repoId: string; worktreeId: string };

function syncChip(state: WorktreeState | null): {
  text: string;
  tone: "muted" | "ok" | "warn";
} {
  if (state === null) return { text: "…", tone: "muted" };
  if (state.behind > 0) {
    const ahead = state.ahead > 0 ? ` · ↑${state.ahead}` : "";
    return { text: `↓${state.behind} behind${ahead}`, tone: "warn" };
  }
  if (state.ahead > 0) return { text: `↑${state.ahead} ahead`, tone: "ok" };
  if (!state.hasUpstream) return { text: "no upstream", tone: "muted" };
  return { text: "up to date", tone: "muted" };
}

function WorktreeHeader({
  repo,
  worktree,
  state
}: {
  repo: Repo;
  worktree: Worktree;
  state: WorktreeState | null;
}) {
  const chip = syncChip(state);
  const dirty = state?.dirty ?? worktree.dirty;
  return (
    <div className="wt-header">
      <div className="wt-header__id">
        <span className="wt-header__repo">{repo.name}</span>
        <span className="wt-header__sep">›</span>
        <span className="wt-header__branch">
          <span className="wt-header__dot" />
          {worktree.branch}
        </span>
        {dirty > 0 && <span className="badge badge--warn">●{dirty}</span>}
        <span style={{ flex: 1 }} />
        <span className={`sync-chip sync-chip--${chip.tone}`}>{chip.text}</span>
      </div>
      <div className="wt-header__path">{worktree.path}</div>
    </div>
  );
}

export function App() {
  useAppearance();
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [pendingRepoId, setPendingRepoId] = useState<string | null>(null);

  const { profiles, activeProfile, switchProfile } = useProfiles();
  const { repos, loading, setRepoPin, setWorktreePin, addFolder } = useRepoTree(
    activeProfile?.id ?? null
  );
  const worktreeState = useWorktreeState(selection?.worktreeId ?? null);

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
          onAddFolder={() => void addFolder()}
          onOpenSearch={() => setOverlayOpen(true)}
        />

        <main className="pane pane--main" data-testid="main">
          {selectedRepo !== null && selectedWorktree !== null ? (
            <WorktreeHeader
              repo={selectedRepo}
              worktree={selectedWorktree}
              state={worktreeState}
            />
          ) : (
            <div className="main-empty">
              {loading ? "Scanning repos…" : "Select a worktree from the sidebar"}
            </div>
          )}
          <div className="pane__placeholder">Lineage graph — U8-U10</div>
        </main>

        {!railCollapsed && (
          <aside className="pane pane--rail" data-testid="rail">
            <div className="rail__bar">
              <span className="pane__placeholder" style={{ padding: 0 }}>
                Changes · Agent — U11+
              </span>
              <span style={{ flex: 1 }} />
              <button
                className="icon-btn"
                onClick={() => setRailCollapsed(true)}
                title="Collapse panel"
                aria-label="Collapse panel"
              >
                ›
              </button>
            </div>
          </aside>
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
