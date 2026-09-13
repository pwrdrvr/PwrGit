import { describe, expect, it } from "vitest";
import type { PruneCandidate, ReclaimPlan } from "@pwrgit/shared";
import {
  describeBytes,
  describeReclaimBytes,
  formatExcludeLines,
  parseExcludeLines,
  reasonDetail,
  reasonLabel,
  reclaimConfirmMessage,
  reclaimTotals,
  removalConfirmMessage,
  selectionTotals,
  sortCandidates
} from "./prune-view";

function candidate(
  partial: Partial<PruneCandidate> & { worktreeId: string }
): PruneCandidate {
  return {
    repoId: "r",
    repoName: "repo",
    branch: partial.worktreeId,
    path: `/w/${partial.worktreeId}`,
    reason: { kind: "merged_into_default", defaultBranch: "main" },
    sizeBytes: 0,
    ...partial
  };
}

describe("reason wording", () => {
  it("says which claim it is making, not just that the row is stale", () => {
    expect(reasonLabel({ kind: "merged_pr", prNumber: 12 })).toBe("merged PR #12");
    expect(
      reasonLabel({ kind: "merged_into_default", defaultBranch: "trunk" })
    ).toBe("merged into trunk");
    expect(reasonLabel({ kind: "diverged", defaultBranch: "main" })).toBe(
      "no common ancestor with main"
    );
  });

  it("spells the same three claims out for the confirm", () => {
    expect(reasonDetail({ kind: "merged_pr", prNumber: 12 })).toMatch(/#12/);
    expect(
      reasonDetail({ kind: "merged_into_default", defaultBranch: "main" })
    ).toMatch(/already in main/);
    expect(reasonDetail({ kind: "diverged", defaultBranch: "main" })).toMatch(
      /shares no history/
    );
  });
});

describe("sortCandidates", () => {
  it("puts the biggest recovery first", () => {
    const sorted = sortCandidates([
      candidate({ worktreeId: "small", sizeBytes: 10 }),
      candidate({ worktreeId: "big", sizeBytes: 9_000 }),
      candidate({ worktreeId: "mid", sizeBytes: 500 })
    ]);
    expect(sorted.map((c) => c.worktreeId)).toEqual(["big", "mid", "small"]);
  });

  it("sorts unsized rows last, not first as a zero would", () => {
    const sorted = sortCandidates([
      candidate({ worktreeId: "unknown", sizeBytes: null }),
      candidate({ worktreeId: "tiny", sizeBytes: 1 })
    ]);
    expect(sorted.map((c) => c.worktreeId)).toEqual(["tiny", "unknown"]);
  });

  it("breaks equal sizes by how well understood the reason is, then by name", () => {
    const sorted = sortCandidates([
      candidate({
        worktreeId: "orphan",
        reason: { kind: "diverged", defaultBranch: "main" }
      }),
      candidate({
        worktreeId: "pr",
        reason: { kind: "merged_pr", prNumber: 1 }
      }),
      candidate({ worktreeId: "merged" })
    ]);
    expect(sorted.map((c) => c.worktreeId)).toEqual(["pr", "merged", "orphan"]);
  });

  it("does not mutate its input", () => {
    const input = [
      candidate({ worktreeId: "a", sizeBytes: 1 }),
      candidate({ worktreeId: "b", sizeBytes: 2 })
    ];
    sortCandidates(input);
    expect(input.map((c) => c.worktreeId)).toEqual(["a", "b"]);
  });
});

describe("selectionTotals", () => {
  const candidates = [
    candidate({ worktreeId: "a", repoId: "r1", sizeBytes: 1024 }),
    candidate({ worktreeId: "b", repoId: "r1", sizeBytes: 2048, sizePartial: true }),
    candidate({ worktreeId: "c", repoId: "r2", sizeBytes: null }),
    candidate({ worktreeId: "d", repoId: "r3", sizeBytes: 4096 })
  ];

  it("counts only the selected rows, and the repos they span", () => {
    const totals = selectionTotals(candidates, new Set(["a", "d"]));
    expect(totals).toEqual({
      count: 2,
      bytes: 5120,
      partial: false,
      unsized: 0,
      repos: 2
    });
  });

  it("carries a floor upward: one partial row makes the total a floor", () => {
    const totals = selectionTotals(candidates, new Set(["a", "b"]));
    expect(totals.partial).toBe(true);
    expect(describeBytes(totals)).toBe("at least 3 KB");
  });

  it("reports unmeasured rows rather than counting them as zero", () => {
    const totals = selectionTotals(candidates, new Set(["a", "c"]));
    expect(totals.unsized).toBe(1);
    expect(totals.bytes).toBe(1024);
    expect(describeBytes(totals)).toBe("1 KB (1 not measured)");
  });

  it("is empty when nothing is selected", () => {
    expect(selectionTotals(candidates, new Set()).count).toBe(0);
  });
});

describe("removalConfirmMessage", () => {
  const picked = [
    candidate({
      worktreeId: "a",
      repoName: "alpha",
      branch: "feat/a",
      sizeBytes: 2048,
      reason: { kind: "merged_pr", prNumber: 7 }
    }),
    candidate({
      worktreeId: "b",
      repoId: "r2",
      repoName: "beta",
      branch: "feat/b",
      sizeBytes: 1024
    })
  ];

  it("names the count, the repos, and why each row qualified", () => {
    const message = removalConfirmMessage(
      picked,
      selectionTotals(picked, new Set(["a", "b"]))
    );
    expect(message).toContain("2 worktrees across 2 repositories");
    expect(message).toContain("freeing 3 KB");
    expect(message).toContain("alpha · feat/a — its pull request #7 is merged");
    expect(message).toContain("beta · feat/b — every commit is already in main");
    expect(message).toContain("Branches and commits are kept.");
  });

  it("summarizes a long list instead of printing all of it", () => {
    const many = Array.from({ length: 20 }, (_, at) =>
      candidate({ worktreeId: `w${at}`, sizeBytes: 100 })
    );
    const message = removalConfirmMessage(
      many,
      selectionTotals(many, new Set(many.map((c) => c.worktreeId)))
    );
    expect(message).toContain("…and 12 more");
  });
});

describe("exclude field round-trip", () => {
  it("edits as lines and normalizes on the way back", () => {
    expect(parseExcludeLines(".env*\n\n  *.local  \n.env*")).toEqual([
      ".env*",
      "*.local"
    ]);
    expect(formatExcludeLines([".env*", "*.local"])).toBe(".env*\n*.local");
  });

  it("drops a negation the user typed rather than inverting their intent", () => {
    // The panel adds the `!` itself; a typed one would become `!!pattern`.
    expect(parseExcludeLines("!.env\ndist/")).toEqual(["dist/"]);
  });
});

describe("reclaim totals and confirm", () => {
  const plan = (
    worktreeId: string,
    totalBytes: number,
    pathCount: number,
    truncated = false
  ): ReclaimPlan => ({
    worktreeId,
    repoName: "repo",
    branch: worktreeId,
    path: `/w/${worktreeId}`,
    excludes: [".env*"],
    entries: [],
    totalBytes,
    pathCount,
    truncated
  });

  it("sums bytes and paths, and carries a truncation upward", () => {
    expect(reclaimTotals([plan("a", 1024, 3), plan("b", 2048, 4, true)])).toEqual({
      worktrees: 2,
      bytes: 3072,
      paths: 7,
      truncated: true,
      partial: false
    });
  });

  it("carries an incomplete sizing upward, so the total reads as a floor", () => {
    // A cancelled sizing pass leaves rows at zero bytes. Presenting that sum
    // as exact would put "free 1 KB" on a button that deletes gigabytes.
    const cut: ReclaimPlan = { ...plan("a", 1024, 30), sizesPartial: true };
    const totals = reclaimTotals([cut]);
    expect(totals.partial).toBe(true);
    expect(describeReclaimBytes(totals)).toBe("at least 1 KB");
    expect(reclaimConfirmMessage(totals, [".env*"])).toContain(
      "freeing at least 1 KB"
    );
  });

  it("treats a single floored entry as flooring the whole total", () => {
    const capped: ReclaimPlan = {
      ...plan("a", 4096, 1),
      entries: [
        { path: "node_modules/", isDirectory: true, sizeBytes: 4096, sizePartial: true }
      ]
    };
    expect(reclaimTotals([capped]).partial).toBe(true);
  });

  it("says what survives as plainly as what does not", () => {
    const message = reclaimConfirmMessage(
      reclaimTotals([plan("a", 1024, 3)]),
      [".env*", "*.sqlite"]
    );
    expect(message).toContain("3 ignored paths across 1 worktree");
    expect(message).toContain("freeing 1 KB");
    expect(message).toContain("Tracked files, branches and commits are untouched");
    expect(message).toContain("cannot be undone");
    expect(message).toContain("Spared by your exclude list: .env*, *.sqlite.");
  });

  it("says so when the user has cleared every guard", () => {
    const message = reclaimConfirmMessage(reclaimTotals([plan("a", 10, 1)]), []);
    expect(message).toContain("Nothing is being spared");
  });
});
