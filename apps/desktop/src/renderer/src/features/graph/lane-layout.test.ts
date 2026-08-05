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

describe("layoutLanes with refs (branch-owned lanes)", () => {
  it("ends the spine at the default tip when a branch stacks on it", () => {
    // feat (X2..X1) builds directly on main's tip M. main's line must top out
    // at M — feat gets its own lane converging into M's dot, instead of one
    // continuous lane that makes M look like mid-branch history.
    const { rows, laneCount } = layoutLanes(
      [c("X2", "X1"), c("X1", "M"), c("M", "M1"), c("M1")],
      {
        tips: { X2: ["feat"], M: ["main"] },
        defaultBranch: "main",
        shownBranches: ["feat"]
      }
    );
    const lanes = Object.fromEntries(
      rows.map((r, i) => [["X2", "X1", "M", "M1"][i], r.lane])
    );
    // Lane 0 stays reserved for the spine; feat rides lane 1 above it.
    expect(lanes).toEqual({ X2: 1, X1: 1, M: 0, M1: 0 });
    // feat's line curves into M's dot and ends there…
    expect(rows[2].top).toEqual([{ from: 1, to: 0 }]);
    // …and the spine continues below M on its own lane.
    expect(rows[2].bottom).toEqual([{ from: 0, to: 0 }]);
    expect(laneCount).toBe(2);
  });

  it("gives a branch stacked on another branch's tip its own lane", () => {
    // c2 (C2..C1) builds on d's tip D, which builds on main's tip M.
    const { rows } = layoutLanes(
      [c("C2", "C1"), c("C1", "D"), c("D", "M"), c("M", "M1"), c("M1")],
      {
        tips: { C2: ["c2"], D: ["d"], M: ["main"] },
        defaultBranch: "main",
        shownBranches: ["c2", "d"]
      }
    );
    const lanes = Object.fromEntries(
      rows.map((r, i) => [["C2", "C1", "D", "M", "M1"][i], r.lane])
    );
    // Three distinct lines: c2's lane ends at D's dot, d's lane ends at M's.
    expect(lanes.C2).toBe(lanes.C1);
    expect(lanes.D).not.toBe(lanes.C1);
    expect(lanes).toMatchObject({ M: 0, M1: 0 });
    const dRow = rows[2];
    expect(dRow.top).toEqual([{ from: lanes.C1, to: lanes.D }]);
    const mRow = rows[3];
    expect(mRow.top).toEqual([{ from: lanes.D, to: 0 }]);
  });

  it("still converges a fork-point branch into the spine", () => {
    // feat forks from mid-trunk B — unchanged convergence, but feat can't
    // occupy the reserved spine lane even though it's processed first.
    const { rows } = layoutLanes(
      [c("F", "B"), c("T", "B"), c("B", "A"), c("A")],
      {
        tips: { F: ["feat"], T: ["main"] },
        defaultBranch: "main",
        shownBranches: ["feat"]
      }
    );
    const lanes = Object.fromEntries(
      rows.map((r, i) => [["F", "T", "B", "A"][i], r.lane])
    );
    expect(lanes).toEqual({ F: 1, T: 0, B: 0, A: 0 });
    expect(rows[2].top).toEqual(
      expect.arrayContaining([
        { from: 0, to: 0 },
        { from: 1, to: 0 }
      ])
    );
  });

  it("keeps the spine continuous through a tip that is plain trunk history", () => {
    // old's tip A is an ancestor of main's tip — it renders as a chip on the
    // spine, not a separate line breaking the trunk.
    const { rows, laneCount } = layoutLanes(
      [c("M", "A"), c("A", "R"), c("R")],
      {
        tips: { M: ["main"], A: ["old"] },
        defaultBranch: "main",
        shownBranches: ["old"]
      }
    );
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0]);
    expect(laneCount).toBe(1);
  });

  it("keeps merge fan-out off the reserved spine lane", () => {
    // A trunk merge's second-parent connector opens to the right of the spine
    // and converges back at the shared ancestor.
    const { rows } = layoutLanes(
      [c("M", "P1", "P2"), c("P1", "R"), c("P2", "R"), c("R")],
      { tips: { M: ["main"] }, defaultBranch: "main", shownBranches: [] }
    );
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 1, 0]);
    expect(rows[0].bottom).toEqual(
      expect.arrayContaining([
        { from: 0, to: 0 },
        { from: 0, to: 1 }
      ])
    );
  });

  it("pins the checked-out branch to lane 1, ahead of newer branches", () => {
    // n is more recent than head branch h — without the pin it would grab the
    // lane next to the spine. h forked from T2, n from main's tip T1.
    const { rows } = layoutLanes(
      [c("N1", "T1"), c("H1", "T2"), c("T1", "T2"), c("T2")],
      {
        tips: { N1: ["n"], H1: ["h"], T1: ["main"] },
        defaultBranch: "main",
        headBranch: "h",
        shownBranches: ["n", "h"]
      }
    );
    const lanes = Object.fromEntries(
      rows.map((r, i) => [["N1", "H1", "T1", "T2"][i], r.lane])
    );
    expect(lanes).toEqual({ N1: 2, H1: 1, T1: 0, T2: 0 });
  });

  it("keeps the checked-out branch on lane 1 even when stacked on another branch", () => {
    // h builds on d's tip; its line converges into D's dot, so the lanes never
    // overlap vertically and h can still sit second, with d further right.
    const { rows } = layoutLanes(
      [c("H1", "D"), c("D", "M"), c("M")],
      {
        tips: { H1: ["h"], D: ["d"], M: ["main"] },
        defaultBranch: "main",
        headBranch: "h",
        shownBranches: ["h", "d"]
      }
    );
    const lanes = Object.fromEntries(
      rows.map((r, i) => [["H1", "D", "M"][i], r.lane])
    );
    expect(lanes).toEqual({ H1: 1, D: 2, M: 0 });
    // h's line ends at D's dot; d's line ends at M's dot.
    expect(rows[1].top).toEqual([{ from: 1, to: 2 }]);
    expect(rows[2].top).toEqual([{ from: 2, to: 0 }]);
  });

  it("keeps a remote-ahead trunk dashed along the same spine lane", () => {
    // origin/main (R2..R1) is ahead of local main (L). One lane-0 line — the
    // remote stretch seeds a dash that the continuous lineage retains.
    const { rows, laneCount } = layoutLanes(
      [c("R2", "R1"), c("R1", "L"), c("L", "L1"), c("L1")],
      {
        tips: { L: ["main"] },
        defaultBranch: "main",
        defaultRefTips: ["R2"],
        shownBranches: []
      }
    );
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0, 0]);
    expect(laneCount).toBe(1);
    expect(rows[0].bottom).toEqual([{ from: 0, to: 0, dashed: 1 }]);
    expect(rows[1].top).toEqual([{ from: 0, to: 0, dashed: 1 }]);
    expect(rows[1].bottom).toEqual([{ from: 0, to: 0, dashed: 1 }]);
    // Crossing the local tip does not change the style of the same-color lane.
    expect(rows[2].top).toEqual([{ from: 0, to: 0, dashed: 1 }]);
    expect(rows[2].bottom).toEqual([{ from: 0, to: 0, dashed: 1 }]);
    expect(rows[3].top).toEqual([{ from: 0, to: 0, dashed: 1 }]);
  });

  it("keeps branch lines solid alongside a dashed remote-ahead spine", () => {
    // feat forked from local main's tip L; its separate line stays solid while
    // the remote-originated spine remains dashed through L.
    const { rows } = layoutLanes(
      [c("R", "L"), c("F", "L"), c("L", "L1"), c("L1")],
      {
        tips: { L: ["main"], F: ["feat"] },
        defaultBranch: "main",
        defaultRefTips: ["R"],
        shownBranches: ["feat"]
      }
    );
    const lanes = Object.fromEntries(
      rows.map((r, i) => [["R", "F", "L", "L1"][i], r.lane])
    );
    expect(lanes).toEqual({ R: 0, F: 1, L: 0, L1: 0 });
    // At L: the spine arrives dashed, feat arrives solid, and both converge.
    expect(rows[2].top).toEqual(
      expect.arrayContaining([
        { from: 0, to: 0, dashed: 1 },
        { from: 1, to: 0 }
      ])
    );
    expect(rows[2].bottom).toEqual([{ from: 0, to: 0, dashed: 1 }]);
  });

  it("chains multiple remote default tips into one dashed spine", () => {
    // Fork workflow: upstream/main (U) ahead of origin/main (O) ahead of
    // local main (L) — one lane-0 line whose dash remains continuous past L.
    const { rows, laneCount } = layoutLanes(
      [c("U", "O"), c("O", "L"), c("L", "L1"), c("L1")],
      {
        tips: { L: ["main"] },
        defaultBranch: "main",
        defaultRefTips: ["U", "O"],
        shownBranches: []
      }
    );
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0, 0]);
    expect(laneCount).toBe(1);
    // Tier per stretch: upstream-only history dash-dots (2), origin's plain
    // dashes (1), and each pattern boundary sits on a tip's dot.
    expect(rows[0].bottom).toEqual([{ from: 0, to: 0, dashed: 2 }]);
    expect(rows[1].top).toEqual([{ from: 0, to: 0, dashed: 2 }]);
    expect(rows[1].bottom).toEqual([{ from: 0, to: 0, dashed: 1 }]);
    expect(rows[2].top).toEqual([{ from: 0, to: 0, dashed: 1 }]);
    expect(rows[2].bottom).toEqual([{ from: 0, to: 0, dashed: 1 }]);
  });

  it("keeps a diverged remote off the spine lane, as a dashed side line", () => {
    // Local main gained a commit while origin/main did too: origin's segment
    // can't be the top of the spine — it rides its own lane, dashed, and
    // converges at the shared base. Local main keeps lane 0.
    const { rows } = layoutLanes(
      [c("R", "B"), c("L", "B"), c("B", "B1"), c("B1")],
      {
        tips: { L: ["main"] },
        defaultBranch: "main",
        defaultRefTips: ["R"],
        shownBranches: []
      }
    );
    const lanes = Object.fromEntries(
      rows.map((r, i) => [["R", "L", "B", "B1"][i], r.lane])
    );
    expect(lanes).toEqual({ R: 1, L: 0, B: 0, B1: 0 });
    expect(rows[0].bottom).toEqual([{ from: 1, to: 1, dashed: 1 }]);
    expect(rows[2].top).toEqual(
      expect.arrayContaining([
        { from: 0, to: 0 },
        { from: 1, to: 0, dashed: 1 }
      ])
    );
  });

  it("keeps the spine owned and pinned when local main is behind the window", () => {
    // Local main's tip fell off the bottom of the trunk window (>cap behind
    // origin/main). The drawn trunk is entirely remote history — it must
    // still be the lane-0 spine, all dashed, with feat converging into it,
    // NOT free ground for feat's ownership walk to claim.
    const { rows } = layoutLanes(
      [c("F", "R2"), c("R3", "R2"), c("R2", "R1"), c("R1", "Lout")],
      {
        tips: { F: ["feat"], Lout: ["main"] }, // main's tip is off-window
        defaultBranch: "main",
        defaultRefTips: ["R3"],
        shownBranches: ["feat"]
      }
    );
    const lanes = Object.fromEntries(
      rows.map((r, i) => [["F", "R3", "R2", "R1"][i], r.lane])
    );
    expect(lanes).toEqual({ F: 1, R3: 0, R2: 0, R1: 0 });
    // The whole drawn trunk is unapplied: dashed, one lane-0 line (feat's
    // solid lane-1 line passes through R3's row on the way to its fork)…
    expect(rows[1].bottom).toEqual(
      expect.arrayContaining([
        { from: 0, to: 0, dashed: 1 },
        { from: 1, to: 1 }
      ])
    );
    expect(rows[3].bottom).toEqual([{ from: 0, to: 0, dashed: 1 }]);
    // …and feat converges into it (solid) instead of continuing through it.
    expect(rows[2].top).toEqual(
      expect.arrayContaining([
        { from: 0, to: 0, dashed: 1 },
        { from: 1, to: 0 }
      ])
    );
  });

  it("doesn't reserve lane 1 for a checked-out branch with no line of its own", () => {
    // mine sits exactly on main's tip (fresh branch, no commits): it has no
    // line, so feat gets lane 1 instead of leaving a phantom empty column.
    const { rows, laneCount } = layoutLanes(
      [c("F1", "M"), c("M", "M1"), c("M1")],
      {
        tips: { F1: ["feat"], M: ["main", "mine"] },
        defaultBranch: "main",
        headBranch: "mine",
        shownBranches: ["feat"]
      }
    );
    const lanes = Object.fromEntries(
      rows.map((r, i) => [["F1", "M", "M1"][i], r.lane])
    );
    expect(lanes).toEqual({ F1: 1, M: 0, M1: 0 });
    expect(laneCount).toBe(2);
  });

  it("skips the reservation when the default tip is outside the window", () => {
    // No spine drawn → nothing to protect; lane 0 goes to the first tip.
    const { rows, laneCount } = layoutLanes([c("F2", "F1"), c("F1", "B")], {
      tips: { F2: ["feat"] },
      defaultBranch: "main",
      shownBranches: ["feat"]
    });
    expect(rows.map((r) => r.lane)).toEqual([0, 0]);
    expect(laneCount).toBe(1);
  });
});
