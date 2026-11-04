import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { largestFirst, splitByLinkedWorktrees } from "./maintenance-handlers";

const repos = fc.uniqueArray(fc.record({ id: fc.stringMatching(/^[a-z]{1,4}$/) }), { selector: (repo) => repo.id, maxLength: 12 });
const weights = (list: Array<{ id: string }>) =>
  fc.array(fc.nat({ max: 5 }), { minLength: list.length, maxLength: list.length }).map(
    (counts) => new Map(list.map((repo, index) => [repo.id, counts[index]!]))
  );

describe("Maintenance's run order and Clones' split, for any repositories and counts", () => {
  it("starts the heaviest first and keeps the given order among equals", () => {
    fc.assert(
      fc.property(repos.chain((list) => fc.tuple(fc.constant(list), weights(list))), ([list, weight]) => {
        const order = largestFirst(list, weight);
        // The same repositories, each once.
        expect([...order].sort((a, b) => a.id.localeCompare(b.id))).toEqual([...list].sort((a, b) => a.id.localeCompare(b.id)));
        for (let i = 1; i < order.length; i += 1) {
          const before = weight.get(order[i - 1]!.id)!;
          const after = weight.get(order[i]!.id)!;
          expect(before).toBeGreaterThanOrEqual(after);
          if (before === after) expect(list.indexOf(order[i - 1]!)).toBeLessThan(list.indexOf(order[i]!));
        }
      })
    );
  });

  it("runs exactly the repositories with a linked worktree and lists every other one apart", () => {
    fc.assert(
      fc.property(repos.chain((list) => fc.tuple(fc.constant(list), weights(list))), ([list, linked]) => {
        const { withWorktrees, noWorktrees } = splitByLinkedWorktrees(list, linked);
        expect(withWorktrees).toEqual(list.filter((repo) => linked.get(repo.id)! > 0));
        expect(noWorktrees).toEqual(list.filter((repo) => linked.get(repo.id) === 0));
      })
    );
  });
});
