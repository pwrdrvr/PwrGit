// Assign commits to lanes for a compact multi-branch graph, à la `git log
// --graph`. Pure + deterministic so it's unit-testable. Commits arrive in
// topological order (newest first, every commit before its parents).
//
// The sweep tracks, per lane, the hash that lane is "flowing toward" (the next
// commit expected in it). A commit takes the lowest lane already pointing at it
// (several lanes pointing at one commit converge — that's a merge point); a new
// tip with no incoming lane grabs the lowest FREE lane, so lanes are reused once
// a branch ends and doesn't overlap a later one. Each additional parent of a
// merge opens a fresh lane; those converge naturally at the shared ancestor.

export type LaneCommit = { hash: string; parents: string[] };

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

const firstFree = (lanes: (string | null)[]): number => {
  const i = lanes.indexOf(null);
  return i === -1 ? lanes.length : i;
};

export function layoutLanes(commits: LaneCommit[]): LaneLayout {
  let lanes: (string | null)[] = [];
  const rows: LaneRow[] = [];
  let laneCount = 0;

  for (const c of commits) {
    const before = lanes;
    const incoming: number[] = [];
    for (let k = 0; k < before.length; k += 1) {
      if (before[k] === c.hash) incoming.push(k);
    }
    const myLane = incoming.length > 0 ? Math.min(...incoming) : firstFree(before);

    // Top half: every lane entering this row from above.
    const top: LaneSeg[] = [];
    for (let k = 0; k < before.length; k += 1) {
      if (before[k] === null) continue;
      top.push({ from: k, to: before[k] === c.hash ? myLane : k });
    }

    // Advance to the post-commit lane state.
    const work = [...before];
    while (work.length <= myLane) work.push(null);
    for (const k of incoming) if (k !== myLane) work[k] = null;

    const fromDot = new Set<number>();
    if (c.parents.length === 0) {
      work[myLane] = null;
    } else {
      work[myLane] = c.parents[0] ?? null;
      fromDot.add(myLane);
      for (const p of c.parents.slice(1)) {
        const lane = firstFree(work);
        if (lane >= work.length) work.push(p);
        else work[lane] = p;
        fromDot.add(lane);
      }
    }
    while (work.length > 0 && work[work.length - 1] === null) work.pop();

    // Bottom half: every lane leaving this row toward a parent.
    const bottom: LaneSeg[] = [];
    for (let k = 0; k < work.length; k += 1) {
      if (work[k] === null) continue;
      bottom.push({ from: fromDot.has(k) ? myLane : k, to: k });
    }

    rows.push({ lane: myLane, top, bottom });
    laneCount = Math.max(laneCount, before.length, work.length, myLane + 1);
    lanes = work;
  }

  return { rows, laneCount };
}
