// Assign commits to lanes for a compact multi-branch graph, à la `git log
// --graph`. Pure + deterministic so it's unit-testable. Commits arrive in
// topological order (newest first, every commit before its parents).
//
// The sweep tracks, per lane, the hash that lane is "flowing toward" (the next
// commit expected in it) and the branch that owns the line. A commit normally
// continues the lowest incoming lane owned by ITS OWN branch. At a strictly
// linear boundary between two non-default branches, a lone incoming lane hands
// off ownership in place, so stacked refs share one ancestry train instead of
// zig-zagging between columns. A real fork still has multiple incoming lanes;
// the owner-matched lane continues and the others converge. The default branch
// never inherits a foreign lane: lane 0 begins at its real tip and remains an
// honest spine. Lane 1 is reserved for the worktree's checked-out branch tip;
// its linear ancestor stack may inherit that lane below the tip. Freed lanes
// are reused by later, non-overlapping lines. Each additional parent of a merge
// opens a fresh lane owned by the merged-in branch; those converge naturally at
// the shared ancestor.
//
// Ownership: each drawn branch claims the commits on its first-parent chain —
// default branch, then the head branch, then shown order (recency). A walk
// stops at commits a higher-priority branch claimed and at other drawn tips.
// The spine's walk starts at the REF the trunk was drawn from (e.g.
// origin/main) when given, so fetched-but-unmerged trunk commits stay on the
// spine's own lane — drawn as one continuous dashed lineage down to the local
// tip, where known-local history starts solid. Without `refs`, every commit is
// unowned and the layout degrades to the plain parent-driven sweep.

export type LaneCommit = { hash: string; parents: string[] };

/** Ref context that lets lanes follow branches instead of raw parent chains. */
export type LaneRefs = {
  /** commit hash → branch names tipped there (local, plus drawn remotes). */
  tips: Record<string, string[]>;
  defaultBranch: string;
  /** Tips of each remote's copy of the default branch (origin/main, …). */
  defaultRefTips?: string[] | undefined;
  /** The branch checked out in the viewing worktree — pinned to lane 1. */
  headBranch?: string | undefined;
  /** Branches drawn besides the default spine (most recent first). */
  shownBranches: string[];
};

/** A drawn segment within a row cell: `from` lane at one edge → `to` lane at the
 *  row's vertical center (top half), or center → `to` at the bottom edge.
 *  `dashed` marks a lineage originating in remote trunk history the local
 *  default branch hasn't applied yet. The value is the remote tier (1 =
 *  closest remote, 2 = the next remote out, …); once dashed, a continuous
 *  lane inherits the strongest pattern it has seen until the local tip starts
 *  the known-local, solid portion of that spine. */
export type LaneSeg = { from: number; to: number; dashed?: number };

export type LaneRow = {
  /** Column the commit's dot sits in. */
  lane: number;
  /** Lines in the top half: each active lane above → the dot or straight down. */
  top: LaneSeg[];
  /** Lines in the bottom half: the dot → each parent lane, or straight-through. */
  bottom: LaneSeg[];
};

export type LaneLayout = {
  rows: LaneRow[];
  /** Total lane columns used anywhere (gutter width). */
  laneCount: number;
};

const seg = (from: number, to: number, tier: number): LaneSeg =>
  tier > 0 ? { from, to, dashed: tier } : { from, to };

/** commit hash → drawn branch owning it, via prioritized first-parent walks. */
function computeOwners(
  byHash: Map<string, LaneCommit>,
  refs: LaneRefs
): {
  owners: Map<string, string>;
  tipOf: Map<string, string>;
  /** Where the spine's walk starts: the newest remote default tip the local
   *  tip descends from (that whole stretch is ONE line), else the local tip.
   *  A diverged remote's segment stays an anonymous side line instead. */
  spineStart: string | undefined;
} {
  const priority = [refs.defaultBranch];
  if (refs.headBranch !== undefined) priority.push(refs.headBranch);
  const drawn = [...new Set([...priority, ...refs.shownBranches])];
  const drawnSet = new Set(drawn);
  const tipOf = new Map<string, string>();
  const drawnTips = new Set<string>();
  for (const [hash, names] of Object.entries(refs.tips)) {
    for (const n of names) {
      if (!drawnSet.has(n)) continue;
      tipOf.set(n, hash);
      drawnTips.add(hash);
    }
  }

  const localTip = tipOf.get(refs.defaultBranch);
  let spineStart: string | undefined;
  const candidates = new Set(
    (refs.defaultRefTips ?? []).filter((h) => byHash.has(h))
  );
  if (candidates.size > 0) {
    // byHash preserves the commits' topo order — the first candidate wins.
    // A local tip that's fallen OUT of the window (further behind than the
    // trunk cap) counts as descending from any candidate: the drawn trunk is
    // entirely remote history then, and it must still be the owned, pinned
    // spine — not free ground for a feature branch's walk to claim.
    const localInWindow = localTip !== undefined && byHash.has(localTip);
    for (const h of byHash.keys()) {
      if (!candidates.has(h)) continue;
      if (!localInWindow || reachable(byHash, h).has(localTip as string)) {
        spineStart = h;
        break;
      }
    }
  }
  spineStart ??= localTip;

  const owners = new Map<string, string>();
  for (const b of drawn) {
    const start = b === refs.defaultBranch ? spineStart : tipOf.get(b);
    let cur = start;
    while (cur !== undefined) {
      const commit = byHash.get(cur);
      if (commit === undefined) break; // outside the loaded window
      if (owners.has(cur)) break; // a higher-priority branch's history
      // Another drawn branch's tip is an ownership boundary. Layout may hand a
      // conflict-free lane across it later, but ownership remains distinct so
      // genuine forks still choose the correct continuing path. (The default
      // branch may claim through a plain trunk-history tip.)
      if (b !== refs.defaultBranch && cur !== start && drawnTips.has(cur)) break;
      owners.set(cur, b);
      cur = commit.parents[0];
    }
  }
  return { owners, tipOf, spineStart };
}

/** Every in-window commit reachable from `start` through any parent link. */
function reachable(
  byHash: Map<string, LaneCommit>,
  start: string | undefined
): Set<string> {
  const seen = new Set<string>();
  if (start === undefined) return seen;
  const stack = [start];
  while (stack.length > 0) {
    const h = stack.pop() as string;
    if (seen.has(h)) continue;
    const commit = byHash.get(h);
    if (commit === undefined) continue;
    seen.add(h);
    for (const p of commit.parents) stack.push(p);
  }
  return seen;
}

export function layoutLanes(commits: LaneCommit[], refs?: LaneRefs): LaneLayout {
  const byHash = new Map(commits.map((c) => [c.hash, c]));
  const { owners, tipOf, spineStart } =
    refs === undefined
      ? {
          owners: new Map<string, string>(),
          tipOf: new Map<string, string>(),
          spineStart: undefined
        }
      : computeOwners(byHash, refs);
  const localTip =
    refs === undefined ? undefined : tipOf.get(refs.defaultBranch);

  // Trunk commits fetched but not yet in the local default branch (from ANY
  // remote's copy of it) seed a dashed spine. Each commit carries the TIER of
  // the closest remote that has it — remotes ranked nearest-to-local first
  // (older tip = later in topo order) — so an upstream-only stretch can use a
  // different pattern. The strongest dash is inherited within the remote-only
  // stretch, then explicitly ends at the local tip so known-local history does
  // not become dashed when the loaded window continues farther back.
  const dashSeeds = new Map<string, number>();
  if (refs !== undefined) {
    const remoteTips = (refs.defaultRefTips ?? []).filter(
      (h) => byHash.has(h) && h !== localTip
    );
    if (remoteTips.length > 0 && localTip !== undefined) {
      const topoIndex = new Map(commits.map((c, i) => [c.hash, i]));
      remoteTips.sort(
        (a, b) => (topoIndex.get(b) ?? 0) - (topoIndex.get(a) ?? 0)
      );
      const applied = reachable(byHash, localTip);
      remoteTips.forEach((rt, i) => {
        for (const h of reachable(byHash, rt)) {
          if (!applied.has(h) && !dashSeeds.has(h)) dashSeeds.set(h, i + 1);
        }
      });
    }
  }

  // Pin lane 0 to the trunk while its tip is drawn — the spine stays leftmost
  // even when newer branches (processed first) open their lanes — and lane 1
  // to the worktree's checked-out branch so "your" line reads second. The
  // head pin requires the branch to actually OWN its tip: a branch sitting
  // exactly on the trunk (or inside it) has no line, and reserving a column
  // for it would leave a phantom empty lane. Linear ancestor branches may
  // inherit lane 1 after the head tip; they never overlap it vertically.
  const laneReservedFor: (string | undefined)[] = [];
  if (spineStart !== undefined && byHash.has(spineStart)) {
    laneReservedFor[0] = refs?.defaultBranch;
    const head = refs?.headBranch;
    const headTip = head === undefined ? undefined : tipOf.get(head);
    if (
      head !== undefined &&
      head !== refs?.defaultBranch &&
      headTip !== undefined &&
      owners.get(headTip) === head
    ) {
      laneReservedFor[1] = head;
    }
  }
  // Lowest lane this owner may use: free, and not reserved for someone else.
  const firstFreeFor = (ls: (string | null)[], o: string | null): number => {
    for (let i = 0; ; i += 1) {
      const r = laneReservedFor[i];
      if (r !== undefined && r !== o) continue;
      if (i >= ls.length || ls[i] === null) return i;
    }
  };

  let lanes: (string | null)[] = [];
  let laneOwner: (string | null)[] = [];
  let laneDashed: number[] = [];
  const rows: LaneRow[] = [];
  let laneCount = 0;

  for (const c of commits) {
    const before = lanes;
    const co = owners.get(c.hash) ?? null;
    const incoming: number[] = [];
    for (let k = 0; k < before.length; k += 1) {
      if (before[k] === c.hash) incoming.push(k);
    }
    // Prefer this branch's own incoming lane. With no such lane, a single
    // foreign arrival at an unreserved non-default tip is a conflict-free
    // linear ownership handoff; inherit it in place. The checked-out tip must
    // still bend into reserved lane 1. Multiple arrivals represent a real fork
    // and must converge into a separately selected owner lane.
    const continuable = incoming.filter((k) => laneOwner[k] === co);
    const inheritedLane =
      continuable.length === 0 &&
      incoming.length === 1 &&
      co !== null &&
      co !== refs?.defaultBranch &&
      co !== refs?.headBranch
        ? incoming[0]
        : undefined;
    const myLane =
      continuable.length > 0
        ? Math.min(...continuable)
        : (inheritedLane ?? firstFreeFor(before, co));

    // Top half: every lane entering this row from above.
    const top: LaneSeg[] = [];
    for (let k = 0; k < before.length; k += 1) {
      if (before[k] === null) continue;
      top.push(seg(k, before[k] === c.hash ? myLane : k, laneDashed[k] ?? 0));
    }

    // Advance to the post-commit lane state.
    const work = [...before];
    const workOwner = [...laneOwner];
    const workDashed = [...laneDashed];
    while (work.length <= myLane) {
      work.push(null);
      workOwner.push(null);
      workDashed.push(0);
    }
    for (const k of incoming) {
      if (k !== myLane) {
        work[k] = null;
        workOwner[k] = null;
        workDashed[k] = 0;
      }
    }

    const fromDot = new Set<number>();
    const seedDash = dashSeeds.get(c.hash) ?? 0;
    // The edge arriving at the local tip still belongs to remote-only history,
    // but every edge leaving that dot is known to be reachable from local main.
    const dashedOut =
      c.hash === localTip
        ? 0
        : Math.max(seedDash, laneDashed[myLane] ?? 0);
    if (c.parents.length === 0) {
      work[myLane] = null;
      workOwner[myLane] = null;
      workDashed[myLane] = 0;
    } else {
      work[myLane] = c.parents[0] ?? null;
      workOwner[myLane] = co;
      workDashed[myLane] = dashedOut;
      fromDot.add(myLane);
      for (const p of c.parents.slice(1)) {
        const po = owners.get(p) ?? null;
        const lane = firstFreeFor(work, po);
        while (work.length <= lane) {
          work.push(null);
          workOwner.push(null);
          workDashed.push(0);
        }
        work[lane] = p;
        workOwner[lane] = po;
        // A merge's side lineage is a different lane/color. Seed it from its
        // own parent, never from dash state carried by the continuing lane.
        workDashed[lane] = dashSeeds.get(p) ?? 0;
        fromDot.add(lane);
      }
    }
    while (work.length > 0 && work[work.length - 1] === null) {
      work.pop();
      workOwner.pop();
      workDashed.pop();
    }

    // Bottom half: every lane leaving this row toward a parent.
    const bottom: LaneSeg[] = [];
    for (let k = 0; k < work.length; k += 1) {
      if (work[k] === null) continue;
      bottom.push(seg(fromDot.has(k) ? myLane : k, k, workDashed[k] ?? 0));
    }

    rows.push({ lane: myLane, top, bottom });
    laneCount = Math.max(laneCount, before.length, work.length, myLane + 1);
    lanes = work;
    laneOwner = workOwner;
    laneDashed = workDashed;
  }

  return { rows, laneCount };
}
