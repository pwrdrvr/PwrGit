import { useEffect, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { Lens, Profile, Repo, Worktree, WorktreeSort } from "@pwrgit/shared";
import { copyText } from "../../lib/copyText";
import { ContextMenu, type MenuItem } from "../shell/ContextMenu";
import { revealLabel, revealPath } from "../shell/reveal";
import { LensFilter } from "./LensFilter";
import { NewWorktreeModal } from "./NewWorktreeModal";
import { ProfileChip } from "./ProfileChip";
import { RepoRow } from "./RepoRow";
import { filterReposByLens, lensCounts, SORT_CYCLE } from "./repo-view";

const EMPTY_IDS: Set<string> = new Set();

// Multi-selection is scoped to a single repo's worktrees (a range needs one
// ordering). `anchor` is the pivot for shift-click ranges.
type Selection = { repoId: string; ids: Set<string>; anchor: string | null };
type ContextState = { x: number; y: number; targets: Worktree[] };

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
  onRemoveWorktrees,
  onCreateWorktree,
  onPersistOrder,
  onAddFolder,
  onOpenSearch,
  onExpandRepo,
  onNewProfile,
  onManageProfile
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
  onRemoveWorktrees: (worktreeIds: string[]) => void;
  onCreateWorktree: (
    repoId: string,
    branch: string,
    newBranch: boolean
  ) => Promise<string | null>;
  onPersistOrder: (repoId: string, orderedIds: string[]) => void;
  onAddFolder: () => void;
  onOpenSearch: () => void;
  onExpandRepo: (repoId: string) => void;
  onNewProfile: () => void;
  onManageProfile: () => void;
}) {
  const [lens, setLens] = useState<Lens>("Recent");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [sortByRepo, setSortByRepo] = useState<Record<string, WorktreeSort>>({});
  const [orderByRepo, setOrderByRepo] = useState<Record<string, string[]>>({});
  const [newWorktreeRepo, setNewWorktreeRepo] = useState<Repo | null>(null);
  const [sel, setSel] = useState<Selection>({
    repoId: "",
    ids: EMPTY_IDS,
    anchor: null
  });
  const [ctx, setCtx] = useState<ContextState | null>(null);

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

  // Drop selected ids that no longer exist (e.g. after a batch remove reloads).
  useEffect(() => {
    setSel((prev) => {
      if (prev.ids.size === 0 && prev.anchor === null) return prev;
      const repo = repos.find((r) => r.id === prev.repoId);
      if (repo === undefined) return { repoId: "", ids: EMPTY_IDS, anchor: null };
      const present = new Set(repo.worktrees.map((w) => w.id));
      const ids = new Set([...prev.ids].filter((id) => present.has(id)));
      const anchor =
        prev.anchor !== null && present.has(prev.anchor) ? prev.anchor : null;
      if (ids.size === prev.ids.size && anchor === prev.anchor) return prev;
      return { repoId: prev.repoId, ids, anchor };
    });
  }, [repos]);

  const clearSel = (): void =>
    setSel({ repoId: "", ids: EMPTY_IDS, anchor: null });

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

  // Plain click selects one (and drives the main pane). ⌘/Ctrl-click toggles a
  // row in the batch set; Shift-click extends a range from the anchor. Both
  // modifier gestures build the selection without changing the viewed worktree.
  const handleRowClick = (
    repo: Repo,
    w: Worktree,
    e: ReactMouseEvent,
    orderedIds: string[]
  ): void => {
    if (e.shiftKey && sel.repoId === repo.id && sel.anchor !== null) {
      const a = orderedIds.indexOf(sel.anchor);
      const b = orderedIds.indexOf(w.id);
      if (a !== -1 && b !== -1) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        setSel({
          repoId: repo.id,
          ids: new Set(orderedIds.slice(lo, hi + 1)),
          anchor: sel.anchor
        });
        return;
      }
    }
    if (e.metaKey || e.ctrlKey) {
      setSel((prev) => {
        const base =
          prev.repoId === repo.id ? new Set(prev.ids) : new Set<string>();
        if (base.has(w.id)) base.delete(w.id);
        else base.add(w.id);
        return { repoId: repo.id, ids: base, anchor: w.id };
      });
      return;
    }
    // A plain click IS the first member of the selection — so a following
    // ⌘/Shift-click extends from it (2 selected), rather than leaving the
    // viewed row in a separate state from the batch.
    setSel({ repoId: repo.id, ids: new Set([w.id]), anchor: w.id });
    onSelectWorktree(repo, w);
  };

  const handleRowContext = (
    repo: Repo,
    w: Worktree,
    e: ReactMouseEvent,
    orderedIds: string[]
  ): void => {
    e.preventDefault();
    e.stopPropagation();
    const inSelection =
      sel.repoId === repo.id && sel.ids.has(w.id) && sel.ids.size > 1;
    let targets: Worktree[];
    if (inSelection) {
      const byId = new Map(repo.worktrees.map((x) => [x.id, x]));
      targets = orderedIds
        .filter((id) => sel.ids.has(id))
        .map((id) => byId.get(id))
        .filter((x): x is Worktree => x !== undefined);
    } else {
      // Right-clicking outside the selection acts on just that row.
      targets = [w];
      setSel({ repoId: repo.id, ids: EMPTY_IDS, anchor: w.id });
    }
    setCtx({ x: e.clientX, y: e.clientY, targets });
  };

  const contextItems = (targets: Worktree[]): MenuItem[] => {
    if (targets.length > 1) {
      const ids = targets.map((t) => t.id);
      return [
        {
          type: "item",
          label: `Remove ${targets.length} worktrees…`,
          danger: true,
          onSelect: () => onRemoveWorktrees(ids)
        },
        { type: "sep" },
        {
          type: "item",
          label: `Copy ${targets.length} paths`,
          onSelect: () => void copyText(targets.map((t) => t.path).join("\n"))
        },
        { type: "item", label: "Clear selection", onSelect: clearSel }
      ];
    }
    const w = targets[0];
    if (w === undefined) return [];
    return [
      {
        type: "item",
        label: "Copy branch name",
        onSelect: () => void copyText(w.branch)
      },
      { type: "item", label: "Copy path", onSelect: () => void copyText(w.path) },
      { type: "item", label: revealLabel, onSelect: () => revealPath(w.path) },
      { type: "sep" },
      {
        type: "item",
        label: "Remove worktree",
        danger: true,
        disabled: w.isPrimary,
        onSelect: () => onRemoveWorktree(w.id)
      }
    ];
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
          onNewProfile={onNewProfile}
          onManageProfile={onManageProfile}
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
            selectedIds={sel.repoId === repo.id ? sel.ids : EMPTY_IDS}
            sort={sortByRepo[repo.id] ?? "pinned"}
            customOrder={orderByRepo[repo.id]}
            onToggleExpand={() => toggleExpand(repo)}
            onToggleRepoPin={() => onSetRepoPin(repo.id, !repo.pinned)}
            onSelectWorktree={(w, e, orderedIds) =>
              handleRowClick(repo, w, e, orderedIds)
            }
            onContextWorktree={(w, e, orderedIds) =>
              handleRowContext(repo, w, e, orderedIds)
            }
            onToggleWorktreePin={onSetWorktreePin}
            onRemoveWorktree={onRemoveWorktree}
            onRemoveSelected={() => onRemoveWorktrees(Array.from(sel.ids))}
            onClearSelected={clearSel}
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
          <span className="new-wt__plus">+</span> Add folders…
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

      {ctx !== null && (
        <ContextMenu
          x={ctx.x}
          y={ctx.y}
          items={contextItems(ctx.targets)}
          onClose={() => setCtx(null)}
        />
      )}
    </aside>
  );
}
