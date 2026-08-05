import type { Commit, PrSummary } from "@pwrgit/shared";
import { describe, expect, it } from "vitest";
import { layoutLanes } from "./lane-layout";
import { findPrLandingLinks, layoutPrLandingLinks } from "./pr-landings";

const commit = (hash: string, ...parents: string[]): Commit => ({
  hash,
  shortHash: hash,
  parents,
  subject: hash,
  authorName: "A",
  authorEmail: "a@example.test",
  committedAt: "2026-08-05T00:00:00.000Z",
  isMerge: parents.length > 1
});

const merged = (number: number): PrSummary => ({
  number,
  url: `https://example.test/${number}`,
  title: `PR ${number}`,
  state: "merged",
  isDraft: false
});

describe("rewritten PR landings", () => {
  it("links a squash result to the unmodified source tip", () => {
    const commits = [
      commit("S", "B"),
      commit("H", "F", "B"),
      commit("F", "A"),
      commit("B", "A"),
      commit("A")
    ];
    expect(
      findPrLandingLinks(
        commits,
        { S: ["main"], H: ["feature"] },
        {},
        "main",
        [],
        { S: merged(1), H: merged(1) }
      )
    ).toEqual([{ number: 1, landingHash: "S", sourceHash: "H" }]);
  });

  it("does not duplicate the real second-parent edge of a merge commit", () => {
    const commits = [commit("M", "B", "H"), commit("H", "B"), commit("B")];
    expect(
      findPrLandingLinks(
        commits,
        { M: ["main"], H: ["feature"] },
        {},
        "main",
        ["M"],
        { M: merged(2), H: merged(2) }
      )
    ).toEqual([]);
  });

  it("starts at a remote default tip when local main is behind", () => {
    const commits = [
      commit("R", "L"),
      commit("H", "F", "L"),
      commit("F", "B"),
      commit("L", "B"),
      commit("B")
    ];
    expect(
      findPrLandingLinks(
        commits,
        { L: ["main"], H: ["feature"] },
        {},
        "main",
        ["R"],
        { R: merged(3), H: merged(3) }
      )
    ).toEqual([{ number: 3, landingHash: "R", sourceHash: "H" }]);
  });

  it("starts at the resolved remote default tip when local main is absent", () => {
    const commits = [commit("R", "B"), commit("H", "B"), commit("B")];
    expect(
      findPrLandingLinks(
        commits,
        { H: ["feature"] },
        {},
        "main",
        ["R"],
        { R: merged(4), H: merged(4) }
      )
    ).toEqual([{ number: 4, landingHash: "R", sourceHash: "H" }]);
  });

  it("links a squash result to a remote-only source tip", () => {
    const commits = [
      commit("S", "B"),
      commit("H", "F"),
      commit("F", "B"),
      commit("B")
    ];
    expect(
      findPrLandingLinks(
        commits,
        { S: ["main"] },
        { H: ["origin/feature"] },
        "main",
        [],
        { S: merged(5), H: merged(5) }
      )
    ).toEqual([{ number: 5, landingHash: "S", sourceHash: "H" }]);
  });

  it("routes a dotted rail through every intervening row", () => {
    const commits = [commit("S", "B"), commit("X", "B"), commit("H", "B"), commit("B")];
    const layout = layoutLanes(commits.map(({ hash, parents }) => ({ hash, parents })));
    const routed = layoutPrLandingLinks(
      [{ number: 7, landingHash: "S", sourceHash: "H" }],
      commits,
      layout
    );

    expect(routed.laneCount).toBe(layout.laneCount);
    expect(routed.rows[0]?.bottom).toHaveLength(1);
    expect(routed.rows[1]?.top).toHaveLength(1);
    expect(routed.rows[1]?.bottom).toHaveLength(1);
    expect(routed.rows[2]?.top).toHaveLength(1);
  });

  it("allocates an outer rail when every existing lane is blocked", () => {
    const commits = [commit("S", "B"), commit("X", "B"), commit("H", "B")];
    const bothLanes = [
      { from: 0, to: 0 },
      { from: 1, to: 1 }
    ];
    const layout = {
      laneCount: 2,
      rows: [
        { lane: 0, top: [], bottom: bothLanes },
        { lane: 0, top: bothLanes, bottom: bothLanes },
        { lane: 1, top: bothLanes, bottom: [] }
      ]
    };
    const routed = layoutPrLandingLinks(
      [{ number: 8, landingHash: "S", sourceHash: "H" }],
      commits,
      layout
    );

    expect(routed.laneCount).toBe(3);
    expect(routed.rows[0]?.bottom).toEqual([{ from: 0, to: 2, number: 8 }]);
    expect(routed.rows[2]?.top).toEqual([{ from: 2, to: 1, number: 8 }]);
  });

  it("uses the clear source lane instead of a distant global outer rail", () => {
    const commits = [
      commit("S", "B"),
      commit("X4", "B"),
      commit("X3", "B"),
      commit("X2", "B"),
      commit("X1", "B"),
      commit("H", "B"),
      commit("B")
    ];
    const main = { from: 0, to: 0 };
    const layout = {
      // Other history needed seven lanes, but only main occupies this interval.
      laneCount: 7,
      rows: commits.map((_, row) => ({
        lane: row === 5 ? 1 : 0,
        top: row === 0 ? [] : [{ ...main }],
        bottom: row === 5 ? [{ from: 1, to: 0 }] : [{ ...main }]
      }))
    };
    const routed = layoutPrLandingLinks(
      [{ number: 10, landingHash: "S", sourceHash: "H" }],
      commits,
      layout
    );

    expect(routed.laneCount).toBe(layout.laneCount);
    expect(routed.rows[0]?.bottom).toEqual([{ from: 0, to: 1, number: 10 }]);
    for (let row = 1; row < 5; row += 1) {
      expect(routed.rows[row]?.top).toEqual([{ from: 1, to: 1, number: 10 }]);
      expect(routed.rows[row]?.bottom).toEqual([{ from: 1, to: 1, number: 10 }]);
    }
    expect(routed.rows[5]?.top).toEqual([{ from: 1, to: 1, number: 10 }]);
  });

  it("connects adjacent landing rows directly without allocating a rail", () => {
    const commits = [commit("S", "B"), commit("H", "B"), commit("B")];
    const layout = layoutLanes(commits.map(({ hash, parents }) => ({ hash, parents })));
    const routed = layoutPrLandingLinks(
      [{ number: 8, landingHash: "S", sourceHash: "H" }],
      commits,
      layout
    );

    expect(routed.laneCount).toBe(layout.laneCount);
    expect(routed.rows[0]?.bottom).toEqual([
      { from: 0, to: 0.5, number: 8 }
    ]);
    expect(routed.rows[1]?.top).toEqual([
      { from: 0.5, to: 1, number: 8 }
    ]);
  });
});
