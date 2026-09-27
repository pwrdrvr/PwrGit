import { LocateGlyph } from "../../lib/LocateGlyph";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { flushSync } from "react-dom";
import {
  commitAuthorPersonKey,
  type Commit,
  type CommitAuthorPerson,
  type CommitStats,
  type LaneGraph,
  type PrSummary
} from "@pwrgit/shared";
import { announce } from "../../lib/announce";
import { prefersReducedMotion } from "../../lib/reducedMotion";
import { useDismissable } from "../../lib/useDismissable";
import { useMenuNavigation } from "../../lib/useMenuNavigation";
import { useHoverIntent } from "../../lib/hoverIntent";
import { dispatch, subscribe } from "../../lib/pwrgit";
import { showErrorToast, showInfoToast } from "../../lib/toast";
import { useRelativeClock } from "../../lib/useRelativeClock";
import {
  type TooltipAnchor,
  hoverTooltip,
  useViewportTooltip
} from "../../lib/useViewportTooltip";
import { BranchChipMenu, type BranchChipTarget } from "./BranchChipMenu";
import { BranchFromCommitDialog } from "./BranchFromCommitDialog";
import { CreateTagDialog } from "../sidebar/CreateTagDialog";
import type { CommitSwitchTarget } from "./commit-context-menu";
import { switchFailureMessage } from "./commit-context-menu";
import { guardedSwitchBranch } from "../shell/branchSwitch";
import { lastSegment } from "../sidebar/repo-view";
import { CommitContextCard } from "./CommitContextCard";
import { CommitContextMenu } from "./CommitContextMenu";
import { PersonCard, type PersonGraphStats } from "./PersonCard";
import {
  GraphRow,
  type GraphRowVM,
  gutterWidth,
  LANE_W,
  laneColor,
  MAX_GUTTER_LANES
} from "./GraphRow";
import { shortWhen } from "./graph-view";
import { layoutLanes } from "./lane-layout";
import { findPrLandingLinks, layoutPrLandingLinks } from "./pr-landings";

type Scope = "active" | "all";
const VISIBLE_COMMIT_PR_IDLE_MS = 500;

export function consumeBranchPrInvalidation(
  scope: Scope,
  generation: number,
  consumedGeneration: number
): { force: boolean; consumedGeneration: number } {
  const force = scope === "active" && generation !== consumedGeneration;
  return {
    force,
    consumedGeneration: force ? generation : consumedGeneration
  };
}

/** Most commits of one author main is told about; see `people:replaceInterest`. */
const MAX_INTEREST_COMMITS_PER_AUTHOR = 3;

/**
 * The authors a loaded graph shows, for `people:replaceInterest`: most recent
 * author first, each with their newest commits first. Main decides whether and
 * when to ask a forge about any of them; this only says who is on screen.
 */
export function authorInterest(
  commits: readonly Commit[]
): Array<{ name: string; email: string; commitHashes: string[] }> {
  const byKey = new Map<string, { name: string; email: string; commitHashes: string[] }>();
  for (const commit of newestFirst(commits)) {
    const key = commitAuthorPersonKey(commit.authorEmail);
    if (key === "") continue;
    const author = byKey.get(key);
    if (author === undefined) {
      byKey.set(key, {
        name: commit.authorName,
        email: commit.authorEmail,
        commitHashes: [commit.hash]
      });
    } else if (author.commitHashes.length < MAX_INTEREST_COMMITS_PER_AUTHOR) {
      author.commitHashes.push(commit.hash);
    }
  }
  return [...byKey.values()];
}

/** Each author's footprint in the loaded graph, keyed by person key. */
export function personGraphStats(
  commits: readonly Commit[],
  tips: Readonly<Record<string, readonly string[]>>
): Map<string, PersonGraphStats> {
  const stats = new Map<string, PersonGraphStats>();
  for (const commit of newestFirst(commits)) {
    const key = commitAuthorPersonKey(commit.authorEmail);
    const current = stats.get(key);
    if (current === undefined) {
      stats.set(key, {
        count: 1,
        total: commits.length,
        latest: commit,
        tips: [...(tips[commit.hash] ?? [])]
      });
    } else {
      current.count += 1;
      current.tips.push(...(tips[commit.hash] ?? []));
    }
  }
  return stats;
}

/** Loaded order is topological; an author's "latest" is by commit time. */
function newestFirst(commits: readonly Commit[]): Commit[] {
  const time = (commit: Commit): number => {
    const parsed = Date.parse(commit.committedAt);
    return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
  };
  return commits
    .map((commit, index) => ({ commit, index, at: time(commit) }))
    .sort((a, b) => b.at - a.at || a.index - b.index)
    .map(({ commit }) => commit);
}

// A proven person resolves to an opaque local thumbnail. Graph load waits for
// decode before rows become interactive and retains the decoded image for the
// graph session. Keeping the element alive matters for custom protocols:
// Chromium may otherwise discard its decoded surface before a card creates
// its own image element, causing one initials frame.
const MAX_RETAINED_COMMIT_AUTHOR_AVATARS = 256;
const warmedCommitAuthorAvatars = new Map<string, HTMLImageElement>();
const warmingCommitAuthorAvatarUrls = new Map<string, Promise<void>>();
function warmCommitAuthorAvatar(avatarUrl: string | undefined): Promise<void> {
  if (
    avatarUrl === undefined ||
    !avatarUrl.startsWith("pwrgit-avatar://thumbnail/") ||
    warmedCommitAuthorAvatars.has(avatarUrl) ||
    typeof Image === "undefined"
  ) {
    return Promise.resolve();
  }

  const existing = warmingCommitAuthorAvatarUrls.get(avatarUrl);
  if (existing !== undefined) return existing;

  const image = new Image();
  image.decoding = "sync";
  image.src = avatarUrl;
  const completion = image.decode()
    .then(() => {
      if (warmedCommitAuthorAvatars.size >= MAX_RETAINED_COMMIT_AUTHOR_AVATARS) {
        const oldest = warmedCommitAuthorAvatars.keys().next().value;
        if (oldest !== undefined) warmedCommitAuthorAvatars.delete(oldest);
      }
      warmedCommitAuthorAvatars.set(avatarUrl, image);
    })
    .catch(() => {
      // A missing/damaged local file still leaves the proven login usable.
    })
    .finally(() => {
      warmingCommitAuthorAvatarUrls.delete(avatarUrl);
    });
  warmingCommitAuthorAvatarUrls.set(avatarUrl, completion);
  return completion;
}

async function warmPeopleAvatars(
  people: Record<string, CommitAuthorPerson>
): Promise<void> {
  await Promise.all(
    Object.values(people).map((person) => warmCommitAuthorAvatar(person.identity?.avatarUrl))
  );
}

/** Only a proven identity is ever shown; the rest are initials. */
function provenIdentity(person: CommitAuthorPerson | undefined) {
  return person?.state === "proven" ? person.identity : undefined;
}

type CommitMenuState = { hash: string; x: number; y: number };

// Experimental setting: open new graph views in the "all branches" scope.
// Cached per window but kept fresh via settings:changed, so toggling the
// setting applies to the next opened view without a reload. The in-graph
// toggle still overrides per view.
let defaultScopePromise: Promise<Scope> | null = null;
let defaultScopeSubscribed = false;
function defaultLineageScope(): Promise<Scope> {
  if (!defaultScopeSubscribed) {
    defaultScopeSubscribed = true;
    subscribe("settings:changed", (snapshot) => {
      defaultScopePromise = Promise.resolve(
        snapshot.experimental.lineageAllBranches ? "all" : "active"
      );
    });
  }
  defaultScopePromise ??= dispatch("settings:read", undefined).then((r) =>
    r.ok && r.value.experimental.lineageAllBranches ? "all" : "active"
  );
  return defaultScopePromise;
}

const scrollBehavior = (): ScrollBehavior =>
  prefersReducedMotion() ? "auto" : "smooth";

export function LineageGraph({
  repoId,
  repoName,
  worktreeId,
  worktreePath,
  viewingBranch,
  activeEmail,
  selectedCommits,
  focusedCommit,
  revealCommit,
  onToggleCommit,
  onCommitsChange,
  onOpenCommit,
  onRevealWorktree,
  onRevealCreatedWorktree
}: {
  repoId: string;
  /** Repository name, shown when a dialog needs to name what it acts on. */
  repoName: string;
  worktreeId: string;
  /** That worktree's path — a switch confirm names the checkout it would move
   *  by its folder, since the destination branch already names the branch. */
  worktreePath: string;
  /** Branch checked out in the worktree whose lineage is being viewed. */
  viewingBranch: string;
  activeEmail: string;
  selectedCommits: Set<string>;
  /** Commit whose files are open in the rail — highlighted even off-branch. */
  focusedCommit: string | null;
  /** An explicit request to center and flash a commit. */
  revealCommit: { hash: string; requestId: number; tagName?: string; tagKind?: "annotated" | "lightweight" } | null;
  onToggleCommit: (hash: string) => void;
  /** Publishes the currently loaded timeline for command-palette search. */
  onCommitsChange: (commits: Commit[]) => void;
  onOpenCommit: (hash: string, subject: string) => void;
  /** Jump to a worktree from a tip chip's worktree button. */
  onRevealWorktree: (worktreeId: string) => void;
  /** Select a worktree just created here, once the repo tree lists it. */
  onRevealCreatedWorktree: (worktreeId: string) => void;
}) {
  const [data, setData] = useState<LaneGraph | null>(null);
  const [scope, setScope] = useState<Scope>("active");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [branchPrGeneration, setBranchPrGeneration] = useState(0);
  const [flash, setFlash] = useState<string | null>(null);
  const [branchesOpen, setBranchesOpen] = useState(false);
  const branchesBtnRef = useRef<HTMLButtonElement>(null);
  const branchesPopRef = useRef<HTMLDivElement>(null);
  const closeBranches = useCallback(() => setBranchesOpen(false), []);
  const [hoveredCommit, setHoveredCommit] = useState<string | null>(null);
  const [commitMenu, setCommitMenu] = useState<CommitMenuState | null>(null);
  const [branchMenu, setBranchMenu] = useState<BranchChipTarget | null>(null);
  // The commit itself, not its hash: the dialog outlives graph reloads (its own
  // branch:create emits worktree:changed before it returns), and a reload whose
  // window no longer covers that commit would otherwise unmount the dialog
  // mid-submit — dropping the success toast, the reveal, and anything typed.
  const [branchFromCommit, setBranchFromCommit] = useState<Commit | null>(null);
  const [tagFromCommit, setTagFromCommit] = useState<Commit | null>(null);

  // ⌘F reaches past the dialog's backdrop, so the selected worktree can change
  // under an open dialog. Its commit, dirty check and branch list all belong to
  // the worktree it was opened from — close it rather than let it act on
  // another one.
  useEffect(() => {
    setBranchFromCommit(null);
    setTagFromCommit(null);
  }, [worktreeId]);
  const [commitStats, setCommitStats] = useState<
    Record<string, CommitStats | null>
  >({});
  const [commitPullRequests, setCommitPullRequests] = useState<
    Record<string, PrSummary | null>
  >({});
  /** Commit authors by person key, as main's people store knows them. */
  const [people, setPeople] = useState<Record<string, CommitAuthorPerson>>({});
  /** The byline whose person card is open: which author, from which row. */
  const [openPerson, setOpenPerson] = useState<{
    key: string;
    hash: string;
    name: string;
  } | null>(null);
  const now = useRelativeClock();
  const commitContext = useViewportTooltip("commit-context-card", {
    interactive: true
  });
  const personCard = useViewportTooltip("person-card", {
    interactive: true,
    label: openPerson === null ? "Author" : `Author: ${openPerson.name}`
  });
  /** The graph chrome's own card — the branch menu, the locate button, the
   *  scope toggle, the lane scrollbar. Separate from `commitContext` above,
   *  which is an interactive card with its own class and dwell rules. */
  const tip = useViewportTooltip();
  // One gate for every row: only one trigger is hovered at a time, and this
  // keeps hundreds of rows from each mounting their own listener bookkeeping.
  const hoverIntent = useHoverIntent();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const laneBarRef = useRef<HTMLDivElement>(null);
  const scopeTouchedRef = useRef(false);
  const commitStatsRequestsRef = useRef(new Map<string, number>());
  const commitStatsEpochRef = useRef(0);
  const commitPrMonitorIdRef = useRef(crypto.randomUUID());
  const peopleMonitorIdRef = useRef(crypto.randomUUID());
  const consumedBranchPrGenerationRef = useRef(0);

  const acceptCommitPullRequests = useCallback(
    (prs: Record<string, PrSummary | null>): void => {
      if (Object.keys(prs).length === 0) return;
      setCommitPullRequests((current) => ({ ...current, ...prs }));
    },
    []
  );

  const acceptPeople = useCallback(
    (incoming: Record<string, CommitAuthorPerson>): void => {
      if (Object.keys(incoming).length === 0) return;
      setPeople((current) => ({ ...current, ...incoming }));
    },
    []
  );

  useEffect(() => {
    let active = true;
    void defaultLineageScope().then((s) => {
      if (active && !scopeTouchedRef.current && s === "all") setScope("all");
    });
    return () => {
      active = false;
    };
  }, []);

  // A reveal is a one-shot navigation request, but its history target must
  // survive consumption and ordinary command-palette navigation.
  const revealHash = revealCommit?.hash;
  const completedReveal = useRef<{ worktreeId: string; requestId: number } | null>(null);
  const revealPending = revealCommit !== null && (
    completedReveal.current?.worktreeId !== worktreeId ||
    completedReveal.current.requestId !== revealCommit.requestId
  );
  useEffect(() => {
    completedReveal.current = null;
  }, [worktreeId]);

  // Active membership needs PR state for every local branch, including refs
  // that are not checked out in a worktree. The service coalesces this with the
  // sidebar's repo refresh when both surfaces open together.
  useEffect(() => {
    void dispatch("pr:refresh", { repoId });
  }, [repoId]);

  useEffect(() => {
    let active = true;
    let loadSequence = 0;
    const load = (force: boolean): void => {
      const sequence = ++loadSequence;
      setLoadError(null);
      void dispatch("graph:lanes", { worktreeId, scope, force, ...(revealHash === undefined ? {} : { revealHash }) }).then((r) => {
        if (!active || sequence !== loadSequence) return;
        if (!r.ok) {
          const message = r.error.message.split("\n")[0];
          setLoadError(message);
          setLoading(false);
          // Keyed: every `graph:changed` for the repo reloads, and a
          // worktree whose folder is gone fails each time the same way.
          showErrorToast({
            key: `history:${worktreeId}`,
            title: "History unavailable",
            message,
            detail: r.error.message,
            subject: { worktreeId }
          });
          return;
        }

        const graph = r.value;
        onCommitsChange(graph.commits);
        // Registering who is on screen is all the graph does about people:
        // main answers from its store at once, and decides on its own clock
        // whether to ask a forge about anyone (`people:changed` follows).
        void dispatch("people:replaceInterest", {
          worktreeId,
          monitorId: peopleMonitorIdRef.current,
          authors: authorInterest(graph.commits)
        }).then(async (known) => {
          if (!active || sequence !== loadSequence) return;
          if (known.ok) {
            await warmPeopleAvatars(known.value);
            if (!active || sequence !== loadSequence) return;
          }
          // Publish graph rows only after every available local avatar is
          // decoded. Flush both state changes in one commit so a cached face
          // is the row's first and final rendered identity even if React's
          // ambient async batching behavior changes.
          flushSync(() => {
            if (known.ok) acceptPeople(known.value);
            setData(graph);
            setLoading(false);
          });
        }).catch(() => {
          if (!active || sequence !== loadSequence) return;
          setData(graph);
          setLoading(false);
        });
      });
    };
    setLoading(true);
    // A plain worktree/scope switch reuses the repo's cached lanes (fast); a
    // repo-scoped graph invalidation forces a recompute. Lane data is shared
    // across sibling worktrees, so filtering this event to one worktree would
    // leave the focused graph stale when a sibling HEAD moves.
    // A PR delta observed in All remains unconsumed until Active is requested.
    // Once that forced Active load starts, ordinary scope/worktree switches
    // return to the repo-level lane cache.
    const prInvalidation = consumeBranchPrInvalidation(
      scope,
      branchPrGeneration,
      consumedBranchPrGenerationRef.current
    );
    consumedBranchPrGenerationRef.current = prInvalidation.consumedGeneration;
    load(prInvalidation.force);
    const off = subscribe("graph:changed", (p) => {
      if (p.repoId === repoId) load(true);
    });
    return () => {
      active = false;
      off();
    };
  }, [acceptPeople, branchPrGeneration, onCommitsChange, repoId, worktreeId, scope, revealHash]);

  // Interest follows the window: a graph that goes away withdraws it, so main
  // stops looking after authors nobody is shown.
  useEffect(() => {
    const monitorId = peopleMonitorIdRef.current;
    return () => {
      void dispatch("people:replaceInterest", { worktreeId, monitorId, authors: [] });
    };
  }, [worktreeId]);

  // The sidebar and graph keep separate view models. Apply the same targeted
  // PR delta to the graph cache so a hover/focused refresh updates both
  // surfaces without re-running this repository's expensive lane query.
  useEffect(() => {
    return subscribe("pr:changed", (event) => {
      if (event.repoId !== repoId) return;
      // Active membership depends on merged PR state for squash/rebase branches.
      // Re-run the branch query after a fresh association lands so a branch
      // cannot remain drawn merely because it lacks an ancestry merge edge.
      if (Object.keys(event.prs).length > 0) {
        setBranchPrGeneration((generation) => generation + 1);
      }
      setData((current) => {
        if (current === null) return current;
        let changed = false;
        const branches = { ...current.branches };
        for (const [branch, pr] of Object.entries(event.prs)) {
          const info = branches[branch];
          if (info === undefined) continue;
          const next = { ...info };
          if (pr === null) delete next.pr;
          else next.pr = pr;
          branches[branch] = next;
          changed = true;
        }
        return changed ? { ...current, branches } : current;
      });
    });
  }, [repoId]);

  useEffect(() => {
    return subscribe("pr:commitChanged", (event) => {
      if (event.repoId === repoId) acceptCommitPullRequests(event.prs);
    });
  }, [acceptCommitPullRequests, repoId]);

  const head = data?.head ?? "";

  useEffect(() => {
    if (flash === null) return;
    const t = setTimeout(() => setFlash(null), 1600);
    return () => clearTimeout(t);
  }, [flash]);

  const email = activeEmail.toLowerCase();
  const layout = useMemo(() => {
    if (data === null) return layoutLanes([]);
    // Layout tips = local + remote refs, so drawn remote-only branches
    // (origin/team-x in "all" scope) own their lines too.
    const tips: Record<string, string[]> = {};
    for (const [h, ns] of Object.entries(data.tips)) tips[h] = [...ns];
    for (const [h, ns] of Object.entries(data.remoteTips)) {
      (tips[h] ??= []).push(...ns);
    }
    const remoteNames = new Set(Object.values(data.remoteTips).flat());
    // Lanes are drawn for the branch selection PLUS the upstream refs a drawn
    // branch is behind — the latter carry the fetched-but-unapplied commits,
    // so they need lanes and dashes even though they are not "branches" the
    // toolbar counts.
    const drawnRefs = [...data.shownBranches, ...data.upstreamRefs];
    return layoutLanes(
      data.commits.map((c) => ({ hash: c.hash, parents: c.parents })),
      {
        tips,
        defaultBranch: data.defaultBranch,
        defaultRefTips: data.defaultRefTips,
        localRefTips: Object.keys(data.tips),
        headUpstream: data.headUpstream,
        remoteBranches: drawnRefs.filter((name) => remoteNames.has(name)),
        // This worktree's checked-out branch — pinned to lane 1.
        headBranch: Object.entries(data.branches).find(
          ([, info]) => info.worktreeId === worktreeId
        )?.[0],
        shownBranches: drawnRefs
      }
    );
  }, [data, worktreeId]);

  const prLandingLayout = useMemo(() => {
    const commits = data?.commits ?? [];
    const links = findPrLandingLinks(
      commits,
      data?.tips ?? {},
      data?.remoteTips ?? {},
      data?.defaultBranch ?? "",
      data?.defaultRefTips ?? [],
      commitPullRequests
    );
    return layoutPrLandingLinks(links, commits, layout);
  }, [commitPullRequests, data, layout]);

  const vms: GraphRowVM[] = useMemo(() => {
    const commits = data?.commits ?? [];
    const tips = data?.tips ?? {};
    const remoteTips = data?.remoteTips ?? {};
    const defaultBranch = data?.defaultBranch ?? "";
    const headOnlyCommits = new Set(data?.headOnlyCommits ?? []);
    // Drawn branches (and the default) win the capped chip slots on a commit
    // tipped by many branches; stale hangers-on collapse into the +N pill.
    const drawn = new Set([
      ...(data?.shownBranches ?? []),
      ...(data?.upstreamRefs ?? []),
      defaultBranch
    ]);
    const localTipByName = new Map<string, string>();
    for (const [h, ns] of Object.entries(tips)) {
      for (const n of ns) localTipByName.set(n, h);
    }
    return commits.map((commit, i) => {
      const pullRequest = commitPullRequests[commit.hash];
      const names = tips[commit.hash] ?? [];
      const refs =
        names.length > 1
          ? [...names].sort(
              (a, b) => (drawn.has(b) ? 1 : 0) - (drawn.has(a) ? 1 : 0)
            )
          : names;
      // Remote-tracking refs tipped here. Synced with their local branch:
      // the trunk's remotes show compactly ("origin"), the rest stay quiet.
      // Anywhere else (remote ahead/diverged, or no local counterpart) the
      // full name marks the end of that remote's train.
      const remoteRefs = (remoteTips[commit.hash] ?? []).flatMap((n) => {
        const slash = n.indexOf("/");
        if (slash === -1) return [];
        const branch = n.slice(slash + 1);
        if (localTipByName.get(branch) === commit.hash) {
          return branch === defaultBranch ? [n.slice(0, slash)] : [];
        }
        return [n];
      });
      return {
        commit,
        row: layout.rows[i] ?? { lane: 0, top: [], bottom: [] },
        refs,
        tag: revealCommit?.hash === commit.hash && revealCommit.tagName !== undefined
          ? { name: revealCommit.tagName, kind: revealCommit.tagKind ?? "lightweight" }
          : data?.tags?.[commit.hash],
        remoteRefs,
        isHead: commit.hash === head,
        isHeadOnly: headOnlyCommits.has(commit.hash),
        isMine: commit.authorEmail.toLowerCase() === email,
        defaultBranch,
        ...(pullRequest == null ? {} : { pullRequest })
      };
    });
  }, [commitPullRequests, data, layout, email, head, revealCommit]);

  const graphCommitKey = useMemo(
    () => (data?.commits ?? []).map((commit) => commit.hash).join("\n"),
    [data?.commits]
  );

  // name → tip hash (from the hash → names maps) for the branch navigator;
  // remote names too, so a drawn origin/x branch is jumpable.
  const tipByName = useMemo(() => {
    const m = new Map<string, string>();
    for (const [hash, names] of Object.entries(data?.tips ?? {})) {
      for (const n of names) m.set(n, hash);
    }
    for (const [hash, names] of Object.entries(data?.remoteTips ?? {})) {
      for (const n of names) if (!m.has(n)) m.set(n, hash);
    }
    return m;
  }, [data]);
  const vmByHash = useMemo(
    () => new Map(vms.map((vm) => [vm.commit.hash, vm])),
    [vms]
  );
  const hoveredVm =
    hoveredCommit === null ? undefined : vmByHash.get(hoveredCommit);
  const menuVm =
    commitMenu === null ? undefined : vmByHash.get(commitMenu.hash);

  // The interactive card owns its delayed dismissal. Clear the associated
  // commit once it is actually gone, rather than as the pointer starts across
  // the gap from a row to the card.
  const contextWasVisible = useRef(false);
  useEffect(() => {
    if (commitContext.visible) {
      contextWasVisible.current = true;
      return;
    }
    setHoveredCommit(null);
    // Only a card that was actually on screen leaves the user mid-browse —
    // the initial hidden state must not start the warm window. An interactive
    // card outlives the hover that opened it, so warmth runs from its
    // dismissal rather than from the moment the pointer left the trigger.
    if (!contextWasVisible.current) return;
    contextWasVisible.current = false;
    hoverIntent.cardClosed();
  }, [commitContext.visible, hoverIntent]);

  // The person card shares the rows' intent gate, and closes the same way.
  const personWasVisible = useRef(false);
  useEffect(() => {
    if (personCard.visible) {
      personWasVisible.current = true;
      return;
    }
    setOpenPerson(null);
    if (!personWasVisible.current) return;
    personWasVisible.current = false;
    hoverIntent.cardClosed();
  }, [personCard.visible, hoverIntent]);

  const personStats = useMemo(
    () => personGraphStats(data?.commits ?? [], data?.tips ?? {}),
    [data]
  );
  const myKey = commitAuthorPersonKey(activeEmail);
  const personCardFor = (commit: Commit): ReactNode => {
    const key = commitAuthorPersonKey(commit.authorEmail);
    const stats = personStats.get(key);
    if (stats === undefined) return null;
    return (
      <PersonCard
        name={commit.authorName}
        email={commit.authorEmail}
        isMine={key === myKey}
        person={people[key]}
        stats={stats}
        now={now}
      />
    );
  };
  const openPersonVm = openPerson === null ? undefined : vmByHash.get(openPerson.hash);
  const openPersonCard = openPersonVm === undefined ? null : personCardFor(openPersonVm.commit);

  // An open person card follows what main pushes and the shared clock, like
  // the commit card does.
  useEffect(() => {
    if (!personCard.visible || openPersonCard === null) return;
    personCard.update(openPersonCard);
    // `openPersonCard` is a new element every render; these are what it is
    // built from.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personCard.update, personCard.visible, openPersonVm, people, personStats, now, myKey]);

  const showPerson = (target: HTMLElement, vm: GraphRowVM): void => {
    const card = personCardFor(vm.commit);
    if (card === null) return;
    commitContext.hide();
    setOpenPerson({
      key: commitAuthorPersonKey(vm.commit.authorEmail),
      hash: vm.commit.hash,
      name: vm.commit.authorName
    });
    personCard.show(target, card);
  };

  // What main's people store learns arrives here; nothing in this view asks
  // for it. A face is decoded before it is painted, as on load.
  useEffect(() => {
    let active = true;
    const off = subscribe("people:changed", (payload) => {
      if (payload.worktreeId !== worktreeId) return;
      void warmPeopleAvatars(payload.people).then(() => {
        // A switch while the face decoded: these people are another view's.
        if (active) acceptPeople(payload.people);
      });
    });
    return () => {
      active = false;
      off();
    };
  }, [acceptPeople, worktreeId]);

  // Diffstats are intentionally lazy: a graph can contain hundreds of commits,
  // but only the one under the pointer needs a numstat walk. Cache both success
  // and failure for this worktree so repeated hover is instant and quiet.
  useEffect(() => {
    commitStatsEpochRef.current += 1;
    commitStatsRequestsRef.current.clear();
    setCommitStats({});
    setPeople({});
  }, [worktreeId]);

  useEffect(() => {
    setCommitPullRequests({});
  }, [repoId, worktreeId]);

  useEffect(() => {
    if (hoveredVm === undefined) return;
    const hash = hoveredVm.commit.hash;
    if (commitStats[hash] !== undefined) return;
    const epoch = commitStatsEpochRef.current;
    if (commitStatsRequestsRef.current.get(hash) === epoch) return;
    commitStatsRequestsRef.current.set(hash, epoch);
    void dispatch("commit:stats", { worktreeId, hash })
      .then((result) => {
        if (commitStatsEpochRef.current !== epoch) return;
        setCommitStats((current) => ({
          ...current,
          [hash]: result.ok ? result.value : null
        }));
      })
      .finally(() => {
        if (commitStatsRequestsRef.current.get(hash) === epoch) {
          commitStatsRequestsRef.current.delete(hash);
        }
      });
  }, [commitStats, hoveredVm, worktreeId]);

  // The context window remains current while it is open: its age changes with
  // the shared clock, while ref/base information and lazy diffstats update
  // after graph refreshes and local Git responses.
  useEffect(() => {
    if (!commitContext.visible || hoveredVm === undefined) return;
    commitContext.update(
      <CommitContextCard
        commit={hoveredVm.commit}
        viewingBranch={hoveredVm.isHeadOnly ? viewingBranch : null}
        defaultBranch={hoveredVm.defaultBranch}
        defaultRef={data?.defaultRef ?? hoveredVm.defaultBranch}
        now={now}
        stats={commitStats[hoveredVm.commit.hash]}
        githubIdentity={provenIdentity(
          people[commitAuthorPersonKey(hoveredVm.commit.authorEmail)]
        )}
        pullRequest={commitPullRequests[hoveredVm.commit.hash] ?? undefined}
      />
    );
  }, [
    commitContext.update,
    commitContext.visible,
    hoveredVm,
    now,
    commitStats,
    commitPullRequests,
    people,
    viewingBranch
  ]);

  const showCommitContext = (
    target: HTMLElement,
    anchor: TooltipAnchor,
    vm: GraphRowVM
  ): void => {
    setHoveredCommit(vm.commit.hash);
    personCard.hide();
    void dispatch("pr:refreshCommits", {
      repoId,
      commitHashes: [vm.commit.hash],
      trigger: "user"
    }).then((result) => {
      if (result.ok) acceptCommitPullRequests(result.value);
    });
    commitContext.show(
      target,
      <CommitContextCard
        commit={vm.commit}
        viewingBranch={vm.isHeadOnly ? viewingBranch : null}
        defaultBranch={vm.defaultBranch}
        defaultRef={data?.defaultRef ?? vm.defaultBranch}
        now={now}
        stats={commitStats[vm.commit.hash]}
        githubIdentity={provenIdentity(
          people[commitAuthorPersonKey(vm.commit.authorEmail)]
        )}
        pullRequest={commitPullRequests[vm.commit.hash] ?? undefined}
      />,
      anchor
    );
  };

  const openCommitMenu = (
    vm: GraphRowVM,
    position: { x: number; y: number }
  ): void => {
    commitContext.hide();
    personCard.hide();
    setBranchMenu(null);
    setCommitMenu({ hash: vm.commit.hash, ...position });
  };

  const openBranchMenu = (target: BranchChipTarget): void => {
    commitContext.hide();
    personCard.hide();
    setCommitMenu(null);
    setBranchMenu(target);
  };

  /**
   * Move this worktree onto a branch drawn in the graph. The menu is already
   * gone by the time git answers, so the outcome arrives as a toast — a switch
   * of a large checkout takes seconds, and a refusal (dirty tree, branch held
   * by another worktree) has nowhere else to appear.
   */
  const switchToBranch = async (target: CommitSwitchTarget): Promise<void> => {
    const outcome = await guardedSwitchBranch({
      worktreeId,
      worktreeLabel: lastSegment(worktreePath),
      fromBranch: viewingBranch,
      branch: target.branch
    });
    if (outcome.kind === "cancelled") return;
    if (outcome.kind === "held") {
      // The chip believed this branch free, and something checked it out in
      // the meantime. Resolve it the way the sidebar does — go to whoever
      // holds it now — rather than reporting a refusal the user cannot act on.
      const fresh = await dispatch("repo:refs", { repoId });
      const holder = fresh.ok
        ? fresh.value.branches.find((b) => b.name === target.branch)
            ?.checkedOutWorktreeIds[0]
        : undefined;
      if (holder !== undefined) {
        onRevealWorktree(holder);
        return;
      }
      showErrorToast({
        title: "Switch failed",
        message: `${target.branch} is already checked out in another worktree.`,
        subject: { repoId }
      });
      return;
    }
    if (outcome.kind === "failed") {
      showErrorToast({
        title: "Switch failed",
        message: switchFailureMessage(
          { kind: "repo", code: outcome.code, message: outcome.message },
          target.branch
        ),
        detail: outcome.message,
        subject: { repoId }
      });
      return;
    }
    showInfoToast({
      title: "Branch switched",
      message: `${target.branch} is checked out here.`,
      subject: { repoId }
    });
  };

  const gutterW = gutterWidth(prLandingLayout.laneCount);
  const laneOverflow = prLandingLayout.laneCount > MAX_GUTTER_LANES;

  // Horizontally reveal a lane inside the clipped gutter (no-op when the
  // gutter isn't overflowing). Scrolling the bar drives a CSS var on the card.
  const revealLane = (lane: number): void => {
    const bar = laneBarRef.current;
    if (bar === null) return;
    const x = lane * LANE_W;
    bar.scrollLeft = Math.max(0, Math.min(x - gutterW / 2, bar.scrollWidth));
  };

  const locateHash = (hash: string): void => {
    if (hash === "") return;
    const vm = vmByHash.get(hash);
    if (vm !== undefined) revealLane(vm.row.lane);
    const el = scrollerRef.current?.querySelector(`[data-hash="${hash}"]`);
    el?.scrollIntoView({
      block: "center",
      inline: "nearest",
      behavior: scrollBehavior()
    });
    setFlash(hash);
  };

  useEffect(() => {
    if (!revealPending || revealCommit === null || !vmByHash.has(revealCommit.hash)) return;
    const raf = requestAnimationFrame(() => {
      completedReveal.current = { worktreeId, requestId: revealCommit.requestId };
      locateHash(revealCommit.hash);
      const commit = vmByHash.get(revealCommit.hash)?.commit;
      if (revealCommit.tagName !== undefined && commit !== undefined) {
        onOpenCommit(commit.hash, commit.subject);
        // Locating scrolls the graph and swaps the rail without moving focus
        // — and when the request came from the refs browser, the dialog the
        // reader was in has just closed underneath them. Everything that says
        // it worked is visual, so say it (SC 4.1.3).
        announce(
          `Tag ${revealCommit.tagName} located at commit ${commit.shortHash}, ${commit.subject}.`
        );
      }
    });
    return () => cancelAnimationFrame(raf);
    // locateHash intentionally tracks the rendered graph through graphCommitKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphCommitKey, revealCommit, worktreeId, revealPending]);

  // Selecting a worktree takes you to its HEAD: center it and flash it. Also
  // re-centers when HEAD itself moves (commit, pull, switch branch).
  useEffect(() => {
    // Capture pending state from this render: the reveal RAF may consume the
    // request before this RAF runs. Once consumed, future HEAD moves center normally.
    if (head === "" || revealPending) return;
    const raf = requestAnimationFrame(() => locateHash(head));
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [head, worktreeId]);

  // If the graph shrinks back under the gutter cap, undo any lane scroll.
  useEffect(() => {
    if (!laneOverflow) cardRef.current?.style.setProperty("--lane-scroll", "0px");
  }, [laneOverflow]);

  // Commit history can be enormous, so the main process must never infer its
  // monitor set from every rendered graph row. Observe only rows intersecting
  // the scroll viewport, then replace this view's complete reason set once the
  // user has been idle for 500 ms. The main-process replacement is atomic and
  // unions this reason with every other active monitoring reason.
  useEffect(() => {
    const root = scrollerRef.current;
    const card = cardRef.current;
    if (root === null || card === null || graphCommitKey === "") return;

    let active = true;
    let idleTimer: number | null = null;
    let publishedInitial = false;
    const visible = new Set<string>();
    const publish = (): void => {
      idleTimer = null;
      const commitHashes = [...visible];
      void dispatch("pr:replaceVisibleCommits", {
        repoId,
        worktreeId,
        monitorId: commitPrMonitorIdRef.current,
        commitHashes
      }).then((result) => {
        if (active && result.ok) acceptCommitPullRequests(result.value);
      });
    };
    const schedulePublish = (): void => {
      if (idleTimer !== null) window.clearTimeout(idleTimer);
      idleTimer = window.setTimeout(publish, VISIBLE_COMMIT_PR_IDLE_MS);
    };
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const hash = (entry.target as HTMLElement).dataset.hash;
          if (hash === undefined) continue;
          if (entry.isIntersecting) visible.add(hash);
          else visible.delete(hash);
        }
        if (!publishedInitial) {
          publishedInitial = true;
          publish();
        } else {
          schedulePublish();
        }
      },
      { root, threshold: 0.01 }
    );
    for (const row of card.querySelectorAll<HTMLElement>(".graph-row[data-hash]")) {
      observer.observe(row);
    }

    return () => {
      active = false;
      observer.disconnect();
      if (idleTimer !== null) window.clearTimeout(idleTimer);
      // Unmount/scope changes should release the reason immediately. A new
      // view publishes its initial visible set immediately from cache.
      void dispatch("pr:replaceVisibleCommits", {
        repoId,
        worktreeId,
        monitorId: commitPrMonitorIdRef.current,
        commitHashes: []
      });
    };
  }, [acceptCommitPullRequests, graphCommitKey, repoId, worktreeId]);

  // Horizontal trackpad/wheel over the LANE GUTTER pans the lanes (via the
  // shared scrollbar) without touching the commit list; vertical deltas pass
  // through to normal list scrolling. Native non-passive listener — React's
  // synthetic wheel can't preventDefault.
  useEffect(() => {
    if (!laneOverflow) return;
    const card = cardRef.current;
    if (card === null) return;
    const onWheel = (e: WheelEvent): void => {
      const target = e.target as HTMLElement | null;
      if (target === null || target.closest(".graph-lanes-clip") === null) return;
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
      const bar = laneBarRef.current;
      if (bar === null) return;
      bar.scrollLeft += e.deltaX;
      e.preventDefault();
    };
    card.addEventListener("wheel", onWheel, { passive: false });
    return () => card.removeEventListener("wheel", onWheel);
  }, [laneOverflow]);

  const shown = data?.shownBranches.length ?? 0;
  const matched = data?.matchedBranches ?? shown;
  const hidden = data?.hiddenBranches ?? 0;
  const countLabel =
    scope === "active"
      ? `${shown}${matched > shown ? ` of ${matched}` : ""} active branch${
          matched === 1 ? "" : "es"
        }`
      : `${shown}${matched > shown ? ` of ${matched}` : ""} branch${
          matched === 1 ? "" : "es"
        } in flight`;

  // The branch navigator could not be closed from the keyboard at all before
  // this — backdrop click was its only dismissal (WCAG 2.1 SC 2.1.1).
  useDismissable({
    open: branchesOpen,
    onDismiss: closeBranches,
    triggerRef: branchesBtnRef,
    surfaceRef: branchesPopRef
  });
  useMenuNavigation({
    open: branchesOpen,
    menuRef: branchesPopRef,
    onClose: closeBranches
  });

  return (
    <>
      <div className="graph-toolbar">
        <span className="graph-toolbar__label">Lineage</span>
        <span style={{ flex: 1 }} />
        <span className="graph-branches-wrap">
          <button
            ref={branchesBtnRef}
            className="graph-branches"
            aria-haspopup="menu"
            aria-expanded={branchesOpen}
            {...hoverTooltip(tip, "Branches drawn in this graph — click one to jump to its tip")}
            onClick={() => setBranchesOpen((v) => !v)}
          >
            {countLabel}
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
          {branchesOpen && (
            <>
              <div
                className="branch-pop__backdrop"
                onClick={() => setBranchesOpen(false)}
              />
              <div ref={branchesPopRef} className="branch-pop" role="menu">
                {[
                  ...(data?.shownBranches ?? []),
                  ...(data?.upstreamRefs ?? [])
                ].map((name) => {
                  const tipHash = tipByName.get(name);
                  const vm =
                    tipHash !== undefined ? vmByHash.get(tipHash) : undefined;
                  return (
                    <button
                      key={name}
                      className="branch-pop__item"
                      role="menuitem"
                      disabled={vm === undefined}
                      /* A disabled menuitem announces its name, and AT reads
                         that over a card — so the reason is the name as well
                         as the card. */
                      aria-label={
                        vm === undefined
                          ? `${name} — unavailable, its tip is outside the loaded window`
                          : undefined
                      }
                      {...hoverTooltip(
                        tip,
                        vm === undefined
                          ? "Tip is outside the loaded window"
                          : `Jump to ${name}`
                      )}
                      onClick={() => {
                        if (tipHash !== undefined) {
                          locateHash(tipHash);
                          setBranchesOpen(false);
                        }
                      }}
                    >
                      <span
                        className="branch-pop__dot"
                        style={{
                          background:
                            vm !== undefined
                              ? laneColor(vm.row.lane)
                              : "var(--text-subtle)"
                        }}
                      />
                      <span className="branch-pop__name">{name}</span>
                      {vm !== undefined && (
                        <span className="branch-pop__meta">
                          {vm.isMine ? "you" : vm.commit.authorName} ·{" "}
                          {shortWhen(vm.commit.committedAt, now)}
                        </span>
                      )}
                    </button>
                  );
                })}
                {shown === 0 && (
                  <div className="branch-pop__empty">No branches drawn</div>
                )}
                {matched > shown && (
                  <div className="branch-pop__more">
                    +{matched - shown} more not drawn — showing the {shown} most
                    recent
                  </div>
                )}
              </div>
            </>
          )}
        </span>
        {head !== "" && (
          <button
            className="graph-locate"
            onClick={() => locateHash(head)}
            {...hoverTooltip(tip, "Scroll to this worktree's current commit (HEAD)")}
          >
            <LocateGlyph />
            You are here
          </button>
        )}
        <button
          className={`only-me${scope === "active" ? " is-on" : ""}`}
          {...hoverTooltip(
            tip,
            scope === "active"
              ? "Showing your active, unmerged branches. Click to show all branches."
              : "Showing all branches. Click to show only active ones."
          )}
          onClick={() => {
            scopeTouchedRef.current = true;
            setScope((s) => (s === "active" ? "all" : "active"));
          }}
        >
          <span className="only-me__dot" />
          {scope === "active" ? "Active" : "All branches"}
        </button>
      </div>

      {laneOverflow && vms.length > 0 && (
        <div
          className="lane-scrollbar"
          ref={laneBarRef}
          {...hoverTooltip(tip, "Scroll the lane gutter — commits stay put")}
          style={{ width: gutterW }}
          onScroll={(e) => {
            cardRef.current?.style.setProperty(
              "--lane-scroll",
              `${-e.currentTarget.scrollLeft}px`
            );
          }}
        >
          <div style={{ width: prLandingLayout.laneCount * LANE_W, height: 1 }} />
        </div>
      )}
      <div className="graph-scroll" ref={scrollerRef}>
        {vms.length > 0 ? (
          <div
            ref={cardRef}
            className={`graph-card${selectedCommits.size > 0 ? " has-selection" : ""}`}
          >
            {vms.map((vm, i) => (
              <GraphRow
                key={vm.commit.hash}
                vm={vm}
                laneCount={prLandingLayout.laneCount}
                prLanding={prLandingLayout.rows[i] ?? { top: [], bottom: [] }}
                now={now}
                selected={selectedCommits.has(vm.commit.hash)}
                focused={focusedCommit === vm.commit.hash}
                contextOpen={hoveredCommit === vm.commit.hash && commitContext.visible}
                flashing={flash === vm.commit.hash}
                branchInfo={data?.branches ?? {}}
                authorAvatarUrl={
                  provenIdentity(people[commitAuthorPersonKey(vm.commit.authorEmail)])
                    ?.avatarUrl
                }
                personOpen={openPerson?.hash === vm.commit.hash && personCard.visible}
                hoverIntent={hoverIntent}
                onToggle={() => onToggleCommit(vm.commit.hash)}
                onOpen={() => onOpenCommit(vm.commit.hash, vm.commit.subject)}
                onShowContext={(target, anchor) =>
                  showCommitContext(target, anchor, vm)
                }
                onHideContext={commitContext.scheduleHide}
                onFocusContext={commitContext.focusFirst}
                onShowPerson={(target) => showPerson(target, vm)}
                onHidePerson={personCard.scheduleHide}
                onFocusPerson={personCard.focusFirst}
                onOpenContextMenu={(position) => openCommitMenu(vm, position)}
                onOpenBranchMenu={openBranchMenu}
                onRevealWorktree={onRevealWorktree}
              />
            ))}
          </div>
        ) : (
          <div className="graph-empty">
            {loadError !== null
              ? `Couldn't load history: ${loadError}`
              : loading
              ? "Loading history…"
              : scope === "active"
                ? "No active branches — you're all caught up."
                : "No commits."}
          </div>
        )}

        {scope === "active" && hidden > 0 && (
          <div className="graph-hidden-note">
            {hidden} more branch{hidden === 1 ? "" : "es"} hidden (merged or
            inactive).{" "}
            <button onClick={() => setScope("all")}>Show all branches</button>
          </div>
        )}
      </div>
      {commitContext.tooltipNode}
      {personCard.tooltipNode}
      {commitMenu !== null && menuVm !== undefined && (
        <CommitContextMenu
          x={commitMenu.x}
          y={commitMenu.y}
          vm={menuVm}
          branchInfo={data?.branches ?? {}}
          viewingBranch={viewingBranch}
          worktreeId={worktreeId}
          onViewChanges={() =>
            onOpenCommit(menuVm.commit.hash, menuVm.commit.subject)
          }
          onBranchFrom={() => setBranchFromCommit(menuVm.commit)}
          onTagFrom={() => setTagFromCommit(menuVm.commit)}
          onSwitchBranch={(target) => void switchToBranch(target)}
          onRevealWorktree={onRevealWorktree}
          onClose={() => setCommitMenu(null)}
        />
      )}
      {branchMenu !== null && (
        <BranchChipMenu
          target={branchMenu}
          branchInfo={data?.branches ?? {}}
          viewingBranch={viewingBranch}
          repoId={repoId}
          worktreeId={worktreeId}
          onSwitchBranch={(target) => void switchToBranch(target)}
          onRevealWorktree={onRevealWorktree}
          onClose={() => setBranchMenu(null)}
        />
      )}
      {tagFromCommit !== null && (
        <CreateTagDialog
          repoId={repoId}
          repoName={repoName}
          initialTarget={tagFromCommit.hash}
          onCreated={() => undefined}
          onClose={() => setTagFromCommit(null)}
        />
      )}
      {branchFromCommit !== null && (
        <BranchFromCommitDialog
          repoId={repoId}
          repoName={repoName}
          worktreeId={worktreeId}
          viewingBranch={viewingBranch}
          commit={branchFromCommit}
          now={now}
          onCreated={(checkedOutWorktreeId) => {
            if (
              checkedOutWorktreeId !== null &&
              checkedOutWorktreeId !== worktreeId
            ) {
              onRevealCreatedWorktree(checkedOutWorktreeId);
            }
          }}
          onClose={() => setBranchFromCommit(null)}
        />
      )}
      {tip.tooltipNode}
    </>
  );
}
