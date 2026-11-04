import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Commit } from "@pwrgit/shared";
import { topoMergeCommits } from "../../../../main/git/git-service";
import {
  layoutLanes,
  type LaneCommit,
  type LaneLayout,
  type LaneRefs
} from "./lane-layout";

// Properties of the lineage layout over generated repository histories.
// Histories are built the way users build them: a list of git operations
// (commit, branch, merge, pull, push, publish) replayed into commits, then
// ordered by the app's own topoMergeCommits and optionally cut to a window,
// as `git log -n` would. Feature branches f1–f3 track origin/f1–f3 once
// published, so a checked-out branch can be behind or diverged from its
// upstream (LaneRefs.headUpstream).

const FEATURES = ["f1", "f2", "f3"] as const;
const LOCAL = ["main", ...FEATURES] as const;
const UPSTREAMS = ["origin/f1", "origin/f2", "origin/f3"] as const;
const REMOTE = ["origin/main", "origin/team", ...UPSTREAMS] as const;
type Feature = (typeof FEATURES)[number];
type LocalRef = (typeof LOCAL)[number];
type Ref = LocalRef | (typeof REMOTE)[number];
const REFS: readonly Ref[] = [...LOCAL, ...REMOTE];
/** The ref fN tracks once published. */
const trackingRef = (f: Feature) => `origin/${f}` as const;
const isIn = (group: readonly Ref[], r: Ref): boolean => group.includes(r);

type Op =
  /** A commit on any ref. On a remote ref, someone else pushed and we fetched. */
  | { kind: "commit"; ref: Ref }
  /** `git push -u origin fN`: create or fast-forward fN's upstream. */
  | { kind: "publish"; ref: Feature }
  /** `git pull` on fN: fast-forward to origin/fN, else merge it. */
  | { kind: "pullBranch"; ref: Feature }
  /** Create a branch (or, for origin/team, fetch a newly pushed one). */
  | { kind: "branch"; ref: "f1" | "f2" | "f3" | "origin/team"; from: Ref }
  /** `git merge`. On origin/main, a PR merged on the server, then fetched. */
  | { kind: "merge"; into: Ref; from: Ref; noFf: boolean }
  /** `git pull` on main: fast-forward to origin/main, else merge it. */
  | { kind: "pull" }
  /** `git push` of main: only a fast-forward is accepted. */
  | { kind: "push" };

type Repo = {
  /** Every commit, oldest first; the index is its creation order. */
  commits: LaneCommit[];
  refs: Partial<Record<Ref, string>>;
  head: LocalRef;
};

/** Replay `ops`, with the viewed worktree on `checkedOut` once it exists. */
function replay(ops: readonly Op[], checkedOut: LocalRef): Repo {
  const commits: LaneCommit[] = [{ hash: "c0", parents: [] }];
  const byHash = new Map(commits.map((c) => [c.hash, c]));
  const refs: Partial<Record<Ref, string>> = { main: "c0", "origin/main": "c0" };
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
      case "commit": {
        // A commit on a branch that does not exist yet starts it from main.
        // An upstream exists only once its branch was published.
        const tip = refs[op.ref];
        if (tip === undefined && isIn(UPSTREAMS, op.ref)) break;
        refs[op.ref] = commit(tip ?? (refs.main as string));
        break;
      }
      case "publish": {
        const local = refs[op.ref];
        const remote = refs[trackingRef(op.ref)];
        if (local === undefined) break;
        // A push is accepted only as a fast-forward.
        if (remote === undefined || isAncestor(remote, local)) {
          refs[trackingRef(op.ref)] = local;
        }
        break;
      }
      case "pullBranch":
        merge(op.ref, trackingRef(op.ref), false);
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
    }
  }
  const head = refs[checkedOut] === undefined ? "main" : checkedOut;
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
  /** The branch the viewed worktree has checked out (main if it never
   *  came to exist). */
  head: LocalRef;
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
  /** Drawn refs that live on a remote: dashed until a local ref reaches them. */
  drawnRemotes: Ref[];
  layout: LaneLayout;
};

/** Lay the repo out exactly as LineageGraph would, every branch drawn. */
function view(repo: Repo, s: Scenario): View {
  const byHash = new Map(repo.commits.map((c) => [c.hash, c]));
  const date = (hash: string): number => {
    const i = Number(hash.slice(1));
    return s.skew === null ? i : i - (s.skew[i % s.skew.length] ?? 0);
  };

  // The app's own ordering, fed the way graph-handlers feeds it: a log,
  // newest first, carrying committer dates.
  const log: Commit[] = [...repo.commits].reverse().map((c) => ({
    hash: c.hash,
    shortHash: c.hash,
    parents: c.parents,
    subject: c.hash,
    authorName: "",
    authorEmail: "",
    committedAt: new Date(date(c.hash) * 60_000).toISOString(),
    isMerge: c.parents.length > 1
  }));
  const ordered: LaneCommit[] = topoMergeCommits([log]).map((c) => ({
    hash: c.hash,
    parents: c.parents
  }));
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
  const shown: Ref[] = [...FEATURES, "origin/team" as const]
    .filter((r) => repo.refs[r] !== undefined)
    .sort((a, b) => date(repo.refs[b] as string) - date(repo.refs[a] as string));
  // graph-handlers: a published branch whose upstream has commits it lacks
  // (`%(upstream:trackshort)` is `<` or `<>`) adds that upstream to the walk,
  // in `upstreamRefs`, and the checked-out branch's becomes `headUpstream`.
  const behind = new Map<Ref, Ref>();
  for (const f of FEATURES) {
    const local = repo.refs[f];
    const remote = repo.refs[trackingRef(f)];
    if (local === undefined || remote === undefined) continue;
    if (!reach(byHash, local).has(remote)) behind.set(f, trackingRef(f));
  }
  const upstreamRefs = shown.flatMap((b) => behind.get(b) ?? []);
  // LineageGraph draws the union, and every drawn remote name is passed as a
  // remote branch.
  const drawn = [...shown, ...upstreamRefs];
  const drawnRemotes = drawn.filter((r) => isIn(REMOTE, r));
  const headUpstream = behind.get(repo.head);
  const refs: LaneRefs = {
    tips,
    defaultBranch: "main",
    defaultRefTips: [repo.refs["origin/main"] as string],
    localRefTips: LOCAL.flatMap((r) => repo.refs[r] ?? []),
    remoteBranches: drawnRemotes,
    headBranch: repo.head,
    ...(headUpstream === undefined ? {} : { headUpstream }),
    shownBranches: drawn
  };
  return {
    repo,
    byHash,
    commits,
    refs,
    drawnRemotes,
    layout: layoutLanes(commits, refs)
  };
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
const feature = fc.constantFrom("f1", "f2", "f3", "origin/team");
const ownFeature = fc.constantFrom(...FEATURES);
const weighted = <T,>(...xs: [T, number][]) =>
  fc.oneof(...xs.map(([v, weight]) => ({ arbitrary: fc.constant(v), weight })));
const kind = <K extends Op["kind"]>(k: K) => fc.constant(k);
const mergeOp = (into: fc.Arbitrary<Ref>, from: fc.Arbitrary<Ref>) =>
  fc.record({ kind: kind("merge"), into, from, noFf: fc.boolean() });
// Weighted like a team's day: PRs land on origin/main, features update from a
// local main that is often stale, and pulls are occasional. That staleness is
// what puts a merge of old trunk history above the trunk's newest commit.
// Published branches get pushes from collaborators and GitHub's "Update
// branch" (origin/main merged into origin/fN), which leave the local branch
// behind or diverged from its upstream.
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
        ["main", 1],
        ["origin/f1", 3],
        ["origin/f2", 3],
        ["origin/f3", 3]
      )
    }),
    weight: 6
  },
  { arbitrary: fc.record({ kind: kind("publish"), ref: ownFeature }), weight: 4 },
  { arbitrary: fc.record({ kind: kind("pullBranch"), ref: ownFeature }), weight: 1 },
  {
    arbitrary: mergeOp(fc.constantFrom(...UPSTREAMS), fc.constant("origin/main")),
    weight: 2
  },
  {
    arbitrary: fc.record({ kind: kind("branch"), ref: feature, from: anyRef }),
    weight: 1
  },
  { arbitrary: mergeOp(feature, fc.constant("main")), weight: 4 },
  { arbitrary: mergeOp(fc.constant("origin/main"), feature), weight: 3 },
  { arbitrary: mergeOp(anyRef, anyRef), weight: 2 },
  { arbitrary: fc.record({ kind: kind("pull") }), weight: 1 },
  { arbitrary: fc.record({ kind: kind("push") }), weight: 1 }
);
const scenario: fc.Arbitrary<Scenario> = fc.record({
  ops: fc.array(op, { maxLength: 40, size: "max" }),
  head: weighted<LocalRef>(["f1", 2], ["f2", 2], ["f3", 2], ["main", 1]),
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

/** Scenarios that end by bringing main and origin/main together the way a
 *  user does, so a printed counterexample is exactly what was replayed. */
const synced: fc.Arbitrary<Scenario> = scenario.map((s) => ({
  ...s,
  ops: [...s.ops, { kind: "pull" }, { kind: "push" }]
}));

describe("layoutLanes properties", () => {
  it("dashes a commit's first-parent line exactly when it is fetched but not applied", () => {
    // The rule in lane-layout.ts: the trunk is unapplied until local main
    // reaches it. Any other drawn remote ref (a remote-only branch, or the
    // upstream a branch is behind) is unapplied until ANY local ref does.
    fc.assert(
      fc.property(scenario, (s) => {
        const v = view(replay(s.ops, s.head), s);
        const { refs } = v.repo;
        const fromOrigin = reach(v.byHash, refs["origin/main"]);
        const fromMain = reach(v.byHash, refs.main);
        const fromRemotes = new Set(
          v.drawnRemotes.flatMap((r) => [...reach(v.byHash, refs[r])])
        );
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
              (fromRemotes.has(c.hash) && !fromLocal.has(c.hash));
            const msg = `${c.hash}'s first-parent line`;
            expect(line, msg).toBeDefined();
            expect(line?.dashed !== undefined, msg).toBe(unapplied);
          });
        });
      })
    );
  });

  it("draws every edge as one continuous line in its own column", () => {
    fc.assert(
      fc.property(scenario, (s) => {
        const v = view(replay(s.ops, s.head), s);
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
      fc.property(synced, (s) => {
        const repo = replay(s.ops, s.head);
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
    // another drawn branch's tip. When its upstream is a fast-forward ahead
    // (no other drawn tip between them), the line starts at the upstream's
    // tip instead. Main is synced so the spine is main's chain.
    fc.assert(
      fc.property(synced, (s) => {
        const repo = replay(s.ops, s.head);
        const v = view(repo, s);
        const lane = lanesOf(v);
        const parent = (h: string) => v.byHash.get(h)?.parents[0];
        const headTip = repo.refs[repo.head];
        const mainTip = repo.refs.main as string;
        if (repo.head === "main" || headTip === undefined) return;
        if (!lane.has(headTip) || !lane.has(mainTip)) return;
        const spine = new Set<string>();
        for (let h: string | undefined = mainTip; h !== undefined; h = parent(h)) {
          spine.add(h);
        }
        const drawnTips = new Set(
          ["main", repo.head, ...v.refs.shownBranches].flatMap(
            (r) => repo.refs[r as Ref] ?? []
          )
        );
        let start = headTip;
        const upTip =
          v.refs.headUpstream === undefined
            ? undefined
            : repo.refs[v.refs.headUpstream as Ref];
        for (let h = upTip; h !== undefined && lane.has(h); h = parent(h)) {
          if (h === headTip) {
            start = upTip as string;
            break;
          }
          if (h !== upTip && drawnTips.has(h)) break;
        }
        const line: string[] = [];
        for (
          let h: string | undefined = start;
          h !== undefined && lane.has(h) && !spine.has(h);
          h = parent(h)
        ) {
          if (h !== start && h !== headTip && drawnTips.has(h)) break;
          line.push(h);
        }
        // Only a branch that owns its tip has a line, and a reserved lane.
        if (!line.includes(headTip)) return;
        check(v, () => {
          for (const h of line) {
            expect(lane.get(h), `${h} is ${repo.head}'s own line`).toBe(1);
          }
        });
      })
    );
  });
});
