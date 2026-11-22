import fc from "fast-check";
import { expect, test } from "vitest";
import type { ChangeRequestEntry } from "./types";
import { inferPullRequestStacks, stackBranchHealth } from "./stacks";

function entry(number: number, head: string, base: string, forgeRepo = "github.com/example/orbit"): ChangeRequestEntry {
  return {
    forgeRepo, remote: "origin", location: { kind: "local", branch: head },
    pr: { number, title: head, url: "", state: "open", isDraft: false, headRefName: head, baseRefName: base },
  };
}

test("inference reconstructs trunk-outward chains independently of PR list order", () => {
  fc.assert(fc.property(fc.array(fc.integer(), { minLength: 2, maxLength: 18 }), fc.integer(), (ranks, seed) => {
    const chain = ranks.map((_, i) => entry(i + 1, `feature-${i + 1}`, i ? `feature-${i}` : "main"));
    const otherRepo = entry(99, "feature-1", "main", "github.com/example/mirror");
    const shuffled = chain.map((layer, index) => ({ layer, rank: ranks[index] })).toSorted((a, b) => a.rank - b.rank).map(({ layer }) => layer);
    expect(inferPullRequestStacks([otherRepo, ...shuffled], new Set())).toEqual([chain]);
    const tracked = chain[Math.abs(seed) % chain.length].pr.headRefName!;
    expect(inferPullRequestStacks(shuffled, new Set([tracked]))).toHaveLength(0);
    const fork = entry(100, "fork", chain[0].pr.headRefName!);
    expect(inferPullRequestStacks([...shuffled, fork], new Set())).toHaveLength(0);
  }));
});

test("a known remote head cannot be remote-ahead after a local rewrite", () => {
  fc.assert(fc.property(fc.uniqueArray(fc.string({ minLength: 1 }), { minLength: 4, maxLength: 4 }),
    fc.boolean(), ([old, remote, next, parent], baseIsAncestor) => {
      const common = { branch: "layer", parent: "base", base: old, localHead: next, parentHead: parent,
        baseIsAncestor, remoteIsAncestor: false, parentMerged: false };
      expect(stackBranchHealth({ ...common, catalogHead: old, remoteHead: old })).toMatchObject({ remoteAhead: false, needsRestack: true });
      expect(stackBranchHealth({ ...common, catalogHead: old, remoteHead: remote }).remoteAhead).toBe(true);
    }));
});
