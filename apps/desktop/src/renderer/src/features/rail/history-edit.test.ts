import { describe, expect, it } from "vitest";
import type { HistoryEditProgram, RebaseCommitRef } from "@pwrgit/shared";
import {
  ledgerRows,
  movedHashes,
  NO_EDITS,
  planDiff,
  programShapeKey,
  squashProgram,
  tidyGroups,
  tidyProgram
} from "./history-edit";

// Newest first, as the graph hands them over: e is the tip.
const commits: RebaseCommitRef[] = ["e", "d", "c", "b", "a"].map((id) => ({
  hash: id.repeat(40),
  subject: `commit ${id}`
}));
const h = (id: string): string => id.repeat(40);

const proposal: HistoryEditProgram = {
  commits: [
    { members: [h("a"), h("c")], message: "feat: exporter\n\nWhy." },
    { members: [h("b"), h("d"), h("e")], message: "test: exporter" }
  ]
};

describe("squashProgram", () => {
  it("folds the selection oldest first under the given message", () => {
    expect(squashProgram(commits.slice(0, 2), "msg")).toEqual({
      commits: [{ members: [h("d"), h("e")], message: "msg" }]
    });
  });
});

describe("tidyProgram", () => {
  it("is the proposal when nothing was edited", () => {
    expect(tidyProgram(proposal, NO_EDITS)).toEqual(proposal);
  });

  it("puts a separated member right after its group with its own message", () => {
    const program = tidyProgram(proposal, {
      separated: new Set([h("d")]),
      messages: new Map([[0, "feat: rewritten"]])
    });
    expect(program.commits).toEqual([
      { members: [h("a"), h("c")], message: "feat: rewritten" },
      { members: [h("b"), h("e")], message: "test: exporter" },
      { members: [h("d")], message: null }
    ]);
  });

  it("changes the shape key on Keep separate but not on a message edit", () => {
    const base = programShapeKey(tidyProgram(proposal, NO_EDITS));
    expect(
      programShapeKey(tidyProgram(proposal, { separated: new Set(), messages: new Map([[1, "x"]]) }))
    ).toBe(base);
    expect(
      programShapeKey(tidyProgram(proposal, { separated: new Set([h("e")]), messages: new Map() }))
    ).not.toBe(base);
  });
});

describe("movedHashes", () => {
  it("tags only the commits that left their original order", () => {
    // a c | b d e: only c jumped ahead of b.
    expect([...movedHashes(commits, proposal)]).toEqual([h("c")]);
  });

  it("tags nothing for an in-order fold", () => {
    const inOrder: HistoryEditProgram = {
      commits: [{ members: [h("a"), h("b"), h("c"), h("d"), h("e")], message: "all" }]
    };
    expect(movedHashes(commits, inOrder).size).toBe(0);
  });
});

describe("tidyGroups", () => {
  it("draws groups newest first with each base commit on top", () => {
    const groups = tidyGroups(commits, proposal, NO_EDITS);
    expect(groups.map((g) => g.message)).toEqual(["test: exporter", "feat: exporter\n\nWhy."]);
    expect(groups[1]!.rows.map((r) => [r.subject, r.role, r.moved, r.canToggle])).toEqual([
      ["commit a", "pick", false, false],
      ["commit c", "fixup", true, true]
    ]);
  });

  it("shows a separated member as its own pick", () => {
    const groups = tidyGroups(commits, proposal, {
      separated: new Set([h("d")]),
      messages: new Map()
    });
    expect(groups[0]!.rows.find((r) => r.hash === h("d"))).toEqual(
      expect.objectContaining({ role: "pick", separated: true })
    );
  });
});

describe("planDiff", () => {
  it("shows each commit that changed group, where it was and where it went", () => {
    const revised: HistoryEditProgram = {
      commits: [
        { members: [h("a")], message: "feat: exporter" },
        { members: [h("b"), h("c"), h("d"), h("e")], message: "test: exporter" }
      ]
    };
    expect(planDiff(commits, proposal, revised)).toEqual([
      { kind: "del", text: "fixup ccccccc → feat: exporter" },
      { kind: "add", text: "fixup ccccccc → test: exporter" }
    ]);
  });
});

describe("ledgerRows", () => {
  const proof = { commitCount: 5, resultCount: 2, steps: 5, tree: "4c1f9e0".padEnd(40, "0"), durationMs: 1200 };

  it("knows only the first row before the check", () => {
    expect(ledgerRows(commits, { kind: "idle" })).toEqual([
      { state: "ok", label: "5 commits, each used once", value: "aaaaaaa‥eeeeeee" },
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
