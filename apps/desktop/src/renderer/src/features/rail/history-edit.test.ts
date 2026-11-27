import { describe, expect, it } from "vitest";
import type { RebaseCommitRef } from "@pwrgit/shared";
import {
  ledgerRows,
  squashProgram
} from "./history-edit";

// Newest first, as the graph hands them over: e is the tip.
const commits: RebaseCommitRef[] = ["e", "d", "c", "b", "a"].map((id) => ({
  hash: id.repeat(40),
  subject: `commit ${id}`
}));
const h = (id: string): string => id.repeat(40);

describe("squashProgram", () => {
  it("folds the selection oldest first under the given message", () => {
    expect(squashProgram(commits.slice(0, 2), "msg")).toEqual({
      commits: [{ members: [h("d"), h("e")], message: "msg" }]
    });
  });
});

describe("ledgerRows", () => {
  const proof = { commitCount: 5, resultCount: 2, steps: 5, tree: "4c1f9e0".padEnd(40, "0"), durationMs: 1200 };

  it("knows only the first row before the check", () => {
    expect(ledgerRows(commits, { kind: "idle" })).toEqual([
      { state: "ok", label: "5 commits, each used once", value: "aaaaaaa…eeeeeee" },
      { state: "wait", label: "Code unchanged at the tip", value: "needs replay" },
      { state: "wait", label: "Replays cleanly", value: "not run" }
    ]);
  });

  it("fills in the tree and the replay from the proof", () => {
    const rows = ledgerRows(commits, { kind: "clean", proof });
    expect(rows[1]).toEqual({ state: "ok", label: "Code unchanged at the tip", value: "tree 4c1f9e0" });
    expect(rows[2]).toEqual({ state: "ok", label: "Replays cleanly", value: "5 steps · 1.2 s" });
  });

  it("marks changed code as the failing row", () => {
    const rows = ledgerRows(commits, {
      kind: "snag",
      detail: { kind: "tree_changed", files: [{ path: "src/export/csv.ts", added: 2, removed: 2 }] }
    });
    expect(rows[1]).toEqual({ state: "bad", label: "Code changed in 1 file", value: "csv.ts +2 −2" });
  });

  it("marks a conflict on the replay row", () => {
    const rows = ledgerRows(commits, {
      kind: "snag",
      detail: { kind: "conflict", step: 3, total: 5, hash: h("c"), subject: "commit c", files: [] }
    });
    expect(rows[2]).toEqual({ state: "bad", label: "Replays cleanly", value: "stopped at 3 of 5" });
  });
});
