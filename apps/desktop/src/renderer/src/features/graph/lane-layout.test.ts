import { describe, expect, it } from "vitest";
import { layoutLanes, type LaneCommit } from "./lane-layout";

const c = (hash: string, ...parents: string[]): LaneCommit => ({ hash, parents });

describe("layoutLanes", () => {
  it("keeps linear history in a single lane", () => {
    const { rows, laneCount } = layoutLanes([c("A", "B"), c("B", "C"), c("C")]);
    expect(laneCount).toBe(1);
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0]);
    // Straight line all the way down.
    expect(rows[0].bottom).toEqual([{ from: 0, to: 0 }]);
    expect(rows[2].bottom).toEqual([]); // root: nothing below
  });

  it("puts a second tip in its own lane, converging at the shared base", () => {
    // trunk tip T and feature tip F both fork from base B.
    const { rows, laneCount } = layoutLanes([
      c("T", "B"),
      c("F", "B"),
      c("B", "A"),
      c("A")
    ]);
    expect(laneCount).toBe(2);
    const lanes = Object.fromEntries(
      rows.map((r, i) => [["T", "F", "B", "A"][i], r.lane])
    );
    expect(lanes).toEqual({ T: 0, F: 1, B: 0, A: 0 });
    // At B both lanes arrive (converge): lane 1 bends into lane 0.
    const bRow = rows[2];
    expect(bRow.top).toEqual(
      expect.arrayContaining([
        { from: 0, to: 0 },
        { from: 1, to: 0 }
      ])
    );
  });

  it("opens a lane for a merge's second parent", () => {
    // M is a merge of P1 (first parent) and P2; both trace back to root R.
    const { rows, laneCount } = layoutLanes([
      c("M", "P1", "P2"),
      c("P1", "R"),
      c("P2", "R"),
      c("R")
    ]);
    expect(laneCount).toBe(2);
    expect(rows[0].lane).toBe(0); // merge on lane 0
    // The merge fans out to two lanes below it.
    expect(rows[0].bottom).toEqual(
      expect.arrayContaining([
        { from: 0, to: 0 },
        { from: 0, to: 1 }
      ])
    );
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 1, 0]);
  });

  it("reuses a freed lane for a later, non-overlapping branch", () => {
    // Feature F1 forks and rejoins early; later F2 forks after F1 is done.
    //   T1 (lane0) -> F1 (lane1) converge at B1; then T2 (lane0) -> F2 should
    //   reuse lane1 since F1 no longer occupies it.
    const { rows } = layoutLanes([
      c("T1", "B1"),
      c("F1", "B1"),
      c("B1", "T2"),
      c("T2", "B2"),
      c("F2", "B2"),
      c("B2", "R"),
      c("R")
    ]);
    const byHash = Object.fromEntries(
      rows.map((r, i) => [["T1", "F1", "B1", "T2", "F2", "B2", "R"][i], r.lane])
    );
    expect(byHash.F1).toBe(1);
    expect(byHash.F2).toBe(1); // reused, not lane 2
  });

  it("draws parents that fall outside the window as trailing stubs", () => {
    // C's parent D isn't in the set → lane stays active off the bottom.
    const { rows } = layoutLanes([c("C", "D")]);
    expect(rows[0].bottom).toEqual([{ from: 0, to: 0 }]);
  });
});
