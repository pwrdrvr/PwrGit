import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent
} from "react";
import type { Lens, Profile, Repo, Worktree, WorktreeSort } from "@pwrgit/shared";
import { announce, mountLiveRegion, movedMessage } from "../../lib/announce";
import type { ReadState } from "../../state/readState";
import { copyText } from "../../lib/copyText";
import {
  currentPlatform,
  hasPrimaryModifier,
  shortcutLabel
} from "../../lib/platform";
import { useRelativeClock } from "../../lib/useRelativeClock";
import { ContextMenu, type MenuItem } from "../shell/ContextMenu";
import { ReadError } from "../shell/ReadError";
import { revealLabel, revealPath } from "../shell/reveal";
import {
  parseFocusVisits,
  recordFocusVisit,
  type FocusVisits
} from "./focus-visits";
import { LensFilter } from "./LensFilter";
import { NewWorktreeModal } from "./NewWorktreeModal";
import { ProfileChip } from "./ProfileChip";
import { RepoRow } from "./RepoRow";
import {
  filterReposByLens,
  FOCUS_REPO_LIMIT,
  focusedRepoPage,
  focusReasonForRepo,
  groupReposByRoot,
  LENSES,
  lensCounts,
  lensIsArrangeable,
  reorder,
  SORT_CYCLE,
  type SelectionModifiers
} from "./repo-view";
import { useListReorder } from "./useListReorder";

/** Distinguishes repo drags from worktree drags (see useListReorder). */
const REPO_MIME = "application/x-pwrgit-repo";

const EMPTY_IDS: Set<string> = new Set();

/**
 * The lens survives a restart (and an HMR remount) so the app reopens on the
 * view you were actually working in — landing back on Focused every launch means
 * re-picking Pinned by hand each time.
 */
const LENS_KEY = "pwrgit.lens";

function readFocusVisits(key: string): FocusVisits {
  try {
    return parseFocusVisits(window.localStorage.getItem(key));
  } catch {
    return {};
  }
}

function readStoredLens(): Lens {
  try {
    const stored = window.localStorage.getItem(LENS_KEY);
    // Recent was the pre-Focus default. It showed every repo, so retaining that
    // name would preserve neither its old semantics nor a useful preference.
    if (stored === "Recent") return "Focused";
    // Names ship in the store, so a renamed or dropped lens can come back from
    // an older install — fall back rather than filter by a lens that is gone.
    if (stored !== null && (LENSES as string[]).includes(stored)) {
      return stored as Lens;
    }
  } catch {
    // ignore private-mode failures
  }
  return "Focused";
}

/**
 * Per-lens empty copy. The old `No ${lens.toLowerCase()} repos.` template
 * produced "No behind repos.", which isn't English — the lens names are a mix
 * of adjective, verb and noun, so no one template fits all five.
 */
const EMPTY_COPY: Record<Lens, string> = {
  Focused: "No focused repos yet. Browse All, then open or pin what matters.",
  All: "No repos yet — add a folder above and PwrGit will scan it.",
  Pinned: "Nothing pinned yet. Star a repo to keep it here.",
  Behind: "No repo is behind its upstream.",
  Stale: "No worktrees look safe to prune."
};

/** The repo tree, named so the lens switch can point `aria-controls` at it. */
const REPO_TREE_ID = "sidebar-repo-tree";

// Multi-selection is scoped to a single repo's worktrees (a range needs one
// ordering). `anchor` is the pivot for shift-click ranges.
type Selection = { repoId: string; ids: Set<string>; anchor: string | null };
type ContextState = { x: number; y: number; targets: Worktree[] };
type OptionsState = { x: number; y: number };
type NewWorktreeState = {
  repo: Repo;
  initialBranch?: string;
  initialNewBranch?: boolean;
  startPoint?: string;
};

/** Lucide `git-fork`, at the size the sidebar's ghost buttons use. */
function ForkGlyph() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <circle cx="18" cy="6" r="3" />
      <path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9" />
      <path d="M12 12v3" />
    </svg>
  );
}

export function Sidebar({
  profiles,
  activeProfile,
  profileLoadState,
  onRetryProfiles,
  onSwitchProfile,
  repos,
  repoLoadState,
  onRetryRepos,
  selectedWorktreeId,
  onSelectWorktree,
  onSetRepoPin,
  onSetWorktreePin,
  onRemoveWorktree,
  onRemoveWorktrees,
  onCreateWorktree,
  onPersistOrder,
  onPersistRepoOrder,
  refreshingRepoIds,
  onRefreshRepo,
  onRefreshPullRequest,
  onCloneRepo,
  onForkRepo,
  onAddFolder,
  onOpenSearch,
  onExpandRepo,
  onNewProfile,
  onManageProfile,
  platform = currentPlatform()
}: {
  profiles: Profile[];
  activeProfile: Profile | null;
  profileLoadState: ReadState;
  onRetryProfiles: () => void;
  onSwitchProfile: (profileId: string) => void;
  repos: Repo[];
  repoLoadState: ReadState;
  onRetryRepos: () => void;
  selectedWorktreeId: string | null;
  onSelectWorktree: (repo: Repo, worktree: Worktree) => void;
  onSetRepoPin: (repoId: string, pinned: boolean) => void;
  onSetWorktreePin: (worktreeId: string, pinned: boolean) => void;
  onRemoveWorktree: (worktreeId: string) => void;
  onRemoveWorktrees: (worktreeIds: string[]) => void;
  onCreateWorktree: (
    repoId: string,
    branch: string,
    newBranch: boolean,
    startPoint?: string
  ) => Promise<string | null>;
  onPersistOrder: (repoId: string, orderedIds: string[]) => void;
  onPersistRepoOrder: (orderedRepoIds: string[]) => void;
  refreshingRepoIds: Set<string>;
  onRefreshRepo: (repo: Repo) => void;
  onRefreshPullRequest: (repoId: string, branch: string) => void;
  onCloneRepo: () => void;
  onForkRepo: () => void;
  onAddFolder: () => void;
  onOpenSearch: () => void;
  onExpandRepo: (repoId: string) => void;
  onNewProfile: () => void;
  onManageProfile: () => void;
  /** Explicit only in deterministic platform component tests. */
  platform?: string;
}) {
  const now = useRelativeClock();
  // The reorder gestures announce through a shared live region. Put it in the
  // DOM now, while nothing is being said, so the screen reader has registered
  // it long before the first ⌘⇧↑/↓ — see lib/announce.
  useEffect(mountLiveRegion, []);
  const [lens, setLens] = useState<Lens>(readStoredLens);
  const [showAllFocused, setShowAllFocused] = useState(false);
  // Only an explicit pick is worth remembering. The reveal effect below also
  // calls setLens, to widen a lens that would hide the row it is scrolling to
  // — persisting that would let one ⌘K jump into an unpinned repo retire the
  // lens the user actually chose.
  const chooseLens = useCallback((next: Lens) => {
    setLens(next);
    if (next === "Focused") setShowAllFocused(false);
    try {
      window.localStorage.setItem(LENS_KEY, next);
    } catch {
      // ignore private-mode/quota failures
    }
  }, []);
  const focusVisitsKey = `pwrgit.focusVisits.${activeProfile?.id ?? "none"}`;
  const [focusVisitStore, setFocusVisitStore] = useState<{
    key: string;
    visits: FocusVisits;
  }>(() => ({
    key: focusVisitsKey,
    visits: readFocusVisits(focusVisitsKey)
  }));
  useEffect(() => {
    setFocusVisitStore((current) => {
      if (current.key === focusVisitsKey) return current;
      return {
        key: focusVisitsKey,
        visits: readFocusVisits(focusVisitsKey)
      };
    });
  }, [focusVisitsKey]);
  const focusVisits =
    focusVisitStore.key === focusVisitsKey
      ? focusVisitStore.visits
      : readFocusVisits(focusVisitsKey);

  // Selection is the clearest "I work here" signal. Keep it per profile and
  // bounded; repo pins and Git activity remain durable in SQLite as before.
  useEffect(() => {
    if (selectedWorktreeId === null) return;
    if (
      !repos.some((repo) =>
        repo.worktrees.some((worktree) => worktree.id === selectedWorktreeId)
      )
    ) {
      return;
    }
    setFocusVisitStore((current) => {
      const base =
        current.key === focusVisitsKey
          ? current.visits
          : readFocusVisits(focusVisitsKey);
      const visits = recordFocusVisit(base, selectedWorktreeId, Date.now());
      try {
        window.localStorage.setItem(focusVisitsKey, JSON.stringify(visits));
      } catch {
        // Ignore private-mode/quota failures; the in-memory visit still works.
      }
      return { key: focusVisitsKey, visits };
    });
  }, [focusVisitsKey, repos, selectedWorktreeId]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [sortByRepo, setSortByRepo] = useState<Record<string, WorktreeSort>>({});
  const [orderByRepo, setOrderByRepo] = useState<Record<string, string[]>>({});
  const [newWorktree, setNewWorktree] = useState<NewWorktreeState | null>(null);
  const [sel, setSel] = useState<Selection>({
    repoId: "",
    ids: EMPTY_IDS,
    anchor: null
  });
  const [ctx, setCtx] = useState<ContextState | null>(null);
  const [options, setOptions] = useState<OptionsState | null>(null);
  const optionsTriggerRef = useRef<HTMLButtonElement>(null);
  const [groupByFolder, setGroupByFolder] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem("pwrgit.groupByFolder") !== "0";
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(
        "pwrgit.groupByFolder",
        groupByFolder ? "1" : "0"
      );
    } catch {
      // ignore private-mode/quota failures
    }
  }, [groupByFolder]);

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

  // The selected worktree must always be findable in the tree: when selection
  // arrives from outside the sidebar (⌘K/⌘F search pick), expand its repo and
  // scroll the row into view once it has rendered. pendingReveal makes the
  // scroll wait for the expansion render; the ref-guard keeps ordinary repo
  // refreshes from yanking the list back to the selection.
  const pendingRevealRef = useRef<string | null>(null);
  // Seeded with the selection we mount with, not null: a remount (HMR, or a
  // reload that keeps App's selection) is not a fresh pick, and treating it as
  // one would widen the lens below and overwrite the persisted choice.
  const lastRevealedRef = useRef<string | null>(selectedWorktreeId);
  useEffect(() => {
    if (selectedWorktreeId === null) return;
    if (lastRevealedRef.current === selectedWorktreeId) return;
    lastRevealedRef.current = selectedWorktreeId;
    const repo = repos.find((r) =>
      r.worktrees.some((w) => w.id === selectedWorktreeId)
    );
    if (repo === undefined) return;
    pendingRevealRef.current = selectedWorktreeId;
    // A lens the repo doesn't pass would hide the row we're about to scroll to,
    // leaving the selection real but invisible — a ⌘K pick or a freshly created
    // worktree lands nowhere. Widen to Focused, whose first rule is the current
    // selection, rather than dropping the user into the exhaustive index.
    if (
      filterReposByLens([repo], lens, now, {
        selectedWorktreeId,
        visits: focusVisits
      }).length === 0
    ) {
      setLens("Focused");
    }
    if (!expanded.has(repo.id)) {
      setExpanded((prev) => new Set(prev).add(repo.id));
      onExpandRepo(repo.id); // lazy badge/state compute, like a manual expand
    }
  }, [
    selectedWorktreeId,
    repos,
    expanded,
    lens,
    now,
    onExpandRepo,
    focusVisits
  ]);
  useEffect(() => {
    const id = pendingRevealRef.current;
    if (id === null) return;
    const el = document.querySelector(`[data-wt-id="${id}"]`);
    if (el === null) return; // not rendered yet — retry after the next render
    pendingRevealRef.current = null;
    el.scrollIntoView({ block: "nearest" });
  });

  // A plain row click seeds the batch (shift-range) set — but selection can
  // also move WITHOUT a row click (⌘F/⌘K pick, expanding a repo auto-selects
  // its primary). Re-seed the batch to the new selection then, or the old
  // repo's seeded row keeps its tint forever and the sidebar shows two
  // "selected" worktrees at once. ⌘/Shift gestures don't move the app
  // selection, so ranges in progress are never disturbed.
  useEffect(() => {
    if (selectedWorktreeId === null) return;
    setSel((prev) => {
      if (prev.ids.has(selectedWorktreeId)) return prev;
      if (prev.repoId === "" && prev.ids.size === 0) return prev;
      const repo = repos.find((r) =>
        r.worktrees.some((w) => w.id === selectedWorktreeId)
      );
      if (repo === undefined) return prev;
      return {
        repoId: repo.id,
        ids: new Set([selectedWorktreeId]),
        anchor: selectedWorktreeId
      };
    });
  }, [selectedWorktreeId, repos]);

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

  const focusContext = { selectedWorktreeId, visits: focusVisits };
  const counts = lensCounts(repos, now, focusContext);
  const allFiltered = filterReposByLens(repos, lens, now, focusContext);
  const focusedPage = focusedRepoPage(allFiltered, showAllFocused);
  const filtered = lens === "Focused" ? focusedPage.repos : allFiltered;
  const hiddenFocused = lens === "Focused" ? focusedPage.hidden : 0;
  const showFocusNote =
    lens === "Focused" &&
    repos.length > 0 &&
    repoLoadState.status !== "loading";
  const arrangeable = lensIsArrangeable(lens);
  const filteredIds = filtered.map((repo) => repo.id);

  const roots = activeProfile?.roots ?? [];
  const canGroup = roots.length > 1;
  const grouped = groupByFolder && canGroup;
  const groups = grouped ? groupReposByRoot(filtered, roots) : [];

  // Which folder group each repo renders under, so a drag can be kept inside
  // its own group. Dragging across groups would reorder the flat list while the
  // row visibly snaps back under its own heading — the arrangement would be
  // real but invisible.
  const groupOfRepo = new Map<string, string>();
  for (const group of groups) {
    for (const repo of group.repos) groupOfRepo.set(repo.id, group.root);
  }

  const repoDrag = useListReorder({
    mime: REPO_MIME,
    canDrop: (dragId, targetId) =>
      !grouped || groupOfRepo.get(dragId) === groupOfRepo.get(targetId),
    // Commit over the whole filtered list even when grouped: a group is a view
    // of the flat order, so numbering the full list keeps one coherent
    // arrangement instead of per-group indices that collide.
    onCommit: (dragId, targetId, position) => {
      onPersistRepoOrder(reorder(filteredIds, dragId, targetId, position));
    }
  });

  // Roving tabindex across the repo list — one tab stop, arrows to move.
  const [focusedRepoId, setFocusedRepoId] = useState<string | null>(null);
  const repoTabStopId =
    focusedRepoId !== null && filteredIds.includes(focusedRepoId)
      ? focusedRepoId
      : filteredIds[0] ?? null;

  const focusRepoAt = (index: number): void => {
    const id = filteredIds[index];
    if (id === undefined) return;
    setFocusedRepoId(id);
    document.querySelector<HTMLElement>(`[data-repo-id="${id}"]`)?.focus();
  };

  const handleRepoKeyDown = (repo: Repo, event: ReactKeyboardEvent): void => {
    // Keydown from the pin button (or anything else focusable inside the row)
    // bubbles to here. Acting on it swallowed the button: a `<button>` fires
    // its click from the default action of Enter's keydown and Space's keyup,
    // and cancelling the keydown cancels BOTH — so Enter or Space on a focused
    // pin toggled the repo's disclosure and never reached the pin at all
    // (SC 2.1.1). Only the row itself drives row-level keys.
    if (event.target !== event.currentTarget) return;
    const index = filteredIds.indexOf(repo.id);
    if (index === -1) return;
    if (hasPrimaryModifier(event, platform) && event.shiftKey) {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      if (!arrangeable) return;
      const step = event.key === "ArrowUp" ? -1 : 1;
      // Step to the nearest neighbor in the SAME group, so keyboard moves obey
      // the boundary the drag does.
      let to = index + step;
      if (grouped) {
        while (
          filteredIds[to] !== undefined &&
          groupOfRepo.get(filteredIds[to] as string) !== groupOfRepo.get(repo.id)
        ) {
          to += step;
        }
      }
      const neighbor = filteredIds[to];
      if (neighbor === undefined) return;
      event.preventDefault();
      const moved = reorder(
        filteredIds,
        repo.id,
        neighbor,
        event.key === "ArrowUp" ? "before" : "after"
      );
      onPersistRepoOrder(moved);
      // Focus stays on the row that moved, so nothing is re-announced on its
      // own — see lib/announce (SC 4.1.3). Announce against the group the row
      // is actually listed in, which is what its posinset counts within.
      const siblings = grouped
        ? moved.filter(
            (id) => groupOfRepo.get(id) === groupOfRepo.get(repo.id)
          )
        : moved;
      announce(
        movedMessage(repo.name, siblings.indexOf(repo.id) + 1, siblings.length)
      );
      // Keep focus on the row that moved, not the slot it left.
      window.requestAnimationFrame(() => {
        document
          .querySelector<HTMLElement>(`[data-repo-id="${repo.id}"]`)
          ?.focus();
      });
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusRepoAt(Math.min(index + 1, filteredIds.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusRepoAt(Math.max(index - 1, 0));
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggleExpand(repo);
    }
  };

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
    e: SelectionModifiers,
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
      {
        type: "item",
        label: revealLabel(platform),
        onSelect: () => revealPath(w.path)
      },
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
      const current = prev[repoId] ?? "recent";
      const next = current === "custom" ? "recent" : SORT_CYCLE[current];
      return { ...prev, [repoId]: next };
    });
    // Cycling clears a manual drag order.
    setOrderByRepo((prev) => {
      const next = { ...prev };
      delete next[repoId];
      return next;
    });
  };

  // `map` hands us (repo, index, list), which is exactly the posinset/setsize
  // pair each row needs — within its folder group when grouped, within the
  // filtered list when not. See RepoRow for why they are stated explicitly.
  const renderRepo = (repo: Repo, index: number, list: Repo[]) => {
    const focusReason =
      lens === "Focused"
        ? focusReasonForRepo(repo, focusContext, now)
        : null;
    return (
      <RepoRow
        key={repo.id}
        posinset={index + 1}
        setsize={list.length}
        repo={repo}
        expanded={expanded.has(repo.id)}
        containsSelection={repo.worktrees.some(
          (w) => w.id === selectedWorktreeId
        )}
        selectedWorktreeId={selectedWorktreeId}
        selectedIds={sel.repoId === repo.id ? sel.ids : EMPTY_IDS}
        sort={sortByRepo[repo.id] ?? "recent"}
        customOrder={orderByRepo[repo.id]}
        now={now}
        focused={lens === "Focused"}
        focusVisits={focusVisits}
        {...(focusReason === null ? {} : { focusReason })}
        onToggleExpand={() => toggleExpand(repo)}
        onToggleRepoPin={() => onSetRepoPin(repo.id, !repo.pinned)}
        refreshing={refreshingRepoIds.has(repo.id)}
        onRefreshWorktrees={() => onRefreshRepo(repo)}
        onRefreshPullRequest={(branch) =>
          onRefreshPullRequest(repo.id, branch)
        }
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
        onNewWorktree={() => setNewWorktree({ repo })}
        onRevealWorktree={(worktreeId) => {
          const worktree = repo.worktrees.find(
            (candidate) => candidate.id === worktreeId
          );
          if (worktree === undefined) return;
          clearSel();
          onSelectWorktree(repo, worktree);
        }}
        onCreateWorktreeFromRef={(branch, newBranch, startPoint) =>
          setNewWorktree({
            repo,
            initialBranch: branch,
            initialNewBranch: newBranch,
            ...(startPoint === undefined ? {} : { startPoint })
          })
        }
        arrangeable={arrangeable}
        dragProps={repoDrag.rowProps(repo.id, arrangeable)}
        dragging={repoDrag.dragId === repo.id}
        dropPosition={
          repoDrag.target?.id === repo.id ? repoDrag.target.position : null
        }
        focusable={repoTabStopId === repo.id}
        onRowKeyDown={(event) => handleRepoKeyDown(repo, event)}
        onRowFocus={() => setFocusedRepoId(repo.id)}
        isPostDragClick={repoDrag.isPostDragClick}
        platform={platform}
      />
    );
  };

  return (
    <aside className="pane pane--sidebar" data-testid="sidebar">
      <div className="sidebar__profile">
        {profileLoadState.status === "error" ? (
          <ReadError
            compact
            title="Profiles couldn’t be loaded"
            message={profileLoadState.message}
            onRetry={onRetryProfiles}
          />
        ) : profileLoadState.status === "loading" ? (
          <p className="sidebar__read-status" role="status">
            Loading profiles…
          </p>
        ) : activeProfile === null ? (
          <div className="sidebar__profile-empty">
            <span>No profiles yet.</span>
            <button type="button" onClick={onNewProfile}>
              Create profile
            </button>
          </div>
        ) : (
          <ProfileChip
            profiles={profiles}
            activeProfile={activeProfile}
            onSwitch={onSwitchProfile}
            onNewProfile={onNewProfile}
            onManageProfile={onManageProfile}
          />
        )}
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
          {/* Find is advertised; the K chord stays as a silent alias. */}
          <span
            className="kbd"
            title={`${shortcutLabel({ key: "F" }, platform)} or ${shortcutLabel(
              { key: "K" },
              platform
            )}`}
          >
            {shortcutLabel({ key: "F" }, platform)}
          </span>
        </button>
        {/* Add folders is the prerequisite for everything else — Clone is
            disabled until a root exists — so it sits beside Clone rather than
            at the bottom of the list, where it was the quietest control on a
            first-run sidebar whose only working action it was. */}
        <div className="sidebar__actions">
          <button
            className="add-folder"
            onClick={onAddFolder}
            disabled={activeProfile === null}
            title={
              activeProfile === null
                ? "Load or create a profile before adding folders"
                : undefined
            }
          >
            <span className="new-wt__plus">+</span> Add folders…
          </button>
          {/* Clone and fork share their own row beneath Add folders. Three
              labels do not fit one row at the 240px width floor — the sizing
              note above was tuned for two — and both of these bring a
              repository in, so they read as peers. */}
          <div className="clone-repo-row">
            <button
              className="clone-repo"
              onClick={onCloneRepo}
              disabled={
                activeProfile === null || activeProfile.roots.length === 0
              }
              title={
                activeProfile !== null && activeProfile.roots.length === 0
                  ? "Add a repo folder before cloning"
                  : "Clone a repository from GitHub or GitLab"
              }
            >
              <span className="new-wt__plus">↓</span> Clone…
            </button>
            <button
              className="fork-repo"
              onClick={onForkRepo}
              disabled={
                activeProfile === null || activeProfile.roots.length === 0
              }
              title={
                activeProfile !== null && activeProfile.roots.length === 0
                  ? "Add a repo folder before forking"
                  : "Fork a repository, then check out your copy"
              }
            >
              <ForkGlyph /> Fork…
            </button>
          </div>
          {activeProfile !== null && activeProfile.roots.length === 0 && (
            <span className="sidebar__actions-hint">
              Add a repo folder to enable clone and fork.
            </span>
          )}
        </div>
      </div>

      <div className="sidebar__lens">
        <LensFilter
          lens={lens}
          counts={counts}
          onChange={chooseLens}
          controlsId={REPO_TREE_ID}
        />
        {canGroup && (
          <button
            ref={optionsTriggerRef}
            type="button"
            className="sidebar-options"
            aria-label="Sidebar display options"
            aria-haspopup="menu"
            aria-expanded={options !== null}
            title="Sidebar display options"
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              setOptions((current) =>
                current === null
                  ? {
                      x: Math.max(8, rect.right - 190),
                      y: rect.bottom + 4
                    }
                  : null
              );
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="12" cy="5" r="2" />
              <circle cx="12" cy="12" r="2" />
              <circle cx="12" cy="19" r="2" />
            </svg>
          </button>
        )}
      </div>

      {showFocusNote && (
        <div className="sidebar__focus-note" aria-live="polite">
          <span className="sidebar__focus-rules">
            Current · pinned · viewed · changed · 30-day commits
          </span>
          <div className="sidebar__focus-actions">
            <span className="sidebar__focus-count">
              {hiddenFocused > 0
                ? `Showing ${filtered.length} of ${allFiltered.length}`
                : `${allFiltered.length} focused`}
            </span>
            {hiddenFocused > 0 && (
              <button type="button" onClick={() => setShowAllFocused(true)}>
                Show all {allFiltered.length} focused
              </button>
            )}
            {showAllFocused && allFiltered.length > FOCUS_REPO_LIMIT && (
              <button type="button" onClick={() => setShowAllFocused(false)}>
                Show fewer
              </button>
            )}
            <button type="button" onClick={() => chooseLens("All")}>
              Browse all {repos.length}
            </button>
          </div>
        </div>
      )}

      {/* The scrollport and the tree are two different things. `role="tree"`
          used to sit on .sidebar__list, which also holds the empty state — and
          a `tree` may only own `treeitem` and `group` children, so anything
          else parked among the rows makes the whole structure invalid
          (SC 1.3.1; axe's aria-required-children). It used to hold the "Add
          folders…" button too, which was the loudest version of the problem;
          that button now lives up in .sidebar__actions, but the empty state
          still needs to sit outside the tree. The wrapper below owns only rows
          and folder groups. It is a plain static block, so it changes no layout
          and the rows still stick to .sidebar__list's scrollport. */}
      <div className="sidebar__list">
        {repoLoadState.status === "error" && (
          <ReadError
            compact
            title="Repositories couldn’t be loaded"
            message={repoLoadState.message}
            onRetry={onRetryRepos}
          />
        )}
        <div
          className="sidebar__tree"
          id={REPO_TREE_ID}
          role="tree"
          aria-label="Repositories"
        >
          {grouped
            ? groups.map((g) => (
                // A `tree` may own `group`s of treeitems, so the folder buckets
                // are groups rather than bare divs — otherwise the repo rows
                // are treeitems with no owning structure. The visual heading is
                // then decorative, but its count has to survive into the
                // group's name or screen-reader users simply lose it.
                <div
                  className="repo-group"
                  key={g.root || "__other"}
                  role="group"
                  aria-label={`${g.label} (${g.repos.length} ${
                    g.repos.length === 1 ? "repo" : "repos"
                  })`}
                >
                  <div
                    className="repo-group__head"
                    title={g.root || "Not under any added folder"}
                    aria-hidden="true"
                  >
                    <span className="repo-group__label">{g.label}</span>
                    <span className="repo-group__count">{g.repos.length}</span>
                  </div>
                  {g.repos.map(renderRepo)}
                </div>
              ))
            : filtered.map(renderRepo)}
        </div>

        {filtered.length === 0 && (
          <div className="sidebar__empty">
            {repoLoadState.status === "loading"
              ? "Scanning…"
              : repoLoadState.status === "error"
                ? "The last repository list is still shown above, if one was available."
                : EMPTY_COPY[lens]}
          </div>
        )}
      </div>

      {newWorktree !== null && (
        <NewWorktreeModal
          repo={newWorktree.repo}
          {...(newWorktree.initialBranch === undefined
            ? {}
            : { initialBranch: newWorktree.initialBranch })}
          {...(newWorktree.initialNewBranch === undefined
            ? {}
            : { initialNewBranch: newWorktree.initialNewBranch })}
          {...(newWorktree.startPoint === undefined
            ? {}
            : { startPoint: newWorktree.startPoint })}
          onCreate={(branch, newBranch, startPoint) =>
            onCreateWorktree(newWorktree.repo.id, branch, newBranch, startPoint)
          }
          onClose={() => setNewWorktree(null)}
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

      {options !== null && (
        <ContextMenu
          x={options.x}
          y={options.y}
          label="Sidebar display options"
          triggerRef={optionsTriggerRef}
          items={[
            {
              type: "item",
              label: `${groupByFolder ? "✓ " : ""}Group by folder`,
              onSelect: () => setGroupByFolder((value) => !value)
            }
          ]}
          onClose={() => setOptions(null)}
        />
      )}
    </aside>
  );
}
