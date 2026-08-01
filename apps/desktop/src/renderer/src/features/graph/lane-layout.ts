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
// free lane — lane 0 is reserved for the default-branch spine while its tip is
// in the window — so lanes are reused once a line ends and doesn't overlap a
// later one. Each additional parent of a merge opens a fresh lane owned by the
// merged-in branch; those converge naturally at the shared ancestor.
//
// Ownership: each drawn branch claims the commits on its first-parent chain —
// default branch first, then shown order (recency). A walk stops at commits a
// higher-priority branch claimed and at other drawn tips. Without `refs`,
// every commit is unowned and the layout degrades to the plain parent-driven
// sweep (lanes continue through any chain, as before).

export type LaneCommit = { hash: string; parents: string[] };

/** Ref context that lets lanes follow branches instead of raw parent chains. */
export type LaneRefs = {
  /** commit hash → local branch names tipped there. */
  tips: Record<string, string[]>;
  defaultBranch: string;
  /** Branches drawn besides the default spine (most recent first). */
  shownBranches: string[];
};

/** A drawn segment within a row cell: `from` lane at one edge → `to` lane at the
 *  row's vertical center (top half), or center → `to` at the bottom edge. */
export type LaneSeg = { from: number; to: number };

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

const firstFree = (lanes: (string | null)[], min: number): number => {
  for (let i = min; i < lanes.length; i += 1) {
    if (lanes[i] === null) return i;
  }
  return Math.max(lanes.length, min);
};

/** commit hash → drawn branch owning it, via prioritized first-parent walks. */
function computeOwners(
  commits: LaneCommit[],
  refs: LaneRefs
): { owners: Map<string, string>; spineTip: string | undefined } {
  const byHash = new Map(commits.map((c) => [c.hash, c]));
  const drawn = [
    refs.defaultBranch,
    ...refs.shownBranches.filter((b) => b !== refs.defaultBranch)
  ];
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

  const owners = new Map<string, string>();
  for (const b of drawn) {
    const start = tipOf.get(b);
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
  return { owners, spineTip: tipOf.get(refs.defaultBranch) };
}

export function layoutLanes(commits: LaneCommit[], refs?: LaneRefs): LaneLayout {
  const { owners, spineTip } =
    refs === undefined
      ? { owners: new Map<string, string>(), spineTip: undefined }
      : computeOwners(commits, refs);
  // Keep lane 0 for the trunk while its tip is drawn, so the spine stays
  // leftmost even when newer branches (processed first) open their lanes.
  const reserveSpine =
    spineTip !== undefined && commits.some((c) => c.hash === spineTip);
  const minLaneFor = (o: string | null): number =>
    reserveSpine && o !== refs?.defaultBranch ? 1 : 0;

  let lanes: (string | null)[] = [];
  let laneOwner: (string | null)[] = [];
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
        : firstFree(before, minLaneFor(co));

    // Top half: every lane entering this row from above.
    const top: LaneSeg[] = [];
    for (let k = 0; k < before.length; k += 1) {
      if (before[k] === null) continue;
      top.push({ from: k, to: before[k] === c.hash ? myLane : k });
    }

    // Advance to the post-commit lane state.
    const work = [...before];
    const workOwner = [...laneOwner];
    while (work.length <= myLane) {
      work.push(null);
      workOwner.push(null);
    }
    for (const k of incoming) {
      if (k !== myLane) {
        work[k] = null;
        workOwner[k] = null;
      }
    }

    const fromDot = new Set<number>();
    if (c.parents.length === 0) {
      work[myLane] = null;
      workOwner[myLane] = null;
    } else {
      work[myLane] = c.parents[0] ?? null;
      workOwner[myLane] = co;
      fromDot.add(myLane);
      for (const p of c.parents.slice(1)) {
        const po = owners.get(p) ?? null;
        const lane = firstFree(work, minLaneFor(po));
        while (work.length <= lane) {
          work.push(null);
          workOwner.push(null);
        }
        work[lane] = p;
        workOwner[lane] = po;
        fromDot.add(lane);
      }
    }
    while (work.length > 0 && work[work.length - 1] === null) {
      work.pop();
      workOwner.pop();
    }

    // Bottom half: every lane leaving this row toward a parent.
    const bottom: LaneSeg[] = [];
    for (let k = 0; k < work.length; k += 1) {
      if (work[k] === null) continue;
      bottom.push({ from: fromDot.has(k) ? myLane : k, to: k });
    }

    rows.push({ lane: myLane, top, bottom });
    laneCount = Math.max(laneCount, before.length, work.length, myLane + 1);
    lanes = work;
    laneOwner = workOwner;
  }

  return { rows, laneCount };
}
