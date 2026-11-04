import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  layoutLanes,
  type LaneCommit,
  type LaneLayout,
  type LaneRefs
} from "./lane-layout";

// Properties of the lineage layout over generated repository histories.
// Histories are built the way users build them: a list of git operations
// (commit, branch, merge, pull, push, checkout) replayed into commits, then
// ordered the way the app orders them (topoMergeCommits: newest committer
// date first among commits whose children are all drawn) and optionally cut
// to a window, as `git log -n` would.

const LOCAL = ["main", "f1", "f2", "f3"] as const;
const REMOTE = ["origin/main", "origin/team"] as const;
type LocalRef = (typeof LOCAL)[number];
type Ref = LocalRef | (typeof REMOTE)[number];
const REFS: readonly Ref[] = [...LOCAL, ...REMOTE];

type Op =
  /** A commit on any ref. On a remote ref, someone else pushed and we fetched. */
  | { kind: "commit"; ref: Ref }
  /** Create a branch (or, for origin/team, fetch a newly pushed one). */
  | { kind: "branch"; ref: "f1" | "f2" | "f3" | "origin/team"; from: Ref }
  /** `git merge`. On origin/main, a PR merged on the server, then fetched. */
  | { kind: "merge"; into: Ref; from: Ref; noFf: boolean }
  /** `git pull` on main: fast-forward to origin/main, else merge it. */
  | { kind: "pull" }
  /** `git push` of main: only a fast-forward is accepted. */
  | { kind: "push" }
  /** Check out a local branch in the viewed worktree. */
  | { kind: "checkout"; ref: LocalRef };

type Repo = {
  /** Every commit, oldest first; the index is its creation order. */
  commits: LaneCommit[];
  refs: Partial<Record<Ref, string>>;
  head: LocalRef;
};

function replay(ops: readonly Op[]): Repo {
  const commits: LaneCommit[] = [{ hash: "c0", parents: [] }];
  const byHash = new Map(commits.map((c) => [c.hash, c]));
  const refs: Partial<Record<Ref, string>> = { main: "c0", "origin/main": "c0" };
  let head: LocalRef = "main";
  const commit = (...parents: string[]): string => {
    const c = { hash: `c${commits.length}`, parents };
    commits.push(c);
    byHash.set(c.hash, c);
    return c.hash;
  };
  const isAncestor = (a: string, b: string) => reach(byHash, b).has(a);
  const merge = (into: Ref, from: Ref, noFf: boolean) => {
    const a = refs[into];
    const b = refs[from];
    if (a === undefined || b === undefined || a === b) return;
    // Only real merges: git refuses to merge in what is already there.
    if (isAncestor(b, a)) return;
    refs[into] = isAncestor(a, b) && !noFf ? b : commit(a, b);
  };
  for (const op of ops) {
    switch (op.kind) {
      case "commit":
        // A commit on a branch that does not exist yet starts it from main.
        refs[op.ref] = commit(refs[op.ref] ?? (refs.main as string));
        break;
      case "branch": {
        const from = refs[op.from];
        if (refs[op.ref] === undefined && from !== undefined) refs[op.ref] = from;
        break;
      }
      case "merge":
        merge(op.into, op.from, op.noFf);
        break;
      case "pull":
        merge("main", "origin/main", false);
        break;
      case "push": {
        const main = refs.main as string;
        if (isAncestor(refs["origin/main"] as string, main)) {
          refs["origin/main"] = main;
        }
        break;
      }
      case "checkout":
        if (refs[op.ref] !== undefined) head = op.ref;
        break;
    }
  }
  return { commits, refs, head };
}

/** Every commit reachable from `tip` through any parent link. */
function reach(
  byHash: Map<string, LaneCommit>,
  tip: string | undefined
): Set<string> {
  const seen = new Set<string>();
  const stack = tip === undefined ? [] : [tip];
  while (stack.length > 0) {
    const h = stack.pop() as string;
    if (seen.has(h)) continue;
    const c = byHash.get(h);
    if (c === undefined) continue;
    seen.add(h);
    stack.push(...c.parents);
  }
  return seen;
}

type Scenario = {
  ops: Op[];
  /** Clock skew: per-commit amounts subtracted from creation order. */
  skew: number[] | null;
  /** Keep only the newest N + 1 commits, like `git log -n`. */
  window: number | null;
};

type View = {
  repo: Repo;
  byHash: Map<string, LaneCommit>;
  /** The drawn window, in the app's order (newest first). */
  commits: LaneCommit[];
  refs: LaneRefs;
  layout: LaneLayout;
};

/** Lay the repo out exactly as LineageGraph would, every branch drawn. */
function view(repo: Repo, s: Scenario): View {
  const byHash = new Map(repo.commits.map((c) => [c.hash, c]));
  const date = (hash: string): number => {
    const i = Number(hash.slice(1));
    return s.skew === null ? i : i - (s.skew[i % s.skew.length] ?? 0);
  };

  // topoMergeCommits: Kahn's algorithm, newest committer date first.
  const childCount = new Map<string, number>();
  for (const c of repo.commits) {
    for (const p of c.parents) childCount.set(p, (childCount.get(p) ?? 0) + 1);
  }
  const ready = repo.commits.filter((c) => !childCount.has(c.hash)).reverse();
  const ordered: LaneCommit[] = [];
  while (ready.length > 0) {
    ready.sort((a, b) => date(b.hash) - date(a.hash));
    const c = ready.shift() as LaneCommit;
    ordered.push(c);
    for (const p of c.parents) {
      const n = (childCount.get(p) ?? 0) - 1;
      childCount.set(p, n);
      if (n === 0) ready.push(byHash.get(p) as LaneCommit);
    }
  }
  const commits =
    s.window === null ? ordered : ordered.slice(0, (s.window % ordered.length) + 1);

  const tips: Record<string, string[]> = {};
  for (const r of REFS) {
    const h = repo.refs[r];
    if (h !== undefined) (tips[h] ??= []).push(r);
  }
  // Every non-default branch is drawn, most recently committed first. (Real
  // scopes hide some; a hidden local branch then has no commits in the window
  // to measure "applied" against, which is out of scope here.)
  const shownBranches = (["f1", "f2", "f3", "origin/team"] as const)
    .filter((r) => repo.refs[r] !== undefined)
    .sort((a, b) => date(repo.refs[b] as string) - date(repo.refs[a] as string));
  const refs: LaneRefs = {
    tips,
    defaultBranch: "main",
    defaultRefTips: [repo.refs["origin/main"] as string],
    localRefTips: LOCAL.flatMap((r) => repo.refs[r] ?? []),
    remoteBranches: shownBranches.filter((r) => r === "origin/team"),
    headBranch: repo.head,
    shownBranches
  };
  return { repo, byHash, commits, refs, layout: layoutLanes(commits, refs) };
}

/** One line per drawn row, for failure messages: `c3 [c2,c1] lane 1`. */
function describeView(v: View): string {
  const names = (h: string) => {
    const ns = v.refs.tips[h];
    return ns === undefined ? "" : ` (${ns.join(", ")})`;
  };
  return v.commits
    .map((c, i) => {
      const row = v.layout.rows[i];
      return `${c.hash}${names(c.hash)} [${c.parents.join(",")}] lane ${row?.lane}`;
    })
    .join("\n");
}

const anyRef = fc.constantFrom(...REFS);
const feature = fc.constantFrom("f1", "f2", "f3", "origin/team" as const);
const weighted = <T,>(...xs: [T, number][]) =>
  fc.oneof(...xs.map(([v, weight]) => ({ arbitrary: fc.constant(v), weight })));
const kind = <K extends Op["kind"]>(k: K) => fc.constant(k);
const merge = (into: fc.Arbitrary<Ref>, from: fc.Arbitrary<Ref>) =>
  fc.record({ kind: kind("merge"), into, from, noFf: fc.boolean() });
// Weighted like a team's day: PRs land on origin/main, features update from a
// local main that is often stale, and pulls are occasional. That staleness is
// what puts a merge of old trunk history above the trunk's newest commit.
const op: fc.Arbitrary<Op> = fc.oneof(
  {
    arbitrary: fc.record({
      kind: kind("commit"),
      ref: weighted<Ref>(
        ["f1", 3],
        ["f2", 3],
        ["f3", 3],
        ["origin/team", 2],
        ["origin/main", 2],
        ["main", 1]
      )
    }),
    weight: 6
  },
  {
    arbitrary: fc.record({ kind: kind("branch"), ref: feature, from: anyRef }),
    weight: 1
  },
  { arbitrary: merge(feature, fc.constant("main")), weight: 4 },
  { arbitrary: merge(fc.constant("origin/main"), feature), weight: 3 },
  { arbitrary: merge(anyRef, anyRef), weight: 2 },
  { arbitrary: fc.record({ kind: kind("pull") }), weight: 1 },
  { arbitrary: fc.record({ kind: kind("push") }), weight: 1 },
  {
    arbitrary: fc.record({ kind: kind("checkout"), ref: fc.constantFrom(...LOCAL) }),
    weight: 1
  }
);
const scenario: fc.Arbitrary<Scenario> = fc.record({
  ops: fc.array(op, { maxLength: 40, size: "max" }),
  skew: fc.oneof(
    { arbitrary: fc.constant(null), weight: 3 },
    { arbitrary: fc.array(fc.nat(6), { minLength: 1, maxLength: 8 }), weight: 1 }
  ),
  window: fc.oneof(
    { arbitrary: fc.constant(null), weight: 2 },
    { arbitrary: fc.nat(40), weight: 1 }
  )
});

/** Run assertions; on failure, append the drawn history to the message. */
function check(v: View, body: () => void): void {
  try {
    body();
  } catch (e) {
    if (e instanceof Error) e.message += `\n${describeView(v)}`;
    throw e;
  }
}

/** Lane of each drawn commit. */
const lanesOf = (v: View) =>
  new Map(v.commits.map((c, i) => [c.hash, v.layout.rows[i].lane]));

/** Replay, then bring main and origin/main together the way a user does. */
const replaySynced = (ops: readonly Op[]) =>
  replay([...ops, { kind: "pull" }, { kind: "push" }]);

describe("layoutLanes properties", () => {
  it("dashes a commit's first-parent line exactly when it is fetched but not applied", () => {
    // The rule in lane-layout.ts: the trunk is unapplied until local main
    // reaches it; a remote-only branch is unapplied until ANY local ref does.
    fc.assert(
      fc.property(scenario, (s) => {
        const v = view(replay(s.ops), s);
        const { refs } = v.repo;
        const fromOrigin = reach(v.byHash, refs["origin/main"]);
        const fromMain = reach(v.byHash, refs.main);
        const fromTeam = reach(v.byHash, refs["origin/team"]);
        const fromLocal = new Set(
          LOCAL.flatMap((r) => [...reach(v.byHash, refs[r])])
        );
        check(v, () => {
          v.commits.forEach((c, i) => {
            if (c.parents.length === 0) return;
            const row = v.layout.rows[i];
            const line = row.bottom.find(
              (sg) => sg.from === row.lane && sg.to === row.lane
            );
            const unapplied =
              (fromOrigin.has(c.hash) && !fromMain.has(c.hash)) ||
              (fromTeam.has(c.hash) && !fromLocal.has(c.hash));
            expect(line?.dashed !== undefined, `${c.hash}'s first-parent line`).toBe(
              unapplied
            );
          });
        });
      })
    );
  });

  it("draws every edge as one continuous line in its own column", () => {
    fc.assert(
      fc.property(scenario, (s) => {
        const v = view(replay(s.ops), s);
        const { rows, laneCount } = v.layout;
        const childEdges = new Map<string, number>();
        let open = 0; // edges from drawn rows to parents not yet drawn
        check(v, () => {
          v.commits.forEach((c, i) => {
            const row = rows[i];
            const msg = `row ${i} (${c.hash})`;
            const children = childEdges.get(c.hash) ?? 0;
            for (const p of c.parents) childEdges.set(p, (childEdges.get(p) ?? 0) + 1);
            // One line enters the dot per drawn child edge, one leaves per parent.
            const entering = row.top.filter((sg) => sg.to === row.lane);
            expect(entering.length, msg).toBe(children);
            expect(row.bottom.filter((sg) => sg.from === row.lane).length, msg).toBe(
              c.parents.length
            );
            // Lines not touching the dot pass straight through.
            for (const sg of [...row.top, ...row.bottom]) {
              if (sg.from !== row.lane && sg.to !== row.lane) {
                expect(sg.from, msg).toBe(sg.to);
              }
            }
            // No two lines share a column at a row boundary.
            const tops = row.top.map((sg) => sg.from);
            const bottoms = row.bottom.map((sg) => sg.to);
            expect(new Set(tops).size, msg).toBe(tops.length);
            expect(new Set(bottoms).size, msg).toBe(bottoms.length);
            // Every column fits the gutter.
            for (const n of [row.lane, ...tops, ...bottoms]) {
              expect(n, msg).toBeLessThan(laneCount);
            }
            // A line never appears or vanishes between rows, nor changes dash.
            const key = (lane: number, dashed?: number) => `${lane}:${dashed ?? 0}`;
            const above = row.top.map((sg) => key(sg.from, sg.dashed)).sort();
            const below = i === 0 ? [] : rows[i - 1].bottom;
            const prev = below.map((sg) => key(sg.to, sg.dashed)).sort();
            expect(above, msg).toEqual(prev);
            open += c.parents.length - children;
            expect(row.bottom.length, msg).toBe(open);
          });
        });
      })
    );
  });

  it("keeps local main's first-parent chain on lane 0 when main is in sync", () => {
    // The promise: "lane 0 begins at its real tip and remains an honest
    // spine". With main == origin/main the spine starts at main's tip.
    fc.assert(
      fc.property(scenario, (s) => {
        const repo = replaySynced(s.ops);
        const v = view(repo, s);
        const lane = lanesOf(v);
        check(v, () => {
          for (
            let h: string | undefined = repo.refs.main;
            h !== undefined && lane.has(h);
            h = v.byHash.get(h)?.parents[0]
          ) {
            expect(lane.get(h), `${h} is on main's first-parent chain`).toBe(0);
          }
        });
      })
    );
  });

  it("keeps the checked-out branch's own line on lane 1", () => {
    // The promise: "Lane 1 is reserved for the worktree's checked-out branch
    // tip". Its own line is its first-parent chain down to the spine or to
    // another drawn branch's tip. Main is synced so the spine is main's chain.
    fc.assert(
      fc.property(scenario, (s) => {
        const repo = replaySynced(s.ops);
        const v = view(repo, s);
        const lane = lanesOf(v);
        const headTip = repo.refs[repo.head];
        const mainTip = repo.refs.main as string;
        if (repo.head === "main" || headTip === undefined) return;
        if (!lane.has(headTip) || !lane.has(mainTip)) return;
        const spine = new Set<string>();
        for (let h: string | undefined = mainTip; h !== undefined; ) {
          spine.add(h);
          h = v.byHash.get(h)?.parents[0];
        }
        const otherTips = new Set(
          REFS.filter((r) => r !== "origin/main" && r !== repo.head).flatMap(
            (r) => repo.refs[r] ?? []
          )
        );
        check(v, () => {
          for (
            let h: string | undefined = headTip;
            h !== undefined && lane.has(h) && !spine.has(h);
            h = v.byHash.get(h)?.parents[0]
          ) {
            if (h !== headTip && otherTips.has(h)) break;
            expect(lane.get(h), `${h} is ${repo.head}'s own line`).toBe(1);
          }
        });
      })
    );
  });
});
