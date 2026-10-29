import { dispatch } from "../../lib/pwrgit";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent
} from "react";
import type {
  CloneRepository,
  TagSummary,
  Lens,
  OpenChangeRequest,
  Profile,
  Repo,
  Worktree,
  WorktreeSort
} from "@pwrgit/shared";
import { announce, mountLiveRegion, movedMessage } from "../../lib/announce";
import type { ReadState } from "../../state/readState";
import type {
  RemoveWorktreesOptions,
  RemoveWorktreesOutcome
} from "../../state/useRepoTree";
import { copyText } from "../../lib/copyText";
import {
  currentPlatform,
  hasPrimaryModifier
} from "../../lib/platform";
import { PlusGlyph } from "../../lib/PlusGlyph";
import {
  hoverTooltip,
  useViewportTooltip
} from "../../lib/useViewportTooltip";
import { useRelativeClock } from "../../lib/useRelativeClock";
import { ContextMenu, type MenuItem } from "../shell/ContextMenu";
import { ReadError } from "../shell/ReadError";
import { revealLabel, revealPath } from "../shell/reveal";
import {
  parseFocusVisits,
  recordFocusVisit,
  type FocusVisits
} from "./focus-visits";
import { forkSeedFromOrigin, forkSeedFromRepo } from "./fork-dialog";
import { useForgeNaming } from "../../state/useForgeNaming";
import { LensFilter } from "./LensFilter";
import { NewWorktreeModal } from "./NewWorktreeModal";
import { ProfileChip } from "./ProfileChip";
import { RepoRow } from "./RepoRow";
import { SidebarToolbar } from "./SidebarToolbar";
import { settleSidebarReveal, useSidebarReveal } from "./sidebar-reveal";
import {
  applySidebarAnchor,
  keepSidebarAnchorForSelection,
  releaseSidebarAnchor,
  sidebarAnchorHeld,
  trackSidebarAnchors
} from "./sidebar-anchor";
import { RepoIndex, stickyLineOf, type RepoIndexGroup } from "./RepoIndex";
import {
  jumpScrollPlan,
  readRepoIndexEnabled,
  repoIndexFit,
  repoIndexMenuHint,
  spacerIsOffscreen,
  writeRepoIndexEnabled,
  type RepoIndexFit
} from "./repo-index";
import { BulkSyncDialog } from "./BulkSyncDialog";
import { FIRST_RUN_MINIMIZE_MS } from "./bulk-sync-prefs";
import { useBulkSyncRun } from "./useBulkSyncRun";
import { MaintenanceDialog } from "./MaintenanceDialog";
import { HiddenReposButton } from "./HiddenReposButton";
import { RemoveRepositoryDialog } from "./RemoveRepositoryDialog";
import { hiddenToast } from "./remove-repo-view";
import { showErrorToast, showInfoToast } from "../../lib/toast";
import { unhideRepo } from "../../state/useHiddenRepos";
import {
  DEFAULT_LENS,
  filterReposByLens,
  FOCUS_REPO_LIMIT,
  focusedRepoPage,
  focusedRepos,
  focusReasonForRepo,
  groupReposByRoot,
  LENS_EMPTY_COPY,
  LENSES,
  lensCounts,
  lensIsArrangeable,
  reorder,
  SORT_CYCLE,
  type SelectionModifiers
} from "./repo-view";
import { AiFeaturesSwitch } from "./AiFeaturesSwitch";
import { useHoverStableOrder } from "./useHoverStableOrder";
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

/** The remembered lens, or null when the user has never picked one — which is
 *  a different thing from having picked the default, and is what decides where
 *  a first run lands (see the landing effect below). */
function readStoredLens(): Lens | null {
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
  return null;
}

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
  /** The open PR whose head this is, when it came from the PR section. */
  changeRequest?: OpenChangeRequest;
};

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
  onLocateTag,
  onSelectWorktree,
  onSetRepoPin,
  onSetWorktreePin,
  onSetBranchPin,
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
  onForkCheckout,
  onOpenRepoSetup,
  onAddFolder,
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
  onLocateTag?: ((repoId: string, tag: TagSummary) => void) | undefined;
  onSelectWorktree: (repo: Repo, worktree: Worktree) => void;
  onSetRepoPin: (repoId: string, pinned: boolean) => void;
  onSetWorktreePin: (worktreeId: string, pinned: boolean) => void;
  onSetBranchPin: (repoId: string, branch: string, pinned: boolean) => void;
  onRemoveWorktree: (worktreeId: string) => void;
  onRemoveWorktrees: (
    worktreeIds: string[],
    options?: RemoveWorktreesOptions
  ) => Promise<RemoveWorktreesOutcome>;
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
  /** Open the fork-and-clone dialog. Carries the repository the sidebar had
   *  selected, so the dialog opens on it rather than on an empty search box —
   *  null when nothing is selected, or when neither its identity nor its
   *  `origin` names a forge. `checkout` is the row the seed was read from, so
   *  the dialog can offer to fork that checkout in place instead of cloning a
   *  second copy; null whenever `seed` is. */
  onForkRepo: (seed: CloneRepository | null, checkout: Repo | null) => void;
  /** Fork the repository a row is about and re-point that checkout at the
   *  fork. Distinct from `onForkRepo`, which starts from a search and ends in
   *  a new clone: this one starts from a repo already on disk. */
  onForkCheckout: (repo: Repo) => void;
  onOpenRepoSetup?: (repo: Repo) => void;
  onAddFolder: () => void;
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
  /** One card for the sidebar's own chrome — the search hint, the action
   *  buttons, the options kebab and the folder-group heads. The rows below
   *  own theirs, since each is its own component. */
  const tip = useViewportTooltip();
  const [storedLens] = useState(readStoredLens);
  const [lens, setLens] = useState<Lens>(storedLens ?? DEFAULT_LENS);
  const [showAllFocused, setShowAllFocused] = useState(false);
  // Whether this window's landing lens is settled. A remembered pick settles it
  // outright; otherwise the effect below decides once the first repo list is in.
  const landedRef = useRef(storedLens !== null);
  // Only an explicit pick is worth remembering. The reveal effect below also
  // calls setLens, to widen a lens that would hide the row it is scrolling to
  // — persisting that would let one ⌘K jump into an unpinned repo retire the
  // lens the user actually chose.
  const chooseLens = useCallback((next: Lens) => {
    landedRef.current = true;
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

  const recordedSelection = useRef<string | null>(null);

  // Selection is the clearest "I work here" signal. Keep it per profile and
  // bounded; repo pins and Git activity remain durable in SQLite as before.
  useEffect(() => {
    if (selectedWorktreeId === null) { recordedSelection.current = null; return; }
    if (
      !repos.some((repo) =>
        repo.worktrees.some((worktree) => worktree.id === selectedWorktreeId)
      )
    ) {
      return;
    }
    const selectionKey = `${focusVisitsKey}:${selectedWorktreeId}`;
    if (recordedSelection.current === selectionKey) return;
    recordedSelection.current = selectionKey;
    if (activeProfile) void dispatch("navigation:record", {
      profileId: activeProfile.id, selectedWorktreeId, visits: readFocusVisits(focusVisitsKey)
    });
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
  /** The maintenance dialog, and — when the refs browser opened it — the one
   *  repository it reviews, or the Prune worktrees tab it opens on. Prune
   *  has no repository scope; it reviews the whole profile. */
  const [maintenance, setMaintenance] = useState<
    | { repo?: { id: string; name: string }; worktrees?: true }
    | null
  >(null);
  /** The repository the Remove review is open on. */
  const [removing, setRemoving] = useState<Repo | null>(null);
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
  const [repoIndexEnabled, setRepoIndexEnabled] = useState(readRepoIndexEnabled);

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
  /**
   * Make a repo's row findable: widen a lens that hides it, and expand it.
   * Shared by the selection reveal below and a toast chip's reveal further
   * down, so the two cannot drift on what "show this repo" does.
   *
   * A lens the repo doesn't pass would hide the row about to be scrolled to,
   * leaving it real but invisible — a ⌘K pick or a freshly created worktree
   * lands nowhere. Widen to Focused, whose first rule is the current
   * selection, rather than dropping the user into the exhaustive index.
   */
  const showRepoRow = (repo: Repo): void => {
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
  };
  useEffect(() => {
    if (selectedWorktreeId === null) return;
    if (lastRevealedRef.current === selectedWorktreeId) return;
    lastRevealedRef.current = selectedWorktreeId;
    const repo = repos.find((r) =>
      r.worktrees.some((w) => w.id === selectedWorktreeId)
    );
    if (repo === undefined) return;
    pendingRevealRef.current = selectedWorktreeId;
    showRepoRow(repo);
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
    // A row held by the anchor (the one the jump was made from, or the one
    // Back is returning to) owns the scroll. Revealing the selection too
    // would move that row out from under the pointer.
    if (sidebarAnchorHeld()) {
      pendingRevealRef.current = null;
      return;
    }
    const el = document.querySelector(`[data-wt-id="${id}"]`);
    if (el === null) return; // not rendered yet — retry after the next render
    pendingRevealRef.current = null;
    el.scrollIntoView({ block: "nearest" });
  });

  // Keep the reader's place across a selection change: see sidebar-anchor.ts.
  // Both run before paint, in this order, after every render — a ghost row
  // or a re-ranked Working block inserted above the held row is compensated
  // in the same frame it appears.
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const list = listRef.current;
    return list === null ? undefined : trackSidebarAnchors(list);
  }, []);
  useLayoutEffect(() => {
    if (selectedWorktreeId !== null) keepSidebarAnchorForSelection();
  }, [selectedWorktreeId]);
  useLayoutEffect(() => {
    applySidebarAnchor(listRef.current);
  });

  // ---- Repository index (RepoIndex.tsx, repo-index.ts) ----
  // A jump puts a repository's block at the top of the readable area and
  // opens it. A repository near the end cannot get there on its own, so the
  // list grows a blank tail of exactly the missing height; the tail is dropped
  // once it scrolls out of view, which moves nothing on screen.
  const spacerRef = useRef<HTMLDivElement>(null);
  const pendingJumpRef = useRef<string | null>(null);
  const scrollRepoToTop = (repoId: string): void => {
    const list = listRef.current;
    const spacer = spacerRef.current;
    if (list === null || spacer === null) return;
    const place = (): number | null => {
      const row =
        [...list.querySelectorAll<HTMLElement>(".repo-row[data-repo-id]")].find(
          (el) => el.dataset["repoId"] === repoId
        ) ?? null;
      if (row === null) return null;
      // The block, not the sticky header: a stuck header reports where it is
      // stuck, not where its repository starts.
      const block = row.closest<HTMLElement>(".repo-block") ?? row;
      const group = block.closest(".repo-group");
      const plan = jumpScrollPlan({
        scrollTop: list.scrollTop,
        blockTop:
          block.getBoundingClientRect().top - list.getBoundingClientRect().top,
        line: group === null ? 0 : stickyLineOf(group as HTMLElement),
        scrollHeight: list.scrollHeight,
        clientHeight: list.clientHeight,
        spacerHeight: spacer.offsetHeight
      });
      if (plan.spacerHeight !== spacer.offsetHeight) {
        spacer.style.height = `${plan.spacerHeight}px`;
      }
      list.scrollTop = plan.scrollTop;
      return list.scrollTop;
    };
    const landed = place();
    if (landed === null) return;
    // One more look a frame later — a font or a lazily drawn section above can
    // still settle — unless the reader has scrolled since.
    window.requestAnimationFrame(() => {
      if (list.scrollTop === landed) place();
    });
  };
  const jumpToRepo = (repoId: string): void => {
    const repo = filtered.find((r) => r.id === repoId);
    if (repo === undefined) return;
    releaseSidebarAnchor();
    // Tab from the index lands on the repository just jumped to.
    setFocusedRepoId(repoId);
    // A name in the index selects the way its tree row does: the selection
    // moves to the repository's primary worktree unless it is already in
    // that repository. A jump that only scrolled left the old repository
    // drawn selected beside the one just picked, which read as two
    // selections at once. The jump owns the scroll, so the selection's own
    // reveal stands down: it would pull a primary row drawn below the fold
    // into view and move the repository off the top.
    const selected = selectPrimaryUnlessHeld(repo);
    if (selected !== null) lastRevealedRef.current = selected;
    if (expanded.has(repoId)) {
      scrollRepoToTop(repoId);
      return;
    }
    // The scroll waits for the opened block to render.
    pendingJumpRef.current = repoId;
    setExpanded((prev) => new Set(prev).add(repoId));
    onExpandRepo(repoId);
  };
  useLayoutEffect(() => {
    const id = pendingJumpRef.current;
    if (id === null) return;
    pendingJumpRef.current = null;
    scrollRepoToTop(id);
  });
  useEffect(() => {
    const list = listRef.current;
    if (list === null) return undefined;
    const onScroll = (): void => {
      const spacer = spacerRef.current;
      if (spacer === null || spacer.offsetHeight === 0) return;
      if (
        spacerIsOffscreen(
          spacer.getBoundingClientRect().top,
          list.getBoundingClientRect().bottom
        )
      ) {
        spacer.style.height = "";
      }
    };
    list.addEventListener("scroll", onScroll, { passive: true });
    return () => list.removeEventListener("scroll", onScroll);
  }, []);

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
  // Fetch recent fetches the Focused list, every page of it; the lens count
  // reads the same list rather than walking the ladder again.
  const recentRepos = useMemo(
    () =>
      focusedRepos(repos, { selectedWorktreeId, visits: focusVisits }, now),
    [focusVisits, now, repos, selectedWorktreeId]
  );
  const counts = lensCounts(repos, now, focusContext, recentRepos);
  const bulk = useBulkSyncRun({
    profileId: activeProfile?.id ?? null,
    repos,
    recentRepos
  });
  // Where a window with no remembered lens lands, decided once — the first
  // time repos actually arrive, because until then every count is 0 and
  // "empty" and "not read yet" look identical.
  //
  // A fresh profile starts in DEFAULT_LENS (All): its worktree state is
  // computed lazily per repo, so Focused/Behind/Stale are empty by
  // construction and a new user who added their folders landed in a blank
  // list with four blank lenses behind it. A returning user whose persisted
  // state already fills Focused still opens there, which is the lens this
  // sidebar is designed around.
  //
  // The trigger is a non-empty list, NOT a settled read state. `repoLoadState`
  // reports "ready" before this window has a profile at all — useRepoTree
  // resolves a null profile id to an empty list — and that ready arrives
  // first, so gating on it settled the landing against an empty tree every
  // time and no one was ever promoted. Waiting on a profile instead does not
  // fix it either: child effects run before the parent's, so this would still
  // read the stale "ready" in the commit that delivers the profile. A repo in
  // hand is unambiguous. A profile that genuinely holds none simply never
  // settles, which costs nothing — All is where it already is.
  useEffect(() => {
    if (landedRef.current) return;
    if (repos.length === 0) return;
    landedRef.current = true;
    if (counts.Focused > 0) setLens("Focused");
  }, [repos.length, counts.Focused]);
  const lensRepos = filterReposByLens(repos, lens, now, focusContext);
  // Selecting a worktree makes its repo `current` — rank 0 of the Focus ladder
  // — so without this the row the user just clicked would leave from under the
  // cursor. The lens keeps answering the question; the answer is only *shown*
  // once the pointer is off the list. The held focus context travels down to
  // RepoRow so an expanded repo's Working section can't re-partition while the
  // list around it is being held still either.
  const held = useHoverStableOrder({
    scope: `${activeProfile?.id ?? "none"}:${lens}`,
    ids: lensRepos.map((repo) => repo.id),
    context: focusContext
  });
  // Only pay for the remap when the held order actually differs from the one
  // just computed — the pointer is off the sidebar for most of the app's life,
  // and there `held.ids` IS `lensRepos`'s order.
  const allFiltered = held.holding
    ? (() => {
        const byId = new Map(lensRepos.map((repo) => [repo.id, repo]));
        return held.ids.flatMap((id) => {
          const repo = byId.get(id);
          return repo === undefined ? [] : [repo];
        });
      })()
    : lensRepos;
  const focusedPage = focusedRepoPage(allFiltered, showAllFocused);
  const filtered = lens === "Focused" ? focusedPage.repos : allFiltered;
  const hiddenFocused = lens === "Focused" ? focusedPage.hidden : 0;
  const showFocusNote =
    lens === "Focused" &&
    repos.length > 0 &&
    repoLoadState.status !== "loading";
  const arrangeable = lensIsArrangeable(lens);
  /** What "Fork…" should open on: the repository holding the current
   *  selection. Computed here rather than in App because the sidebar is what
   *  owns the notion of a selected row. */
  const selectedRepo = useMemo(
    () =>
      repos.find((repo) =>
        repo.worktrees.some((worktree) => worktree.id === selectedWorktreeId)
      ),
    [repos, selectedWorktreeId]
  );
  const forgeNaming = useForgeNaming();
  /** One open at a time: the origin fallback awaits a `git remote -v`, and a
   *  double click inside that window would otherwise open the dialog twice. */
  const openingFork = useRef(false);
  /**
   * Seed from the identity when there is one, and from `origin` when there is
   * not.
   *
   * Identity-only was the bug: a repository added since the window mounted
   * has no identity until something asks the forge, so pressing Fork… with it
   * selected opened on an empty search — while `origin` named the repository
   * the whole time. The identity refresh fired alongside is what makes the
   * sidebar's own marks catch up; the dialog does not wait on it, because its
   * preflight asks the same forge the same question the moment it opens.
   */
  const openFork = async (): Promise<void> => {
    if (openingFork.current) return;
    const repo = selectedRepo;
    if (repo === undefined) {
      onForkRepo(null, null);
      return;
    }
    const known = forkSeedFromRepo(repo);
    if (known !== null) {
      onForkRepo(known, repo);
      return;
    }
    openingFork.current = true;
    try {
      void dispatch("repo:refreshIdentities", {
        profileId: repo.profileId,
        repoIds: [repo.id]
      });
      const remotes = await dispatch("repo:remotes", { repoId: repo.id });
      const seed = remotes.ok
        ? forkSeedFromOrigin(remotes.value, forgeNaming.overrides)
        : null;
      onForkRepo(seed, seed === null ? null : repo);
    } finally {
      openingFork.current = false;
    }
  };
  const filteredIds = filtered.map((repo) => repo.id);

  // Whether the index fits: the sidebar's width past the tree's floor, against
  // the measured width of the index's shortest useful truncation (the probe,
  // which carries the index's own font and min-width). Only the shown/hidden
  // answer is React state; the width cap is written straight to a custom
  // property, so dragging the sidebar's edge re-renders nothing.
  const asideRef = useRef<HTMLElement>(null);
  const indexProbeRef = useRef<HTMLSpanElement>(null);
  const fitInputs = useRef({ enabled: repoIndexEnabled, repoCount: filtered.length });
  fitInputs.current = { enabled: repoIndexEnabled, repoCount: filtered.length };
  const [indexFit, setIndexFit] = useState<RepoIndexFit>({
    shown: false,
    reason: "narrow"
  });
  const measureIndexFit = useCallback((): void => {
    const aside = asideRef.current;
    const probe = indexProbeRef.current;
    if (aside === null || probe === null) return;
    const fit = repoIndexFit({
      ...fitInputs.current,
      sidebarWidth: aside.getBoundingClientRect().width,
      minWidth: probe.getBoundingClientRect().width
    });
    if (fit.shown) aside.style.setProperty("--repo-index-max", `${fit.maxWidth}px`);
    // Only shown/hidden and the reason matter here; maxWidth is the CSS var.
    const key = (f: RepoIndexFit): string => (f.shown ? "shown" : f.reason);
    setIndexFit((prev) => (key(prev) === key(fit) ? prev : fit));
  }, []);
  useLayoutEffect(measureIndexFit, [
    measureIndexFit,
    repoIndexEnabled,
    filtered.length
  ]);
  useEffect(() => {
    const aside = asideRef.current;
    const probe = indexProbeRef.current;
    if (aside === null || probe === null || typeof ResizeObserver !== "function") {
      return undefined;
    }
    // The probe resizes with the text-size axis, the aside with its edge.
    const observer = new ResizeObserver(measureIndexFit);
    observer.observe(aside);
    observer.observe(probe);
    return () => observer.disconnect();
  }, [measureIndexFit]);

  const roots = activeProfile?.roots ?? [];
  const canGroup = roots.length > 1;
  const grouped = groupByFolder && canGroup;
  const groups = grouped ? groupReposByRoot(filtered, roots) : [];
  // Built only while the column is drawn: it scans every worktree.
  const indexSource = grouped
    ? groups.map((g) => ({ key: g.root || "__other", label: g.label, repos: g.repos }))
    : [{ key: "__all", label: null, repos: filtered }];
  const indexGroups: RepoIndexGroup[] = !indexFit.shown
    ? []
    : indexSource.map(({ key, label, repos: groupRepos }) => ({
        key,
        label,
        entries: groupRepos.map((repo) => ({
          id: repo.id,
          name: repo.name,
          containsSelection: repo.worktrees.some((w) => w.id === selectedWorktreeId)
        }))
      }));

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
      // A drag leaves the ids untouched and only moves them, so the held order
      // would silently undo the drop the user just made.
      held.release();
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

  // A reveal asked from outside the sidebar — a toast's repo or remote chip,
  // or the graph's "You are here" for a worktree row (`sidebar-reveal.ts`). App has already moved the selection if it needed
  // to; this is the half a selection cannot do when it does not change:
  // expand the row, and bring it into view. Once per request, so a repo the
  // user collapses while a remote reveal waits on `repo:refs` stays collapsed.
  const reveal = useSidebarReveal();
  const handledRevealSeq = useRef<number | null>(null);
  const pendingRepoScrollRef = useRef<{
    repoId: string;
    worktreeId: string | null;
    seq: number;
  } | null>(null);
  useEffect(() => {
    if (reveal === null || handledRevealSeq.current === reveal.seq) return;
    handledRevealSeq.current = reveal.seq;
    const repo = repos.find((r) => r.id === reveal.repoId);
    if (repo === undefined) {
      settleSidebarReveal(reveal.seq);
      return;
    }
    showRepoRow(repo);
    // A remote is scrolled to by the refs sections inside the row, which are
    // the only ones that know when its row exists.
    if (reveal.remote === null) {
      pendingRepoScrollRef.current = {
        repoId: repo.id,
        worktreeId: reveal.worktreeId,
        seq: reveal.seq
      };
    }
  }, [
    reveal,
    repos,
    expanded,
    lens,
    now,
    onExpandRepo,
    focusVisits,
    selectedWorktreeId
  ]);
  useEffect(() => {
    const pending = pendingRepoScrollRef.current;
    if (pending === null) return;
    // Expired or replaced: the row that never rendered in time must not take
    // the scroll and focus whenever it finally does.
    if (reveal?.seq !== pending.seq) {
      pendingRepoScrollRef.current = null;
      return;
    }
    const el = document.querySelector<HTMLElement>(
      pending.worktreeId !== null
        ? `[data-wt-id="${pending.worktreeId}"]`
        : `[data-repo-id="${pending.repoId}"]`
    );
    if (el === null) return; // not rendered yet — retry after the next render
    pendingRepoScrollRef.current = null;
    if (pending.worktreeId !== null) {
      // Centered, as the graph centers HEAD: the row should land where the
      // eye goes, not pinned to whichever edge it scrolled in from.
      el.scrollIntoView({ block: "center" });
      settleSidebarReveal(pending.seq);
      return;
    }
    el.scrollIntoView({ block: "nearest" });
    // Focus follows the jump, as it does for a link: the chip that was
    // pressed lives on a card that is about to time out, and focus left on it
    // would fall to <body> when it goes.
    setFocusedRepoId(pending.repoId);
    el.focus({ preventScroll: true });
    settleSidebarReveal(pending.seq);
  });

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
      // Same reason as the drag's onCommit: the move is the user's, so it is
      // shown even if the pointer happens to be parked on the list.
      held.release();
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
    selectPrimaryUnlessHeld(repo);
  };

  /** A repo row click, or a name in the index: select the repository's
   *  primary worktree, unless the selection is already one of its own. */
  function selectPrimaryUnlessHeld(repo: Repo): string | null {
    const hasSelection = repo.worktrees.some((w) => w.id === selectedWorktreeId);
    if (hasSelection) return null;
    const primary =
      repo.worktrees.find((w) => w.isPrimary) ?? repo.worktrees[0];
    if (primary === undefined) return null;
    onSelectWorktree(repo, primary);
    return primary.id;
  }

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
          onSelect: () => void onRemoveWorktrees(ids)
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
  /** Move the selection off a repository that is about to leave the list, to
   *  the one after it as drawn (or before it, at the end). Without this the
   *  window falls back to the first repository, a jump across the list. */
  const selectNeighbourOf = (repo: Repo): void => {
    if (!repo.worktrees.some((w) => w.id === selectedWorktreeId)) return;
    const list = filtered.some((r) => r.id === repo.id) ? filtered : repos;
    const at = list.findIndex((r) => r.id === repo.id);
    const next = list[at + 1] ?? list[at - 1];
    const worktree = next?.worktrees.find((w) => w.isPrimary) ?? next?.worktrees[0];
    if (next !== undefined && worktree !== undefined) onSelectWorktree(next, worktree);
  };

  /** Hide asks nothing: it loses nothing, and Undo is on the toast. */
  const hideRepo = (repo: Repo): void => {
    // Moved before the round trip, or the refresh lands first and the window
    // falls back to the first repository; a failed hide moves it back.
    const selected = repo.worktrees.find((w) => w.id === selectedWorktreeId);
    selectNeighbourOf(repo);
    const profileId = repo.profileId;
    void dispatch("repo:hide", { profileId, repoId: repo.id }).then((result) => {
      if (!result.ok) {
        if (selected !== undefined) onSelectWorktree(repo, selected);
        showErrorToast({ title: `Could not hide ${repo.name}`, message: result.error.message });
        return;
      }
      showInfoToast({
        ...hiddenToast(repo),
        action: {
          label: "Undo",
          run: () =>
            void unhideRepo({ profileId, path: repo.path }).then((failure) => {
              if (failure !== null) {
                showErrorToast({ title: `Could not unhide ${repo.name}`, message: failure });
              }
            })
        }
      });
    });
  };

  const renderRepo = (repo: Repo, index: number, list: Repo[]) => {
    // Live, not held — unlike the row's position. The selected tint below
    // (`containsSelection`) follows the selection immediately and cannot
    // sensibly do otherwise, so a held reason would put two disagreeing signals
    // on one row: an accent-tinted row still labelled "Recent". Live on both,
    // the row reads "this is the current one, where it already was", and the
    // stale part stays the invisible one. The badge is a fixed-height pill at
    // the end of a flex row, so a word change reflows nothing but itself.
    const focusReason =
      lens === "Focused"
        ? focusReasonForRepo(repo, focusContext, now)
        : null;
    return (
      <RepoRow
        onLocateTag={onLocateTag}
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
        focusContext={held.context}
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
        onToggleBranchPin={(branch, pinned) =>
          onSetBranchPin(repo.id, branch, pinned)
        }
        onRemoveWorktree={onRemoveWorktree}
        onRemoveSelected={() => void onRemoveWorktrees(Array.from(sel.ids))}
        onClearSelected={clearSel}
        onCycleSort={() => cycleSort(repo.id)}
        onReorder={(ids) => {
          setOrderByRepo((prev) => ({ ...prev, [repo.id]: ids }));
          onPersistOrder(repo.id, ids);
        }}
        onNewWorktree={() => setNewWorktree({ repo })}
        onForkRepo={() => onForkCheckout(repo)}
        onOpenSetup={() => onOpenRepoSetup?.(repo)}
        onCleanUpBranches={() =>
          setMaintenance({ repo: { id: repo.id, name: repo.name } })
        }
        onPruneWorktrees={() => setMaintenance({ worktrees: true })}
        onHideRepo={() => hideRepo(repo)}
        onRemoveRepo={() => setRemoving(repo)}
        onRevealWorktree={(worktreeId) => {
          const worktree = repo.worktrees.find(
            (candidate) => candidate.id === worktreeId
          );
          if (worktree === undefined) return;
          clearSel();
          onSelectWorktree(repo, worktree);
        }}
        onCreateWorktreeFromRef={(branch, newBranch, startPoint, changeRequest) =>
          setNewWorktree({
            repo,
            initialBranch: branch,
            initialNewBranch: newBranch,
            ...(startPoint === undefined ? {} : { startPoint }),
            ...(changeRequest === undefined ? {} : { changeRequest })
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
    <aside ref={asideRef} className="pane pane--sidebar" data-testid="sidebar">
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
            onOpenGitIdentity={() => {
              void dispatch("settings:open", { page: "profiles", sub: "git-folders" }).catch(
                () => undefined
              );
            }}
          />
        )}
      </div>

      {/* One row of profile-wide actions. The jump field that used to lead
          this block lives in the title strip now (TitleBar's .titlebar-jump);
          Add folders, Clone and Fork sit behind Add ▾, and on a profile with
          no folder yet the empty list carries Add folders itself. Design:
          design/Sidebar Header Toolbar - UX Review.dc.html, 2b and 3. */}
      <SidebarToolbar
        hasProfile={activeProfile !== null}
        rootCount={activeProfile?.roots.length ?? 0}
        repoCount={repos.length}
        onAddFolder={onAddFolder}
        onClone={onCloneRepo}
        onFork={() => void openFork()}
        recentCount={recentRepos.length}
        syncVerb={bulk.verb}
        syncScope={bulk.scope}
        fetchInterval={bulk.interval}
        syncBusy={bulk.busy}
        lastAutoRun={bulk.lastAutoRun}
        onSync={bulk.runFace}
        onPickSync={bulk.pick}
        onPickFetchInterval={bulk.pickInterval}
        onMaintenance={() => setMaintenance({})}
      />

      <div className="sidebar__lens">
        <LensFilter
          lens={lens}
          counts={counts}
          onChange={chooseLens}
          controlsId={REPO_TREE_ID}
        />
        {/* Always drawn: Repo index lives here even with one folder. */}
        <button
          ref={optionsTriggerRef}
          type="button"
          className="sidebar-options"
          aria-label="Sidebar display options"
          aria-haspopup="menu"
          aria-expanded={options !== null}
          {...hoverTooltip(tip, "Sidebar display options")}
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
          and the rows still stick to .sidebar__list's scrollport.

          The repository index sits beside the scrollport, not in it, so it
          stays put while the tree scrolls; it is a separate nav, never part of
          the tree. The hover hold spans both, so the index cannot re-sort
          under a pointer crossing from one to the other. .sidebar__tree-pane
          is the tree's own size container: its narrow-width rules follow the
          tree's width, which the index takes from. */}
      <span ref={indexProbeRef} className="repo-index__probe" aria-hidden="true" />
      <div className="sidebar__body" {...held.containerProps}>
        {indexFit.shown && (
          <RepoIndex
            groups={indexGroups}
            listRef={listRef}
            treeId={REPO_TREE_ID}
            onJump={jumpToRepo}
          />
        )}
        <div className="sidebar__tree-pane">
          <div className="sidebar__list" ref={listRef}>
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
                        {...hoverTooltip(tip, g.root || "Not under any added folder")}
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
                <p className="sidebar__empty-text">
                  {repoLoadState.status === "loading"
                    ? "Scanning…"
                    : repoLoadState.status === "error"
                      ? "The last repository list is still shown above, if one was available."
                      : LENS_EMPTY_COPY[lens]}
                </p>
                {/* Day one. Add folders is the prerequisite for everything else
                    and, with no folder yet, the only action that works — so while
                    the profile has none, the empty list carries it rather than
                    leaving it inside Add ▾. Disabled, with its reason in the name
                    and the card, while no profile has loaded. */}
                {(activeProfile === null || activeProfile.roots.length === 0) && (
                  <div className="sidebar__start">
                    <button
                      type="button"
                      className="sidebar__start-add"
                      onClick={onAddFolder}
                      disabled={activeProfile === null}
                      /* The visible label is repeated verbatim, ellipsis and all:
                         an aria-label replaces the button's contents, so dropping
                         a character would break SC 2.5.3 and voice control. */
                      aria-label={
                        activeProfile === null
                          ? "Add folders… — unavailable, load or create a profile first"
                          : undefined
                      }
                      {...hoverTooltip(
                        tip,
                        activeProfile === null
                          ? "Load or create a profile before adding folders"
                          : undefined
                      )}
                    >
                      <PlusGlyph /> Add folders…
                    </button>
                    {activeProfile !== null && (
                      <span className="sidebar__start-hint">
                        Clone and Fork, under Add, open once a folder exists.
                      </span>
                    )}
                  </div>
                )}
              </div>
            )}
            <div ref={spacerRef} className="sidebar__jump-room" aria-hidden="true" />
          </div>
        </div>
      </div>

      {/* The profile's AI switch, under the list rather than in it: the tree
          owns only rows, and this is a setting for the whole window. Off
          until turned on — see AiFeaturesSwitch. */}
      {activeProfile !== null && (
        <HiddenReposButton profile={activeProfile} />
      )}
      {activeProfile !== null && <AiFeaturesSwitch profile={activeProfile} />}

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
          {...(newWorktree.changeRequest === undefined
            ? {}
            : { changeRequest: newWorktree.changeRequest })}
          onCreate={(branch, newBranch, startPoint) =>
            onCreateWorktree(newWorktree.repo.id, branch, newBranch, startPoint)
          }
          onClose={() => setNewWorktree(null)}
        />
      )}

      {bulk.run !== null && activeProfile !== null && (
        <BulkSyncDialog
          key={bulk.run.key}
          profileId={activeProfile.id}
          repos={bulk.run.repos}
          {...(bulk.run.repoIds === undefined
            ? {}
            : { repoIds: bulk.run.repoIds })}
          scope={bulk.run.scope}
          mode={bulk.run.mode}
          platform={platform}
          view={bulk.run.view}
          autoMinimizeMs={
            bulk.run.autoMinimize ? FIRST_RUN_MINIMIZE_MS : null
          }
          onViewChange={bulk.setView}
          onFinished={bulk.finish}
          onClose={bulk.close}
        />
      )}
      {maintenance !== null && activeProfile !== null && (
        <MaintenanceDialog
          profileId={activeProfile.id}
          platform={platform}
          onClose={() => setMaintenance(null)}
          onRemoveWorktrees={(ids, options) =>
            // The dialog renders the outcome inline, so no second notice.
            onRemoveWorktrees(ids, {
              confirmed: true,
              reportFailures: false,
              ...(options?.force === true ? { force: true } : {})
            })
          }
          {...(maintenance.worktrees === true
            ? { initialTab: "worktrees" as const }
            : maintenance.repo === undefined
            ? {}
            : {
                repoScope: maintenance.repo,
                initialTab: "branches" as const,
                autoReview: true
              })}
        />
      )}

      {removing !== null && (
        <RemoveRepositoryDialog
          repo={removing}
          platform={platform}
          onClose={() => setRemoving(null)}
          onRemoved={() => selectNeighbourOf(removing)}
          onOpenWorktree={(worktreeId) => {
            const worktree = removing.worktrees.find((w) => w.id === worktreeId);
            if (worktree !== undefined) onSelectWorktree(removing, worktree);
          }}
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
            ...(canGroup
              ? [
                  {
                    type: "item" as const,
                    label: "Group by folder",
                    checked: groupByFolder,
                    onSelect: () => setGroupByFolder((value) => !value)
                  }
                ]
              : []),
            {
              type: "item",
              label: "Repo index",
              checked: repoIndexEnabled,
              ...(repoIndexEnabled && repoIndexMenuHint(indexFit) !== undefined
                ? { hint: repoIndexMenuHint(indexFit) as string }
                : {}),
              onSelect: () =>
                setRepoIndexEnabled((value) => {
                  writeRepoIndexEnabled(!value);
                  return !value;
                })
            }
          ]}
          onClose={() => setOptions(null)}
        />
      )}
      {tip.tooltipNode}
    </aside>
  );
}
