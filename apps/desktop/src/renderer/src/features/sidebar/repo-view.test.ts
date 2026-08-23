import { describe, expect, it } from "vitest";
import type { Repo, Worktree } from "@pwrgit/shared";
import {
  dropPositionWithin,
  filterReposByLens,
  FOCUS_REPO_LIMIT,
  focusedRepoPage,
  focusedRepos,
  focusReasonForRepo,
  focusReasonForWorktree,
  groupWorktreesForNavigation,
  groupReposByRoot,
  isPrunableWorktree,
  formatLensCount,
  lensCounts,
  linkedWorktreeCount,
  lensIsArrangeable,
  orderWorktrees,
  partitionFocusedWorktrees,
  reorder,
  repoPinSource,
  repoPrimaryBehind,
  SORT_CYCLE,
  worktreeFolderLabel
} from "./repo-view";

function wt(partial: Partial<Worktree> & { id: string; branch: string }): Worktree {
  return {
    repoId: "r",
    path: `/${partial.id}`,
    dirty: 0,
    ahead: 0,
    behind: 0,
    behindDefault: 0,
    defaultBranch: "main",
    mergedIntoDefault: false,
    divergedFromDefault: false,
    isDefaultBranch: false,
    pinned: false,
    isPrimary: false,
    ...partial
  };
}

const OLD = "2000-01-01T00:00:00.000Z";

function repo(partial: Partial<Repo> & { id: string }): Repo {
  return {
    name: partial.id,
    path: `/${partial.id}`,
    profileId: "p",
    pinned: false,
    worktrees: [],
    ...partial
  };
}

describe("lensCounts / filterReposByLens", () => {
  const repos: Repo[] = [
    repo({ id: "a", pinned: true }),
    repo({ id: "b", worktrees: [wt({ id: "b1", branch: "main", behind: 2 })] }),
    repo({ id: "c", worktrees: [wt({ id: "c1", branch: "main", pinned: true })] })
  ];

  it("counts pinned (repo or worktree), behind, and all", () => {
    const counts = lensCounts(repos);
    expect(counts).toEqual({
      Focused: 2,
      Pinned: 2,
      Behind: 1,
      Stale: 0,
      All: 3
    });
  });

  it("Behind lens keeps only repos with a behind worktree", () => {
    expect(filterReposByLens(repos, "Behind").map((r) => r.id)).toEqual(["b"]);
  });

  it("Pinned lens keeps repo- or worktree-pinned repos", () => {
    expect(filterReposByLens(repos, "Pinned").map((r) => r.id).sort()).toEqual([
      "a",
      "c"
    ]);
  });

  it("All lens is a strict alphabetical index — pins do not jump the queue", () => {
    // "a" is the pinned one. It leads here because of its NAME, so prove the
    // ordering with a pinned repo that sorts last: an index whose positions
    // move when you pin something is not an index.
    const shuffled = [
      repo({ id: "zulu", name: "zulu", pinned: true }),
      repo({ id: "alpha", name: "alpha" }),
      repo({ id: "mike", name: "mike" })
    ];
    expect(filterReposByLens(shuffled, "All").map((r) => r.id)).toEqual([
      "alpha",
      "mike",
      "zulu"
    ]);
  });

  it("All sorts naturally: case-insensitive, v2 before v10", () => {
    const names = ["Foo", "v10", "foo", "v2"].map((n) => repo({ id: n, name: n }));
    expect(filterReposByLens(names, "All").map((r) => r.name)).toEqual([
      "Foo",
      "foo",
      "v2",
      "v10"
    ]);
  });
});

describe("Focused lens", () => {
  const NOW = Date.parse("2026-08-23T12:00:00Z");
  const daysAgo = (days: number): string =>
    new Date(NOW - days * 86_400_000).toISOString();

  it("uses a transparent priority ladder and excludes incidental repos", () => {
    const rows = [
      repo({
        id: "recent",
        worktrees: [
          wt({ id: "recent-wt", branch: "recent", lastActivityAt: daysAgo(3) })
        ]
      }),
      repo({
        id: "changed",
        worktrees: [wt({ id: "changed-wt", branch: "changed", ahead: 1 })]
      }),
      repo({
        id: "viewed",
        worktrees: [wt({ id: "viewed-wt", branch: "viewed" })]
      }),
      repo({ id: "pinned", pinned: true }),
      repo({
        id: "current",
        worktrees: [wt({ id: "current-wt", branch: "current" })]
      }),
      repo({
        id: "incidental",
        worktrees: [wt({ id: "incidental-wt", branch: "old", behind: 20 })]
      })
    ];
    const context = {
      selectedWorktreeId: "current-wt",
      visits: { "viewed-wt": NOW - 2 * 86_400_000 }
    };

    expect(focusedRepos(rows, context, NOW).map((r) => r.id)).toEqual([
      "current",
      "pinned",
      "viewed",
      "changed",
      "recent"
    ]);
    expect(
      filterReposByLens(rows, "Focused", NOW, context).map((r) => r.id)
    ).toEqual(["current", "pinned", "viewed", "changed", "recent"]);
    expect(focusReasonForRepo(rows[5] as Repo, context, NOW)).toBeNull();
  });

  it("expires views and branch activity after 30 days", () => {
    const viewed = repo({
      id: "viewed",
      worktrees: [wt({ id: "viewed-wt", branch: "viewed" })]
    });
    const recent = repo({
      id: "recent",
      worktrees: [
        wt({ id: "recent-wt", branch: "recent", lastActivityAt: daysAgo(31) })
      ]
    });
    expect(
      focusedRepos(
        [viewed, recent],
        {
          selectedWorktreeId: null,
          visits: { "viewed-wt": NOW - 31 * 86_400_000 }
        },
        NOW
      )
    ).toEqual([]);
  });

  it("caps a large first page and reveals the complete focused set on demand", () => {
    const rows = Array.from({ length: 40 }, (_, index) =>
      repo({ id: `repo-${index}`, pinned: true })
    );
    const focused = focusedRepos(
      rows,
      { selectedWorktreeId: null, visits: {} },
      NOW
    );
    const page = focusedRepoPage(focused, false);
    expect(page.repos).toHaveLength(FOCUS_REPO_LIMIT);
    expect(page.hidden).toBe(40 - FOCUS_REPO_LIMIT);
    expect(focusedRepoPage(focused, true)).toEqual({
      repos: focused,
      hidden: 0
    });
  });
});

describe("linkedWorktreeCount", () => {
  it("excludes the primary checkout", () => {
    const r = repo({
      id: "r",
      worktrees: [
        wt({ id: "p", branch: "main", isPrimary: true }),
        wt({ id: "a", branch: "feature/a" }),
        wt({ id: "b", branch: "feature/b" })
      ]
    });
    expect(linkedWorktreeCount(r)).toBe(2);
  });

  it("is 0 for a repo that is only a local checkout", () => {
    // The case that made the old count wrong on most rows: the repo's own
    // directory is not a worktree you added, so there is nothing to report.
    const r = repo({
      id: "r",
      worktrees: [wt({ id: "p", branch: "main", isPrimary: true })]
    });
    expect(linkedWorktreeCount(r)).toBe(0);
  });

  it("counts pinned and unpinned alike, so the row total covers both sections", () => {
    const r = repo({
      id: "r",
      worktrees: [
        wt({ id: "p", branch: "main", isPrimary: true }),
        wt({ id: "a", branch: "feature/a", pinned: true }),
        wt({ id: "b", branch: "feature/b" })
      ]
    });
    const grouped = groupWorktreesForNavigation(r.worktrees, "recent");
    expect(grouped.pinned.length + grouped.remaining.length).toBe(
      linkedWorktreeCount(r)
    );
  });
});

describe("orderWorktrees", () => {
  const worktrees = [
    wt({ id: "1", branch: "main", isPrimary: true }),
    wt({ id: "2", branch: "zeta", dirty: 5 }),
    wt({ id: "3", branch: "alpha", pinned: true })
  ];

  it("sort cycle is recent → pinned → az → active → recent", () => {
    expect(SORT_CYCLE.recent).toBe("pinned");
    expect(SORT_CYCLE.pinned).toBe("az");
    expect(SORT_CYCLE.az).toBe("active");
    expect(SORT_CYCLE.active).toBe("recent");
  });

  it("Recent sorts by last activity, missing timestamps last", () => {
    const dated = [
      wt({ id: "old", branch: "old", lastActivityAt: "2026-06-01T00:00:00Z" }),
      wt({ id: "none", branch: "none" }),
      wt({ id: "new", branch: "new", lastActivityAt: "2026-07-10T00:00:00Z" })
    ];
    expect(orderWorktrees(dated, "recent").map((w) => w.id)).toEqual([
      "new",
      "old",
      "none"
    ]);
  });

  it("A–Z sorts by branch name", () => {
    expect(orderWorktrees(worktrees, "az").map((w) => w.branch)).toEqual([
      "alpha",
      "main",
      "zeta"
    ]);
  });

  it("Active sorts by dirty+ahead descending", () => {
    expect(orderWorktrees(worktrees, "active")[0]?.branch).toBe("zeta");
  });

  it("pinned floats pinned worktrees up", () => {
    expect(orderWorktrees(worktrees, "pinned")[0]?.branch).toBe("alpha");
  });

  it("custom order overrides the sort mode", () => {
    const ordered = orderWorktrees(worktrees, "az", ["2", "3", "1"]);
    expect(ordered.map((w) => w.id)).toEqual(["2", "3", "1"]);
  });
});

describe("groupWorktreesForNavigation", () => {
  it("elevates the primary checkout and pinned worktrees above the remaining list", () => {
    const worktrees = [
      wt({ id: "primary", branch: "main", isPrimary: true }),
      wt({
        id: "recent",
        branch: "recent",
        lastActivityAt: "2026-07-10T00:00:00Z"
      }),
      wt({
        id: "favorite",
        branch: "favorite",
        pinned: true,
        lastActivityAt: "2026-06-01T00:00:00Z"
      })
    ];

    const grouped = groupWorktreesForNavigation(worktrees, "recent");

    expect(grouped.primary?.id).toBe("primary");
    expect(grouped.pinned.map((worktree) => worktree.id)).toEqual(["favorite"]);
    expect(grouped.remaining.map((worktree) => worktree.id)).toEqual(["recent"]);
    expect(grouped.displayIds).toEqual(["primary", "favorite", "recent"]);
  });

  it("preserves custom ordering within the elevated and remaining groups", () => {
    const worktrees = [
      wt({ id: "primary", branch: "main", isPrimary: true }),
      wt({ id: "pinned-a", branch: "pinned-a", pinned: true }),
      wt({ id: "pinned-b", branch: "pinned-b", pinned: true }),
      wt({ id: "other-a", branch: "other-a" }),
      wt({ id: "other-b", branch: "other-b" })
    ];

    const grouped = groupWorktreesForNavigation(worktrees, "recent", [
      "other-b",
      "pinned-b",
      "other-a",
      "pinned-a"
    ]);

    expect(grouped.pinned.map((worktree) => worktree.id)).toEqual([
      "pinned-b",
      "pinned-a"
    ]);
    expect(grouped.remaining.map((worktree) => worktree.id)).toEqual([
      "other-b",
      "other-a"
    ]);
  });
});

describe("partitionFocusedWorktrees", () => {
  const NOW = Date.parse("2026-08-23T12:00:00Z");

  it("elevates selected, viewed, changed, and recently active worktrees", () => {
    const worktrees = [
      wt({ id: "old", branch: "old" }),
      wt({
        id: "recent",
        branch: "recent",
        lastActivityAt: "2026-08-20T00:00:00Z"
      }),
      wt({ id: "changed", branch: "changed", dirty: 1 }),
      wt({ id: "viewed", branch: "viewed" }),
      wt({ id: "current", branch: "current" })
    ];
    const context = {
      selectedWorktreeId: "current",
      visits: { viewed: NOW - 86_400_000 }
    };
    const partition = partitionFocusedWorktrees(worktrees, context, NOW);
    expect(partition.focused.map((worktree) => worktree.id)).toEqual([
      "current",
      "viewed",
      "changed",
      "recent"
    ]);
    expect(partition.remaining.map((worktree) => worktree.id)).toEqual(["old"]);
    expect(
      focusReasonForWorktree(worktrees[0] as Worktree, context, NOW)
    ).toBeNull();
  });

  it("keeps overflow behind the on-demand disclosure", () => {
    const worktrees = Array.from({ length: 9 }, (_, index) =>
      wt({
        id: `wt-${index}`,
        branch: `feature/${index}`,
        lastActivityAt: "2026-08-20T00:00:00Z"
      })
    );
    const partition = partitionFocusedWorktrees(
      worktrees,
      { selectedWorktreeId: null, visits: {} },
      NOW,
      5
    );
    expect(partition.focused).toHaveLength(5);
    expect(partition.remaining).toHaveLength(4);
  });
});

describe("reorder", () => {
  it("moves the dragged id in front of the target", () => {
    expect(reorder(["1", "2", "3"], "3", "1")).toEqual(["3", "1", "2"]);
  });
  it("is a no-op when dragging onto itself", () => {
    expect(reorder(["1", "2", "3"], "2", "2")).toEqual(["1", "2", "3"]);
  });
  it("drops after the target when asked", () => {
    expect(reorder(["1", "2", "3"], "1", "2", "after")).toEqual(["2", "1", "3"]);
  });
  // The whole reason `position` exists: with before-only inserts the last slot
  // is unreachable no matter how you drag.
  it("can reach the end of the list", () => {
    expect(reorder(["1", "2", "3"], "1", "3", "after")).toEqual(["2", "3", "1"]);
  });
  it("is a no-op when the target isn't in the list", () => {
    expect(reorder(["1", "2"], "1", "9", "after")).toEqual(["1", "2"]);
  });
});

describe("dropPositionWithin", () => {
  const rect = { top: 100, height: 30 } as DOMRect;

  it("reads the top half as 'before'", () => {
    expect(dropPositionWithin(rect, 101)).toBe("before");
    expect(dropPositionWithin(rect, 114)).toBe("before");
  });
  it("reads the midpoint and below as 'after'", () => {
    expect(dropPositionWithin(rect, 115)).toBe("after");
    expect(dropPositionWithin(rect, 129)).toBe("after");
  });
});

describe("repoPinSource", () => {
  it("reports the repo's own pin", () => {
    expect(repoPinSource(repo({ id: "a", pinned: true }))).toBe("repo");
  });
  it("reports a repo pulled in only by a pinned worktree", () => {
    const r = repo({
      id: "b",
      worktrees: [wt({ id: "b1", branch: "main", pinned: true })]
    });
    expect(repoPinSource(r)).toBe("worktree");
  });
  it("prefers the repo's own pin when both are set", () => {
    const r = repo({
      id: "c",
      pinned: true,
      worktrees: [wt({ id: "c1", branch: "main", pinned: true })]
    });
    expect(repoPinSource(r)).toBe("repo");
  });
  it("reports none for an unpinned repo", () => {
    expect(repoPinSource(repo({ id: "d" }))).toBe("none");
  });
});

describe("hand-arranged repo order", () => {
  // Deliberately listed out of arranged order, and `z` sorts last by name, so
  // a passing result can only come from `order`.
  const repos: Repo[] = [
    repo({ id: "a", pinned: true }),
    repo({ id: "z", pinned: true, order: 0 }),
    repo({ id: "m", pinned: true, order: 1 })
  ];

  it("only the Pinned lens is arrangeable", () => {
    expect(lensIsArrangeable("Pinned")).toBe(true);
    for (const lens of ["Focused", "Behind", "Stale", "All"] as const) {
      expect(lensIsArrangeable(lens)).toBe(false);
    }
  });

  it("applies the arrangement in the Pinned lens", () => {
    expect(filterReposByLens(repos, "Pinned").map((r) => r.id)).toEqual([
      "z",
      "m",
      "a"
    ]);
  });

  it("leaves unarranged repos behind the arranged ones", () => {
    const mixed = [
      repo({ id: "unarranged", pinned: true }),
      repo({ id: "arranged", pinned: true, order: 5 })
    ];
    expect(filterReposByLens(mixed, "Pinned").map((r) => r.id)).toEqual([
      "arranged",
      "unarranged"
    ]);
  });

  it("ignores the arrangement in computed lenses", () => {
    // "All" answers a question; a manual order there would fight the answer.
    // The arrangement would give z, m, a — alphabetical gives a, m, z.
    expect(filterReposByLens(repos, "All").map((r) => r.id)).toEqual([
      "a",
      "m",
      "z"
    ]);
  });
});

describe("staleness (isPrunableWorktree + Stale lens)", () => {
  const prunable = wt({
    id: "p",
    branch: "old/merged",
    mergedIntoDefault: true,
    lastActivityAt: OLD
  });

  it("flags a clean, merged, old, non-default worktree as prunable", () => {
    expect(isPrunableWorktree(prunable)).toBe(true);
  });

  it("also flags a clean, diverged (orphaned), old worktree as prunable", () => {
    const diverged = wt({
      id: "d",
      branch: "orphan",
      mergedIntoDefault: false,
      divergedFromDefault: true,
      lastActivityAt: OLD
    });
    expect(isPrunableWorktree(diverged)).toBe(true);
  });

  it("excludes dirty, unmerged, default, recent, or primary worktrees", () => {
    expect(isPrunableWorktree({ ...prunable, dirty: 2 })).toBe(false);
    expect(isPrunableWorktree({ ...prunable, mergedIntoDefault: false })).toBe(
      false
    );
    expect(isPrunableWorktree({ ...prunable, isDefaultBranch: true })).toBe(
      false
    );
    expect(isPrunableWorktree({ ...prunable, isPrimary: true })).toBe(false);
    expect(
      isPrunableWorktree({ ...prunable, lastActivityAt: new Date().toISOString() })
    ).toBe(false);
  });

  it("Stale lens filters to repos with a prunable worktree and counts them", () => {
    const repos = [
      repo({ id: "stale", worktrees: [prunable] }),
      repo({ id: "fresh", worktrees: [wt({ id: "f", branch: "main", isDefaultBranch: true })] })
    ];
    expect(lensCounts(repos).Stale).toBe(1);
    expect(filterReposByLens(repos, "Stale").map((r) => r.id)).toEqual(["stale"]);
  });
});

describe("groupReposByRoot", () => {
  const repos: Repo[] = [
    repo({ id: "acme-svc", path: "/Users/h/Acme/acme-svc" }),
    repo({ id: "pwrgit", path: "/Users/h/pwrdrvr/PwrGit" }),
    repo({ id: "kit", path: "/Users/h/github/agent-kit" }),
    repo({ id: "loose", path: "/Users/h/elsewhere/loose" })
  ];
  const roots = ["/Users/h/pwrdrvr", "/Users/h/github", "/Users/h/Acme"];

  it("buckets repos under their root, labelled by the folder's last segment", () => {
    const groups = groupReposByRoot(repos, roots);
    expect(groups.map((g) => [g.label, g.repos.map((r) => r.id)])).toEqual([
      ["pwrdrvr", ["pwrgit"]],
      ["github", ["kit"]],
      ["Acme", ["acme-svc"]],
      ["Other", ["loose"]]
    ]);
  });

  it("attributes to the longest matching root when roots nest", () => {
    const nested = ["/Users/h", "/Users/h/pwrdrvr"];
    const groups = groupReposByRoot(
      [repo({ id: "pwrgit", path: "/Users/h/pwrdrvr/PwrGit" })],
      nested
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.root).toBe("/Users/h/pwrdrvr");
  });

  it("drops empty groups and omits Other when all repos are placed", () => {
    const groups = groupReposByRoot([repos[0]!], roots);
    expect(groups.map((g) => g.label)).toEqual(["Acme"]);
  });

  it("matches Windows repo paths against backslash roots, case-insensitively", () => {
    // Real Windows shape: repo paths come from `git worktree list` as
    // true-case forward-slash paths, roots from the folder picker with the
    // shell's separators and casing. Same directories, different strings.
    const winRepos = [
      repo({ id: "acme-svc", path: "C:/Users/runneradmin/Temp/a/repos/acme-svc" }),
      repo({ id: "pwr-svc", path: "C:/Users/runneradmin/Temp/b/repos/pwr-svc" })
    ];
    const winRoots = [
      "C:\\Users\\RUNNERADMIN\\Temp\\a\\repos",
      "C:\\Users\\RUNNERADMIN\\Temp\\b\\repos"
    ];
    const groups = groupReposByRoot(winRepos, winRoots);
    expect(groups.map((g) => [g.label, g.repos.map((r) => r.id)])).toEqual([
      ["repos", ["acme-svc"]],
      ["repos", ["pwr-svc"]]
    ]);
  });
});

describe("repoPrimaryBehind", () => {
  it("reflects the primary checkout, not the max across worktrees", () => {
    const r = repo({
      id: "svc",
      worktrees: [
        wt({ id: "p", branch: "develop", isPrimary: true, behind: 0 }),
        wt({ id: "f", branch: "feature", behind: 5 })
      ]
    });
    expect(repoPrimaryBehind(r)).toBe(0);
  });

  it("reports the primary's own behind count", () => {
    const r = repo({
      id: "svc",
      worktrees: [
        wt({ id: "p", branch: "develop", isPrimary: true, behind: 3 }),
        wt({ id: "f", branch: "feature", behind: 5 })
      ]
    });
    expect(repoPrimaryBehind(r)).toBe(3);
  });

  it("falls back to the first worktree when none is flagged primary", () => {
    const r = repo({ id: "svc", worktrees: [wt({ id: "a", branch: "x", behind: 2 })] });
    expect(repoPrimaryBehind(r)).toBe(2);
  });
});

describe("staleness with PR status", () => {
  const recently = new Date().toISOString();
  const mergedPr = { number: 5, url: "u", title: "t", state: "merged" as const, isDraft: false };

  it("prunes a merged-PR worktree at any age (catches squash/rebase merges)", () => {
    const w = wt({
      id: "m",
      branch: "feat/squashed",
      mergedIntoDefault: false,
      divergedFromDefault: false,
      lastActivityAt: recently,
      pr: mergedPr
    });
    expect(isPrunableWorktree(w)).toBe(true);
  });

  it("does not prune on an open PR, and not while dirty even if merged", () => {
    const open = wt({
      id: "o",
      branch: "feat/open",
      lastActivityAt: recently,
      pr: { number: 1, url: "u", title: "t", state: "open", isDraft: false }
    });
    expect(isPrunableWorktree(open)).toBe(false);
    expect(isPrunableWorktree({ ...open, dirty: 1, pr: mergedPr })).toBe(false);
  });
});

describe("formatLensCount", () => {
  it("leaves counts under a thousand alone", () => {
    for (const n of [0, 1, 42, 109, 999]) {
      expect(formatLensCount(n)).toBe(String(n));
    }
  });

  it("abbreviates thousands, dropping a trailing .0", () => {
    expect(formatLensCount(1000)).toBe("1K");
    expect(formatLensCount(1100)).toBe("1.1K");
    expect(formatLensCount(1200)).toBe("1.2K");
    expect(formatLensCount(9900)).toBe("9.9K");
  });

  // A count is a floor — "at least this many" — so it must never round up and
  // claim repos that aren't there.
  it("truncates rather than rounds", () => {
    expect(formatLensCount(1999)).toBe("1.9K");
    expect(formatLensCount(1150)).toBe("1.1K");
    expect(formatLensCount(999_999)).toBe("999K");
  });

  it("drops the decimal past ten of a unit", () => {
    expect(formatLensCount(10_000)).toBe("10K");
    expect(formatLensCount(10_400)).toBe("10K");
    expect(formatLensCount(42_000)).toBe("42K");
  });

  it("carries into millions rather than emitting 1000K", () => {
    expect(formatLensCount(1_000_000)).toBe("1M");
    expect(formatLensCount(1_250_000)).toBe("1.2M");
  });

  it("stays within five glyphs, which is what the chip has room for", () => {
    for (const n of [999, 1000, 1999, 10_400, 999_999, 1_250_000]) {
      expect(formatLensCount(n).length).toBeLessThanOrEqual(5);
    }
  });

  it("does not throw on non-finite input", () => {
    expect(formatLensCount(Number.NaN)).toBe("NaN");
    expect(formatLensCount(Number.POSITIVE_INFINITY)).toBe("Infinity");
  });
});

describe("worktreeFolderLabel", () => {
  it("stays silent when the branch is also the directory name", () => {
    expect(
      worktreeFolderLabel("feat/graph-x", "/wt/PwrGit/feat/graph-x")
    ).toBeNull();
    expect(worktreeFolderLabel("main", "/repos/PwrGit/main")).toBeNull();
  });

  it("stays silent when the directory holds the branch's last segment", () => {
    // The usual worktree layout: `git worktree add ../graph-x feat/graph-x`.
    expect(worktreeFolderLabel("feat/graph-x", "/wt/graph-x")).toBeNull();
  });

  it("stays silent when only the separators differ", () => {
    // A branch name can carry characters a directory cannot, and each tool
    // flattens them its own way — that is the same name, not a second one.
    expect(worktreeFolderLabel("feat/graph-x", "/wt/feat-graph-x")).toBeNull();
    expect(worktreeFolderLabel("fix.this_thing", "/wt/fix-this-thing")).toBeNull();
    expect(worktreeFolderLabel("Feat/Graph-X", "/wt/feat-graph-x")).toBeNull();
  });

  // The case this exists for: an agent named the directory after the branch it
  // created, then renamed or recreated the branch underneath it.
  it("names the directory when the branch no longer matches it", () => {
    expect(
      worktreeFolderLabel(
        "dmg-file-art-update-4fd193",
        "/Users/me/claude-worktrees/PwrSnap/recursing-euler-9edf74"
      )
    ).toBe("recursing-euler-9edf74");
  });

  it("names the directory for a detached checkout, which has no branch", () => {
    expect(worktreeFolderLabel("detached@2ffe55f", "/wt/release-audit")).toBe(
      "release-audit"
    );
  });

  it("takes further names that make the directory redundant", () => {
    // A repo's primary checkout lives in the repo's own folder, already named
    // by the folder row above it.
    expect(worktreeFolderLabel("main", "/repos/PwrSnap", ["PwrSnap"])).toBeNull();
    expect(worktreeFolderLabel("main", "/repos/PwrSnap", [undefined])).toBe(
      "PwrSnap"
    );
  });

  it("reads a Windows path's last segment", () => {
    expect(
      worktreeFolderLabel("feature/login", "C:/Users/me/wt/other-dir")
    ).toBe("other-dir");
    expect(
      worktreeFolderLabel("feature/login", "C:\\Users\\me\\wt\\login")
    ).toBeNull();
  });

  it("has nothing to say about a path with no segments", () => {
    expect(worktreeFolderLabel("main", "")).toBeNull();
  });

  it("compares non-Latin names as themselves, not as empty strings", () => {
    expect(worktreeFolderLabel("機能/検索", "/wt/検索")).toBeNull();
    expect(worktreeFolderLabel("機能/検索", "/wt/設定")).toBe("設定");
  });
});
