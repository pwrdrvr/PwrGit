import fc from "fast-check";
import type { RepoSearchHit } from "@pwrgit/shared";
import { describe, expect, it } from "vitest";
import { rankSearchHits, searchMatchTier } from "./search-rank";

// Main re-ranks whatever order the index hands it. Its promise for a
// repository the query names or begins: none of its own checkouts or branches
// that match the query no better is listed above it. bm25 cannot keep that: a checkout
// is scored on its branch, and again on the repository's name in its path.

const word = fc.stringMatching(/^[a-b]{1,3}$/);

const hits = fc
  .record({
    repo: word,
    rows: fc.array(
      fc.record({
        kind: fc.constantFrom("worktree", "local_branch", "remote_branch") as fc.Arbitrary<
          RepoSearchHit["kind"]
        >,
        name: word,
        folder: word
      }),
      { maxLength: 12 }
    )
  })
  .map(({ repo, rows }): RepoSearchHit[] => {
    const base = {
      repoId: "r",
      profileId: "p",
      profileName: "Personal",
      worktreeCount: 0,
      pinned: false
    };
    return [
      { ...base, kind: "repo", name: repo, path: `/repos/${repo}` },
      ...rows.map(({ kind, name, folder }) => ({
        ...base,
        kind,
        name,
        // A checkout's folder carries the repository's name, as agent
        // worktrees' do (`PwrAgnt-wt/…`).
        path: kind === "worktree" ? `/repos/${repo}-wt/${folder}` : `/repos/${repo}`
      }))
    ];
  });

describe("rankSearchHits", () => {
  it("lists a repository above its own rows that match the query no better", () => {
    fc.assert(
      fc.property(
        hits.chain((all) =>
          fc.tuple(fc.shuffledSubarray(all, { minLength: all.length }), word)
        ),
        ([input, query]) => {
          const ranked = rankSearchHits(input, query);
          const at = ranked.findIndex((hit) => hit.kind === "repo");
          const repoTier = searchMatchTier(ranked[at]!, query);
          // Tier 2 matched somewhere other than the head of a name, and keeps
          // bm25's order on purpose: there a repository matched only through
          // an ancestor folder must not jump a branch the query found by name.
          fc.pre(repoTier <= 1);
          for (const above of ranked.slice(0, at)) {
            expect({ above, tier: searchMatchTier(above, query) < repoTier }).toEqual({
              above,
              tier: true
            });
          }
        }
      )
    );
  });

  it("puts a repository above its checkout in a folder its name begins", () => {
    // The shrunk counterexample: both begin a name, and a stable sort kept the
    // index's order, checkout first.
    const base = { repoId: "r", profileId: "p", profileName: "P", worktreeCount: 0, pinned: false };
    const checkout: RepoSearchHit = { ...base, kind: "worktree", name: "main", path: "/wt/PwrSuiteLab-main" };
    const repo: RepoSearchHit = { ...base, kind: "repo", name: "PwrSuiteLab", path: "/repos/PwrSuiteLab" };
    expect(rankSearchHits([checkout, repo], "pwrsuitel")).toEqual([repo, checkout]);
  });
});
