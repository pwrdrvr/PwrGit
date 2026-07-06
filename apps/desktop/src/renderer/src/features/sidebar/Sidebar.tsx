import { useEffect, useState } from "react";
import type { Lens, Profile, Repo, Worktree, WorktreeSort } from "@pwrgit/shared";
import { LensFilter } from "./LensFilter";
import { NewWorktreeModal } from "./NewWorktreeModal";
import { ProfileChip } from "./ProfileChip";
import { RepoRow } from "./RepoRow";
import { filterReposByLens, lensCounts, SORT_CYCLE } from "./repo-view";

export function Sidebar({
  profiles,
  activeProfile,
  onSwitchProfile,
  repos,
  loading,
  selectedWorktreeId,
  onSelectWorktree,
  onSetRepoPin,
  onSetWorktreePin,
  onRemoveWorktree,
  onCreateWorktree,
  onPersistOrder,
  onAddFolder,
  onOpenSearch,
  onExpandRepo
}: {
  profiles: Profile[];
  activeProfile: Profile | null;
  onSwitchProfile: (profileId: string) => void;
  repos: Repo[];
  loading: boolean;
  selectedWorktreeId: string | null;
  onSelectWorktree: (repo: Repo, worktree: Worktree) => void;
  onSetRepoPin: (repoId: string, pinned: boolean) => void;
  onSetWorktreePin: (worktreeId: string, pinned: boolean) => void;
  onRemoveWorktree: (worktreeId: string) => void;
  onCreateWorktree: (
    repoId: string,
    branch: string,
    newBranch: boolean
  ) => Promise<string | null>;
  onPersistOrder: (repoId: string, orderedIds: string[]) => void;
  onAddFolder: () => void;
  onOpenSearch: () => void;
  onExpandRepo: (repoId: string) => void;
}) {
  const [lens, setLens] = useState<Lens>("Recent");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [sortByRepo, setSortByRepo] = useState<Record<string, WorktreeSort>>({});
  const [orderByRepo, setOrderByRepo] = useState<Record<string, string[]>>({});
  const [newWorktreeRepo, setNewWorktreeRepo] = useState<Repo | null>(null);

  // Seed the drag order from persisted custom_order for repos not yet
  // reordered this session.
  useEffect(() => {
    setOrderByRepo((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const repo of repos) {
        if (repo.id in next) continue;
        if (repo.worktrees.some((w) => w.order !== undefined)) {
          next[repo.id] = repo.worktrees
            .slice()
            .sort(
              (a, b) =>
                (a.order ?? Number.MAX_SAFE_INTEGER) -
                (b.order ?? Number.MAX_SAFE_INTEGER)
            )
            .map((w) => w.id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [repos]);

  const counts = lensCounts(repos);
  const filtered = filterReposByLens(repos, lens);

  const toggleExpand = (repo: Repo): void => {
    const willExpand = !expanded.has(repo.id);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(repo.id)) next.delete(repo.id);
      else next.add(repo.id);
      return next;
    });
    // Compute this repo's worktree badges lazily on first look — state isn't
    // computed for every repo up front.
    if (willExpand) onExpandRepo(repo.id);
    const hasSelection = repo.worktrees.some((w) => w.id === selectedWorktreeId);
    if (!hasSelection && repo.worktrees.length > 0) {
      const primary =
        repo.worktrees.find((w) => w.isPrimary) ?? repo.worktrees[0];
      if (primary !== undefined) onSelectWorktree(repo, primary);
    }
  };

  const cycleSort = (repoId: string): void => {
    setSortByRepo((prev) => {
      const current = prev[repoId] ?? "pinned";
      const next = current === "custom" ? "pinned" : SORT_CYCLE[current];
      return { ...prev, [repoId]: next };
    });
    // Cycling clears a manual drag order.
    setOrderByRepo((prev) => {
      const next = { ...prev };
      delete next[repoId];
      return next;
    });
  };

  return (
    <aside className="pane pane--sidebar" data-testid="sidebar">
      <div className="sidebar__profile">
        <ProfileChip
          profiles={profiles}
          activeProfile={activeProfile}
          onSwitch={onSwitchProfile}
        />
      </div>

      <div className="sidebar__search">
        <button className="jump-btn" onClick={onOpenSearch}>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <span className="jump-btn__label">Jump to repo…</span>
          <span className="kbd">⌘K</span>
        </button>
      </div>

      <div className="sidebar__lens">
        <LensFilter lens={lens} counts={counts} onChange={setLens} />
      </div>

      <div className="sidebar__list">
        {filtered.map((repo) => (
          <RepoRow
            key={repo.id}
            repo={repo}
            expanded={expanded.has(repo.id)}
            containsSelection={repo.worktrees.some(
              (w) => w.id === selectedWorktreeId
            )}
            selectedWorktreeId={selectedWorktreeId}
            sort={sortByRepo[repo.id] ?? "pinned"}
            customOrder={orderByRepo[repo.id]}
            onToggleExpand={() => toggleExpand(repo)}
            onToggleRepoPin={() => onSetRepoPin(repo.id, !repo.pinned)}
            onSelectWorktree={(w) => onSelectWorktree(repo, w)}
            onToggleWorktreePin={onSetWorktreePin}
            onRemoveWorktree={onRemoveWorktree}
            onCycleSort={() => cycleSort(repo.id)}
            onReorder={(ids) => {
              setOrderByRepo((prev) => ({ ...prev, [repo.id]: ids }));
              onPersistOrder(repo.id, ids);
            }}
            onNewWorktree={() => setNewWorktreeRepo(repo)}
          />
        ))}

        {filtered.length === 0 && (
          <div className="sidebar__empty">
            {loading
              ? "Scanning…"
              : lens === "All" || lens === "Recent"
                ? "No repos yet — add a folder to scan."
                : `No ${lens.toLowerCase()} repos.`}
          </div>
        )}

        <button className="add-folder" onClick={onAddFolder}>
          <span className="new-wt__plus">+</span> Add repo folder…
        </button>
      </div>

      {newWorktreeRepo !== null && (
        <NewWorktreeModal
          repo={newWorktreeRepo}
          onCreate={(branch, newBranch) =>
            onCreateWorktree(newWorktreeRepo.id, branch, newBranch)
          }
          onClose={() => setNewWorktreeRepo(null)}
        />
      )}
    </aside>
  );
}
