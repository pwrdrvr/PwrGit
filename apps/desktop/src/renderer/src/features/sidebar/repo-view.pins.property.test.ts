// Property test: pinned repositories lead every lens, in one order.
//
// The rule (design/Pinned Repos Lead Every Lens - UX Review.dc.html, turn 2):
//
//   P1  In every lens, no unpinned repository is listed above a pinned one.
//   P2  The pins a lens lists are in the same relative order in every lens:
//       by `order`, then by name.
//   P3  A lens lists what it listed before; ordering adds and drops nothing.
//   P4  `movePin` moves one repository and leaves every other pin's relative
//       order alone, whichever pins a lens happens to show.
//
// Against 0.59.7's `filterReposByLens` (All returned `sort(byName)`; Focused
// ranked by its ladder alone; Behind and Stale floated pins but ignored
// `order`), P1 and P2 both fail, shrunk to four or five repositories in the
// Focused lens. P3 and P4 hold there: they guard the new helpers.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { Lens, Repo, Worktree } from "@pwrgit/shared";
import {
  filterReposByLens,
  LENSES,
  movePin,
  splitPins,
  type FocusContext
} from "./repo-view";

const NOW = Date.UTC(2026, 10, 17);

const worktree = (repoId: string, n: number, w: Partial<Worktree>): Worktree => ({
  id: `${repoId}-w${n}`,
  repoId,
  path: `/r/${repoId}/w${n}`,
  branch: `b${n}`,
  isPrimary: n === 0,
  pinned: false,
  ahead: 0,
  behind: 0,
  dirty: 0,
  ...w
} as Worktree);

const repoArb = (index: number): fc.Arbitrary<Repo> =>
  fc
    .record({
      name: fc.constantFrom("a", "B", "c", "D", "e", "v2", "v10"),
      pinned: fc.boolean(),
      order: fc.option(fc.integer({ min: 0, max: 6 }), { nil: undefined }),
      worktrees: fc.array(
        fc.record({
          pinned: fc.boolean(),
          behind: fc.constantFrom(0, 0, 3),
          lastAuthoredAt: fc.constantFrom(
            undefined,
            new Date(NOW - 3600_000).toISOString()
          )
        }),
        { maxLength: 2 }
      )
    })
    .map(({ name, pinned, order, worktrees }) => {
      const id = `r${index}`;
      return {
        id,
        profileId: "p",
        name: `${name}${index}`,
        path: `/r/${id}`,
        pinned,
        ...(order === undefined ? {} : { order }),
        worktrees: worktrees.map((w, n) =>
          worktree(id, n, {
            pinned: w.pinned,
            behind: w.behind,
            ...(w.lastAuthoredAt === undefined
              ? {}
              : { lastAuthoredAt: w.lastAuthoredAt })
          })
        )
      } as Repo;
    });

const reposArb = fc
  .integer({ min: 0, max: 7 })
  .chain((n) => fc.tuple(...Array.from({ length: n }, (_, i) => repoArb(i))));

const sessionArb = reposArb.chain((repos) => {
  const worktreeIds = repos.flatMap((r) => r.worktrees.map((w) => w.id));
  return fc.record({
    repos: fc.shuffledSubarray(repos, { minLength: repos.length }),
    selected: fc.option(
      worktreeIds.length === 0 ? fc.constant(null) : fc.constantFrom(...worktreeIds),
      { nil: null }
    )
  });
});

const lensArb = fc.constantFrom<Lens>(...LENSES);

const context = (selected: string | null): FocusContext => ({
  selectedWorktreeId: selected,
  visits: {}
});

describe("pinned repositories lead every lens", () => {
  it("P1: no unpinned repository sits above a pinned one", () => {
    fc.assert(
      fc.property(sessionArb, lensArb, ({ repos, selected }, lens) => {
        const flags = filterReposByLens(repos, lens, NOW, context(selected)).map(
          (r) => r.pinned
        );
        const firstUnpinned = flags.indexOf(false);
        if (firstUnpinned === -1) return;
        expect(flags.slice(firstUnpinned)).not.toContain(true);
      })
    );
  });

  it("P2: the pins keep one order across lenses", () => {
    fc.assert(
      fc.property(sessionArb, lensArb, ({ repos, selected }, lens) => {
        const everyPin = splitPins(repos).pins.map((r) => r.id);
        const shown = filterReposByLens(repos, lens, NOW, context(selected))
          .filter((r) => r.pinned)
          .map((r) => r.id);
        expect(shown).toEqual(everyPin.filter((id) => shown.includes(id)));
      })
    );
  });

  it("P3: ordering neither adds nor drops a repository", () => {
    fc.assert(
      fc.property(sessionArb, ({ repos, selected }) => {
        const all = filterReposByLens(repos, "All", NOW, context(selected));
        expect(all.map((r) => r.id).sort()).toEqual(repos.map((r) => r.id).sort());
        for (const lens of LENSES) {
          const ids = filterReposByLens(repos, lens, NOW, context(selected)).map(
            (r) => r.id
          );
          expect(new Set(ids).size).toBe(ids.length);
        }
      })
    );
  });

  it("P4: a move leaves every other pin's order alone", () => {
    fc.assert(
      fc.property(
        sessionArb,
        fc.nat(),
        fc.nat(),
        fc.constantFrom("before" as const, "after" as const),
        ({ repos }, dragAt, targetAt, position) => {
          const pins = splitPins(repos).pins.map((r) => r.id);
          if (pins.length === 0 || repos.length === 0) return;
          const dragId = (repos[dragAt % repos.length] as Repo).id;
          const targetId = pins[targetAt % pins.length] as string;
          const moved = movePin(repos, dragId, targetId, position);
          expect(moved.filter((id) => id !== dragId)).toEqual(
            pins.filter((id) => id !== dragId)
          );
          if (dragId === targetId) return;
          expect(moved.indexOf(dragId) - moved.indexOf(targetId)).toBe(
            position === "after" ? 1 : -1
          );
        }
      )
    );
  });
});
