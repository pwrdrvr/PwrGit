import fc from "fast-check";
import { expect, test } from "vitest";
import type { ChangeRequestEntry } from "./types";
import { inferPullRequestStacks, stackBranchHealth, stackPositionForPr, type RepositoryStack } from "./stacks";

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
        baseIsAncestor, remoteIsAncestor: false, localIsAncestorOfRemote: false, parentMerged: false };
      expect(stackBranchHealth({ ...common, catalogHead: old, remoteHead: old })).toMatchObject({ remoteAhead: false, needsRestack: true });
      expect(stackBranchHealth({ ...common, catalogHead: old, remoteHead: remote }).remoteAhead).toBe(true);
    }));
});

test("a strict remote descendant stays remote-ahead after the cached PR catches up", () => {
  fc.assert(fc.property(fc.uniqueArray(fc.string({ minLength: 1 }), { minLength: 2, maxLength: 2 }),
    fc.boolean(), ([localHead, remoteHead], cacheCaughtUp) => {
      const health = stackBranchHealth({
        branch: "layer", parent: "base", localHead, remoteHead, catalogHead: remoteHead,
        baseIsAncestor: false, remoteIsAncestor: false, parentMerged: false,
        localIsAncestorOfRemote: true,
        pr: { ...entry(1, "layer", "base").pr, headOid: cacheCaughtUp ? remoteHead : localHead },
      });
      expect(health).toMatchObject({ remoteAhead: true, needsPush: false });
    }));
});

// Membership belongs to the PR, not its branch: a merged PR's branch is
// usually deleted, and its stack is usually closed.
test("a PR finds its stack by number, whatever its branch is called and whether the stack is closed", () => {
  const health = { inSync: true, needsRestack: false, parentMerged: false, needsPush: false, remoteAhead: false, drift: false };
  const stackOf = (id: string, numbers: number[], closed?: RepositoryStack["closed"]): RepositoryStack => ({
    id, source: "inferred", catalogRepository: "github.com:example/orbit", trunk: { branch: "main" },
    ...(closed ? { closed } : {}),
    layers: numbers.map((number, index) => ({
      branch: `layer-${id}-${index}`, parent: index ? `layer-${id}-${index - 1}` : "main", health,
      pr: { number, title: `#${number}`, url: "", state: closed ? "merged" : "open", isDraft: false, repoPath: "example/orbit" },
    })),
  });
  fc.assert(fc.property(
    fc.uniqueArray(fc.integer({ min: 1, max: 500 }), { minLength: 2, maxLength: 16 }),
    fc.integer({ min: 1, max: 15 }), fc.boolean(), fc.nat(),
    (numbers, split, firstClosed, pick) => {
      const cut = Math.min(split, numbers.length - 1);
      const stacks = [stackOf("a", numbers.slice(0, cut), firstClosed ? "merged" : undefined), stackOf("b", numbers.slice(cut))];
      const number = numbers[pick % numbers.length];
      const found = stackPositionForPr(stacks, { number, repoPath: "example/orbit" });
      const owner = stacks.find(stack => stack.layers.some(layer => layer.pr?.number === number))!;
      expect(found?.stack).toBe(owner);
      expect(found?.layer.pr?.number).toBe(number);
      expect(found?.index).toBe(owner.layers.findIndex(layer => layer.pr?.number === number) + 1);
      expect(stackPositionForPr(stacks, { number, repoPath: "example/mirror" })).toBeUndefined();
      expect(stackPositionForPr(stacks, { number: 501 })).toBeUndefined();
      // A closed stack that still lists a PR yields to the open stack that holds it now.
      const stale = stackOf("old", [number], "closed");
      expect(stackPositionForPr([stale, ...stacks], { number })?.stack).toBe(owner.closed ? stale : owner);
    }));
});
