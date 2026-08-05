import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type {
  CommitStats,
  GitHubCommitAuthorIdentity,
  GitHubCommitAuthorIdentityLookup,
  LaneGraph,
  PrSummary
} from "@pwrgit/shared";
import { dispatch, subscribe } from "../../lib/pwrgit";
import { useRelativeClock } from "../../lib/useRelativeClock";
import {
  type TooltipAnchor,
  useViewportTooltip
} from "../../lib/useViewportTooltip";
import { CommitContextCard } from "./CommitContextCard";
import { CommitContextMenu } from "./CommitContextMenu";
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

/**
 * Keep only identity results that are stable for this worktree session. An
 * in-flight or temporarily unavailable lookup must remain retryable on a
 * later hover; a verified identity and authoritative no-match are reusable.
 */
export function reusableCommitAuthorIdentity(
  lookup: GitHubCommitAuthorIdentityLookup
): GitHubCommitAuthorIdentity | null | undefined {
  if (lookup.identity !== undefined) return lookup.identity;
  return lookup.refreshState === "not-eligible" ||
    (lookup.cacheState === "fresh" && lookup.refreshState === "idle")
    ? null
    : undefined;
}

/**
 * IPC replies and targeted events can cross in either order. Keep the most
 * complete/newest proof so a delayed cache-only reply cannot erase a local
 * identity or thumbnail that was already painted by an event.
 */
export function mergeCommitAuthorIdentityLookup(
  current: GitHubCommitAuthorIdentityLookup | undefined,
  incoming: GitHubCommitAuthorIdentityLookup
): GitHubCommitAuthorIdentityLookup {
  if (current === undefined) return incoming;

  if (current.identity !== undefined && incoming.identity === undefined) {
    return current;
  }
  if (current.identity === undefined && incoming.identity !== undefined) {
    return incoming;
  }
  // The normal hover transport responds immediately with this placeholder.
  // It carries no proof and must never replace an already settled negative
  // cache result just because the IPC reply beat the repaint event.
  if (
    incoming.cacheState === "miss" &&
    incoming.refreshState === "in-flight" &&
    current.cacheState === "fresh" &&
    current.refreshState === "idle"
  ) {
    return current;
  }

  const currentRefreshedAt = current.refreshedAt ?? Number.NEGATIVE_INFINITY;
  const incomingRefreshedAt = incoming.refreshedAt ?? Number.NEGATIVE_INFINITY;
  if (incomingRefreshedAt < currentRefreshedAt) return current;
  if (incomingRefreshedAt > currentRefreshedAt) return incoming;

  const currentAvatarRefreshedAt =
    current.avatarCache?.refreshedAt ?? Number.NEGATIVE_INFINITY;
  const incomingAvatarRefreshedAt =
    incoming.avatarCache?.refreshedAt ?? Number.NEGATIVE_INFINITY;
  if (incomingAvatarRefreshedAt < currentAvatarRefreshedAt) return current;
  if (incomingAvatarRefreshedAt > currentAvatarRefreshedAt) return incoming;

  if (
    current.identity?.avatarUrl !== undefined &&
    incoming.identity?.avatarUrl === undefined
  ) {
    return current;
  }
  return incoming;
}

/** Retry only when the main-process proof/asset cache says another hover can help. */
export function shouldRequestCommitAuthorIdentity(
  lookup: GitHubCommitAuthorIdentityLookup | undefined,
  now: number
): boolean {
  if (lookup === undefined) return true;
  if (lookup.refreshState === "not-eligible" || lookup.refreshState === "in-flight") {
    return false;
  }
  if (lookup.refreshState === "backing-off") {
    return lookup.nextRetryAt === undefined || lookup.nextRetryAt <= now;
  }
  if (lookup.cacheState !== "fresh") return true;
  if (lookup.avatarCache === undefined) return false;
  return lookup.avatarCache.refreshState === "backing-off" &&
    (lookup.avatarCache.nextRetryAt === undefined || lookup.avatarCache.nextRetryAt <= now);
}

// A proof-backed identity resolves to this opaque local resource. Cache
// hydration waits for decode before graph rows become interactive and retains
// the decoded image for the graph session. Keeping the element alive matters
// for custom protocols: Chromium may otherwise discard its decoded surface
// before a tooltip creates its own image element, causing one initials frame.
const MAX_RETAINED_COMMIT_AUTHOR_AVATARS = 256;
const warmedCommitAuthorAvatars = new Map<string, HTMLImageElement>();
const warmingCommitAuthorAvatarUrls = new Map<string, Promise<void>>();
function warmCommitAuthorAvatar(
  lookup: GitHubCommitAuthorIdentityLookup
): Promise<void> {
  const avatarUrl = lookup.identity?.avatarUrl;
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

async function warmCommitAuthorAvatars(
  lookups: Record<string, GitHubCommitAuthorIdentityLookup>
): Promise<void> {
  await Promise.all(Object.values(lookups).map(warmCommitAuthorAvatar));
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
  window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : "smooth";

export function LineageGraph({
  repoId,
  worktreeId,
  viewingBranch,
  activeEmail,
  selectedCommits,
  focusedCommit,
  onToggleCommit,
  onOpenCommit,
  onRevealWorktree
}: {
  repoId: string;
  worktreeId: string;
  /** Branch checked out in the worktree whose lineage is being viewed. */
  viewingBranch: string;
  activeEmail: string;
  selectedCommits: Set<string>;
  /** Commit whose files are open in the rail — highlighted even off-branch. */
  focusedCommit: string | null;
  onToggleCommit: (hash: string) => void;
  onOpenCommit: (hash: string, subject: string) => void;
  /** Jump to a worktree from a tip chip's worktree button. */
  onRevealWorktree: (worktreeId: string) => void;
}) {
  const [data, setData] = useState<LaneGraph | null>(null);
  const [scope, setScope] = useState<Scope>("active");
  const [loading, setLoading] = useState(true);
  const [branchPrGeneration, setBranchPrGeneration] = useState(0);
  const [flash, setFlash] = useState<string | null>(null);
  const [branchesOpen, setBranchesOpen] = useState(false);
  const [hoveredCommit, setHoveredCommit] = useState<string | null>(null);
  const [commitMenu, setCommitMenu] = useState<CommitMenuState | null>(null);
  const [commitStats, setCommitStats] = useState<
    Record<string, CommitStats | null>
  >({});
  const [commitPullRequests, setCommitPullRequests] = useState<
    Record<string, PrSummary | null>
  >({});
  const [commitAuthorIdentityLookups, setCommitAuthorIdentityLookups] = useState<
    Record<string, GitHubCommitAuthorIdentityLookup>
  >({});
  const now = useRelativeClock();
  const commitContext = useViewportTooltip("commit-context-card", {
    interactive: true
  });
  const scrollerRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const laneBarRef = useRef<HTMLDivElement>(null);
  const scopeTouchedRef = useRef(false);
  const commitStatsRequestsRef = useRef(new Map<string, number>());
  const commitAuthorIdentityRequestsRef = useRef(new Map<string, number>());
  const commitStatsEpochRef = useRef(0);
  const commitAuthorIdentityEpochRef = useRef(0);
  const commitPrMonitorIdRef = useRef(crypto.randomUUID());

  const acceptCommitPullRequests = useCallback(
    (prs: Record<string, PrSummary | null>): void => {
      if (Object.keys(prs).length === 0) return;
      setCommitPullRequests((current) => ({ ...current, ...prs }));
    },
    []
  );

  const acceptCommitAuthorIdentityLookup = useCallback((
    commitHash: string,
    lookup: GitHubCommitAuthorIdentityLookup
  ): void => {
    void warmCommitAuthorAvatar(lookup);
    setCommitAuthorIdentityLookups((current) => {
      const merged = mergeCommitAuthorIdentityLookup(current[commitHash], lookup);
      return merged === current[commitHash]
        ? current
        : { ...current, [commitHash]: merged };
    });
  }, []);

  useEffect(() => {
    let active = true;
    void defaultLineageScope().then((s) => {
      if (active && !scopeTouchedRef.current && s === "all") setScope("all");
    });
    return () => {
      active = false;
    };
  }, []);

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
      void dispatch("graph:lanes", { worktreeId, scope, force }).then((r) => {
        if (!active || sequence !== loadSequence) return;
        if (!r.ok) {
          setLoading(false);
          return;
        }

        const graph = r.value;
        void dispatch("github:hydrateCommitAuthorIdentities", {
          worktreeId,
          commits: graph.commits.map((commit) => ({
            commitHash: commit.hash,
            authorName: commit.authorName,
            authorEmail: commit.authorEmail
          }))
        }).then(async (hydrated) => {
          if (!active || sequence !== loadSequence) return;
          if (hydrated.ok) {
            await warmCommitAuthorAvatars(hydrated.value);
            if (!active || sequence !== loadSequence) return;
          }
          // Publish graph rows only after every available local avatar is
          // decoded. Flush both state changes in one commit so a fresh cache
          // hit is the tooltip's first and final rendered identity even if
          // React's ambient async batching behavior changes.
          flushSync(() => {
            if (hydrated.ok) {
              setCommitAuthorIdentityLookups((current) => {
                let next = current;
                for (const [hash, lookup] of Object.entries(hydrated.value)) {
                  const merged = mergeCommitAuthorIdentityLookup(next[hash], lookup);
                  if (merged === next[hash]) continue;
                  if (next === current) next = { ...current };
                  next[hash] = merged;
                }
                return next;
              });
            }
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
    // A plain worktree/scope switch reuses the repo's cached lanes (fast); an
    // actual change to this worktree forces a recompute.
    load(branchPrGeneration > 0);
    const off = subscribe("worktree:changed", (p) => {
      if (p.worktreeId === worktreeId) load(true);
    });
    return () => {
      active = false;
      off();
    };
  }, [branchPrGeneration, worktreeId, scope]);

  // The sidebar and graph keep separate view models. Apply the same targeted
  // PR delta to the graph cache so a hover/focused refresh updates both
  // surfaces without re-running this repository's expensive lane query.
  useEffect(() => {
    return subscribe("pr:changed", (event) => {
      if (event.repoId !== repoId) return;
      // Active membership depends on merged PR state for squash/rebase branches.
      // Re-run the branch query after a fresh association lands so a branch
      // cannot remain drawn merely because it lacks an ancestry merge edge.
      if (scope === "active" && Object.keys(event.prs).length > 0) {
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
  }, [repoId, scope]);

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
    return layoutLanes(
      data.commits.map((c) => ({ hash: c.hash, parents: c.parents })),
      {
        tips,
        defaultBranch: data.defaultBranch,
        defaultRefTips: data.defaultRefTips,
        // This worktree's checked-out branch — pinned to lane 1.
        headBranch: Object.entries(data.branches).find(
          ([, info]) => info.worktreeId === worktreeId
        )?.[0],
        shownBranches: data.shownBranches
      }
    );
  }, [data, worktreeId]);

  const prLandingLayout = useMemo(() => {
    const commits = data?.commits ?? [];
    const links = findPrLandingLinks(
      commits,
      data?.tips ?? {},
      data?.defaultBranch ?? "",
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
    const drawn = new Set([...(data?.shownBranches ?? []), defaultBranch]);
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
        remoteRefs,
        isHead: commit.hash === head,
        isHeadOnly: headOnlyCommits.has(commit.hash),
        isMine: commit.authorEmail.toLowerCase() === email,
        defaultBranch,
        ...(pullRequest == null ? {} : { pullRequest })
      };
    });
  }, [commitPullRequests, data, layout, email, head]);

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
  useEffect(() => {
    if (!commitContext.visible) setHoveredCommit(null);
  }, [commitContext.visible]);

  // Identity verification is lazy like diffstats, but it must never delay a
  // context card. Renderer results are retained by full commit hash for the
  // current worktree view; the main process may reuse an author account that
  // was established by an exact GitHub commit proof.
  useEffect(() => {
    return subscribe("github:commitAuthorIdentityChanged", (payload) => {
      if (payload.worktreeId !== worktreeId) return;
      acceptCommitAuthorIdentityLookup(payload.commitHash, payload.lookup);
    });
  }, [acceptCommitAuthorIdentityLookup, worktreeId]);

  // Diffstats are intentionally lazy: a graph can contain hundreds of commits,
  // but only the one under the pointer needs a numstat walk. Cache both success
  // and failure for this worktree so repeated hover is instant and quiet.
  useEffect(() => {
    commitStatsEpochRef.current += 1;
    commitAuthorIdentityEpochRef.current += 1;
    commitStatsRequestsRef.current.clear();
    commitAuthorIdentityRequestsRef.current.clear();
    setCommitStats({});
    setCommitAuthorIdentityLookups({});
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

  useEffect(() => {
    if (hoveredVm === undefined) return;
    const commit = hoveredVm.commit;
    const lookup = commitAuthorIdentityLookups[commit.hash];
    // A result comes only from a main-process proof-backed cache. Keep the
    // display data while respecting its persisted TTL/backoff metadata, so a
    // later hover can revalidate an old identity without a network image load.
    if (!shouldRequestCommitAuthorIdentity(lookup, now)) return;
    const epoch = commitAuthorIdentityEpochRef.current;
    if (commitAuthorIdentityRequestsRef.current.get(commit.hash) === epoch) return;
    commitAuthorIdentityRequestsRef.current.set(commit.hash, epoch);
    void dispatch("github:commitAuthorIdentity", {
      worktreeId,
      commitHash: commit.hash,
      authorName: commit.authorName,
      authorEmail: commit.authorEmail
    }).then((result) => {
      // Normal hover replies are optimistic today, but merge them rather than
      // discarding them. This also keeps the renderer correct if a future
      // transport can return a local proof directly.
      if (
        !result.ok ||
        commitAuthorIdentityEpochRef.current !== epoch
      ) {
        return;
      }
      acceptCommitAuthorIdentityLookup(commit.hash, result.value);
    }).finally(() => {
      if (commitAuthorIdentityRequestsRef.current.get(commit.hash) === epoch) {
        commitAuthorIdentityRequestsRef.current.delete(commit.hash);
      }
    });
  }, [
    acceptCommitAuthorIdentityLookup,
    commitAuthorIdentityLookups,
    hoveredVm,
    now,
    worktreeId
  ]);

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
        githubIdentity={reusableCommitAuthorIdentity(
          commitAuthorIdentityLookups[hoveredVm.commit.hash] ?? {
            cacheState: "miss",
            refreshState: "in-flight"
          }
        ) ?? undefined}
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
    commitAuthorIdentityLookups,
    viewingBranch
  ]);

  const showCommitContext = (
    target: HTMLElement,
    anchor: TooltipAnchor,
    vm: GraphRowVM
  ): void => {
    setHoveredCommit(vm.commit.hash);
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
        githubIdentity={reusableCommitAuthorIdentity(
          commitAuthorIdentityLookups[vm.commit.hash] ?? {
            cacheState: "miss",
            refreshState: "in-flight"
          }
        ) ?? undefined}
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
    setCommitMenu({ hash: vm.commit.hash, ...position });
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

  // Selecting a worktree takes you to its HEAD: center it and flash it. Also
  // re-centers when HEAD itself moves (commit, pull, switch branch).
  useEffect(() => {
    if (head === "") return;
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
        schedulePublish();
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
      // view publishes its replacement after its own quiet period.
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

  return (
    <>
      <div className="graph-toolbar">
        <span className="graph-toolbar__label">Lineage</span>
        <span style={{ flex: 1 }} />
        <span className="graph-branches-wrap">
          <button
            className="graph-branches"
            aria-haspopup="menu"
            aria-expanded={branchesOpen}
            title="Branches drawn in this graph — click one to jump to its tip"
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
              <div className="branch-pop" role="menu">
                {(data?.shownBranches ?? []).map((name) => {
                  const tipHash = tipByName.get(name);
                  const vm =
                    tipHash !== undefined ? vmByHash.get(tipHash) : undefined;
                  return (
                    <button
                      key={name}
                      className="branch-pop__item"
                      role="menuitem"
                      disabled={vm === undefined}
                      title={
                        vm === undefined
                          ? "Tip is outside the loaded window"
                          : `Jump to ${name}`
                      }
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
            title="Scroll to this worktree's current commit (HEAD)"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="12" cy="12" r="7" />
              <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
            </svg>
            You are here
          </button>
        )}
        <button
          className={`only-me${scope === "active" ? " is-on" : ""}`}
          title={
            scope === "active"
              ? "Showing your active, unmerged branches. Click to show all branches."
              : "Showing all branches. Click to show only active ones."
          }
          onClick={() => {
            scopeTouchedRef.current = true;
            setScope((s) => (s === "active" ? "all" : "active"));
          }}
        >
          <span className="only-me__dot" />
          {scope === "active" ? "Active" : "All branches"}
        </button>
      </div>

      <div className="graph-scroll" ref={scrollerRef}>
        {laneOverflow && vms.length > 0 && (
          <div
            className="lane-scrollbar"
            ref={laneBarRef}
            title="Scroll the lane gutter — commits stay put"
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
                onToggle={() => onToggleCommit(vm.commit.hash)}
                onOpen={() => onOpenCommit(vm.commit.hash, vm.commit.subject)}
                onShowContext={(target, anchor) =>
                  showCommitContext(target, anchor, vm)
                }
                onHideContext={commitContext.scheduleHide}
                onFocusContext={commitContext.focusFirst}
                onOpenContextMenu={(position) => openCommitMenu(vm, position)}
                onRevealWorktree={onRevealWorktree}
              />
            ))}
          </div>
        ) : (
          <div className="graph-empty">
            {loading
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
      {commitMenu !== null && menuVm !== undefined && (
        <CommitContextMenu
          x={commitMenu.x}
          y={commitMenu.y}
          vm={menuVm}
          branchInfo={data?.branches ?? {}}
          viewingBranch={viewingBranch}
          onViewChanges={() =>
            onOpenCommit(menuVm.commit.hash, menuVm.commit.subject)
          }
          onClose={() => setCommitMenu(null)}
        />
      )}
    </>
  );
}
