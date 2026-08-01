// Assign commits to lanes for a compact multi-branch graph, à la `git log
// --graph`. Pure + deterministic so it's unit-testable. Commits arrive in
// topological order (newest first, every commit before its parents).
//
// The sweep tracks, per lane, the hash that lane is "flowing toward" (the next
// commit expected in it) and the branch that owns the line. A commit continues
// the lowest incoming lane owned by ITS OWN branch; incoming lanes owned by a
// different branch converge into the dot and end there — a lane never spans
// two branches, so a branch's HEAD is always the top terminus of its line (a
// branch stacked on another branch's tip gets its own lane rather than making
// the tip look mid-line). A commit with no continuable lane opens the lowest
// free lane, subject to pinning: lane 0 is reserved for the default-branch
// spine while its tip is in the window, and lane 1 for the worktree's
// checked-out branch when that branch has a line of its own (its line never
// overlaps its base branch's line — the stack converges into the base's tip —
// so it can always sit second). Freed lanes are still reused by later,
// non-overlapping lines. Each additional parent of a merge opens a fresh lane
// owned by the merged-in branch; those converge naturally at the shared
// ancestor.
//
// Ownership: each drawn branch claims the commits on its first-parent chain —
// default branch, then the head branch, then shown order (recency). A walk
// stops at commits a higher-priority branch claimed and at other drawn tips.
// The spine's walk starts at the REF the trunk was drawn from (e.g.
// origin/main) when given, so fetched-but-unmerged trunk commits stay on the
// spine's own lane — drawn dashed above the local tip rather than as a
// separate anonymous line. Without `refs`, every commit is unowned and the
// layout degrades to the plain parent-driven sweep.

export type LaneCommit = { hash: string; parents: string[] };

/** Ref context that lets lanes follow branches instead of raw parent chains. */
export type LaneRefs = {
  /** commit hash → local branch names tipped there. */
  tips: Record<string, string[]>;
  defaultBranch: string;
  /** Tip hash of the ref the trunk was drawn from (e.g. origin/main). */
  defaultRefTip?: string | undefined;
  /** The branch checked out in the viewing worktree — pinned to lane 1. */
  headBranch?: string | undefined;
  /** Branches drawn besides the default spine (most recent first). */
  shownBranches: string[];
};

/** A drawn segment within a row cell: `from` lane at one edge → `to` lane at the
 *  row's vertical center (top half), or center → `to` at the bottom edge.
 *  `dashed` marks trunk history the local default branch hasn't applied yet. */
export type LaneSeg = { from: number; to: number; dashed?: boolean };

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

const seg = (from: number, to: number, dashed: boolean): LaneSeg =>
  dashed ? { from, to, dashed: true } : { from, to };

/** commit hash → drawn branch owning it, via prioritized first-parent walks. */
function computeOwners(
  byHash: Map<string, LaneCommit>,
  refs: LaneRefs
): {
  owners: Map<string, string>;
  tipOf: Map<string, string>;
  /** Where the spine's walk starts: the trunk ref's tip when drawn, else the
   *  local default tip. */
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
  const spineStart =
    refs.defaultRefTip !== undefined && byHash.has(refs.defaultRefTip)
      ? refs.defaultRefTip
      : tipOf.get(refs.defaultBranch);

  const owners = new Map<string, string>();
  for (const b of drawn) {
    const start = b === refs.defaultBranch ? spineStart : tipOf.get(b);
    let cur = start;
    while (cur !== undefined) {
      const commit = byHash.get(cur);
      if (commit === undefined) break; // outside the loaded window
      if (owners.has(cur)) break; // a higher-priority branch's history
      // Another drawn branch's tip: that's the top of ITS line — a branch
      // stacked above it must not claim through it. (The default branch may:
      // a tip that is plain trunk history renders as a chip on the spine.)
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

  // Trunk commits fetched but not yet in the local default branch: same spine
  // line, but drawn dashed above the local tip.
  let unapplied = new Set<string>();
  if (refs !== undefined) {
    const localTip = tipOf.get(refs.defaultBranch);
    const remoteTip = refs.defaultRefTip;
    if (
      remoteTip !== undefined &&
      localTip !== undefined &&
      remoteTip !== localTip &&
      byHash.has(remoteTip)
    ) {
      unapplied = reachable(byHash, remoteTip);
      for (const h of reachable(byHash, localTip)) unapplied.delete(h);
    }
  }

  // Pin lane 0 to the trunk while its tip is drawn — the spine stays leftmost
  // even when newer branches (processed first) open their lanes — and lane 1
  // to the worktree's checked-out branch so "your" line reads second. The
  // head pin requires the branch to actually OWN its tip: a branch sitting
  // exactly on the trunk (or inside it) has no line, and reserving a column
  // for it would leave a phantom empty lane.
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
  let laneDashed: boolean[] = [];
  const rows: LaneRow[] = [];
  let laneCount = 0;

  for (const c of commits) {
    const before = lanes;
    const co = owners.get(c.hash) ?? null;
    const incoming: number[] = [];
    for (let k = 0; k < before.length; k += 1) {
      if (before[k] === c.hash) incoming.push(k);
    }
    // Only a lane of this commit's own branch continues through the dot;
    // foreign lanes converge into it and end (drawn below via `top`).
    const continuable = incoming.filter((k) => laneOwner[k] === co);
    const myLane =
      continuable.length > 0
        ? Math.min(...continuable)
        : firstFreeFor(before, co);

    // Top half: every lane entering this row from above.
    const top: LaneSeg[] = [];
    for (let k = 0; k < before.length; k += 1) {
      if (before[k] === null) continue;
      top.push(seg(k, before[k] === c.hash ? myLane : k, laneDashed[k] ?? false));
    }

    // Advance to the post-commit lane state.
    const work = [...before];
    const workOwner = [...laneOwner];
    const workDashed = [...laneDashed];
    while (work.length <= myLane) {
      work.push(null);
      workOwner.push(null);
      workDashed.push(false);
    }
    for (const k of incoming) {
      if (k !== myLane) {
        work[k] = null;
        workOwner[k] = null;
        workDashed[k] = false;
      }
    }

    const fromDot = new Set<number>();
    const dashedOut = unapplied.has(c.hash);
    if (c.parents.length === 0) {
      work[myLane] = null;
      workOwner[myLane] = null;
      workDashed[myLane] = false;
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
          workDashed.push(false);
        }
        work[lane] = p;
        workOwner[lane] = po;
        workDashed[lane] = dashedOut;
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
      bottom.push(seg(fromDot.has(k) ? myLane : k, k, workDashed[k] ?? false));
    }

    rows.push({ lane: myLane, top, bottom });
    laneCount = Math.max(laneCount, before.length, work.length, myLane + 1);
    lanes = work;
    laneOwner = workOwner;
    laneDashed = workDashed;
  }

  return { rows, laneCount };
}
