import { StrictMode, useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { ok, type Commit, type LaneGraph, type CommitAuthorPerson } from "@pwrgit/shared";
import { LineageGraph } from "../../../src/renderer/src/features/graph/LineageGraph";
import "../../../src/renderer/src/styles/app.css";

const repoId = "demo";
const worktreeId = "demo-wt";
const hash = (i: number) => i.toString(16).padStart(40, "0");
const commit = (i: number, parents: string[]): Commit => ({
  hash: hash(i),
  shortHash: i.toString(16).padStart(7, "0"),
  parents,
  subject: `Widget change ${i}`,
  authorName: `Author ${i % 64}`,
  authorEmail: `author${i % 64}@example.test`,
  committedAt: new Date(Date.UTC(2026, 10, 18) - (1500 - i) * 3600000).toISOString(),
  isMerge: parents.length > 1
});
const trunk = Array.from({ length: 780 }, (_, index) =>
  commit(780 - index, index < 779 ? [hash(779 - index)] : [])
);
const tips: Record<string, string[]> = { [trunk[0]!.hash]: ["main"] };
const remoteTips: Record<string, string[]> = { [trunk[0]!.hash]: ["origin/main"] };
const branches: LaneGraph["branches"] = { main: { worktreeId, worktreePath: "/synthetic/widget" } };
const shownBranches: string[] = [];
const side: Commit[] = [];
for (let branch = 0; branch < 22; branch++) {
  const name = `widgets/set-${branch}`;
  const tip = 800 + (branch + 1) * 10;
  shownBranches.push(name);
  tips[hash(tip)] = [name];
  remoteTips[hash(tip - 2)] = [`origin/${name}`];
  branches[name] = {};
  for (let offset = 0; offset < 10; offset++) {
    side.push(commit(tip - offset, [offset === 9 ? hash(755 - branch * 11) : hash(tip - offset - 1)]));
  }
}
const base: LaneGraph = {
  commits: [...side, ...trunk],
  branches, tips, remoteTips, head: trunk[0]!.hash, headOnlyCommits: [],
  defaultBranch: "main", defaultRef: "origin/main", defaultRefTips: [trunk[0]!.hash],
  shownBranches, upstreamRefs: [], matchedBranches: shownBranches.length, hiddenBranches: 0
};
const nextHash = hash(1200);
const additions: LaneGraph = {
  ...base,
  commits: [commit(1200, [base.head]), ...base.commits],
  head: nextHash,
  tips: { ...tips, [base.head]: [], [nextHash]: ["main"] },
  remoteTips: { ...remoteTips, [base.head]: [], [nextHash]: ["origin/main"] },
  defaultRefTips: [nextHash]
};
const movedOriginMainHash = trunk[1]!.hash;
const movedRefs: LaneGraph = {
  ...base,
  remoteTips: { ...remoteTips, [base.head]: [], [movedOriginMainHash]: ["origin/main"] },
  defaultRefTips: [movedOriginMainHash]
};
const people: Record<string, CommitAuthorPerson> = Object.fromEntries(
  Array.from({ length: 64 }, (_, i) => [`author${i}@example.test`, { state: "none", checkedAt: 100 }])
);
let response = base;
let graphRequests = 0;
let peopleAnswers = 0;
let searchChanges = 0;
const listeners = new Map<string, Set<(payload: unknown) => void>>();
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const frames = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
const longTasks: PerformanceEntry[] = [];
new PerformanceObserver(({ getEntries }) => longTasks.push(...getEntries())).observe({ entryTypes: ["longtask"] });

window.pwrgit = {
  platform: "darwin", profileId: "demo", appearance: { theme: "light", resolvedTheme: "light" },
  getAppMenuModel: async () => [], popupAppMenu: () => {}, runWindowControl: async () => {},
  readWindowFrameState: async () => null, onWindowFrameState: () => () => {},
  dispatch: async (name, request) => {
    if (name === "graph:lanes") {
      graphRequests++;
      const graph = response;
      await wait(5);
      return ok(structuredClone(graph));
    }
    if (name === "people:replaceInterest") {
      if (!(request as { authors: unknown[] }).authors.length) return ok({});
      await wait(15);
      peopleAnswers++;
      return ok(structuredClone(people));
    }
    if (name === "settings:read") return ok({ experimental: { lineageAllBranches: false } });
    return ok({});
  },
  on: (name, listener) => {
    const set = listeners.get(name) ?? new Set();
    listeners.set(name, set);
    set.add(listener);
    return () => set.delete(listener);
  }
};

const noop = () => {};
const selection = new Set([trunk[2]!.hash]);
function App() {
  const [commits, setCommits] = useState<Commit[]>([]);
  const publish = useCallback((commits: Commit[]) => {
    searchChanges++;
    setCommits(commits);
  }, []);
  return <main style={{ height: "100vh", display: "flex", flexDirection: "column" }} data-history-count={commits.length}>
    <LineageGraph repoId={repoId} repoName="Widgets" worktreeId={worktreeId}
      worktreePath="/synthetic/widget" viewingBranch="main" activeEmail="author0@example.test"
      selectedCommits={selection} focusedCommit={null} revealCommit={null} tidyOffered={false}
      onEditHistory={noop} onCommitsChange={publish} onOpenCommit={() => {}}
      onRevealWorktree={() => {}} onRevealCreatedWorktree={() => {}} />
  </main>;
}
const metrics = () => ({ graphRequests, peopleAnswers, searchChanges, commits: window.graphCommits });
export const graphBench = {
  movedOriginMainHash,
  async ready() {
    while (document.querySelectorAll(".graph-row").length < 1000) await wait(10);
    await document.fonts.ready;
    await frames();
  },
  async refresh(kind: "equal" | "refs" | "new-commit") {
    response = kind === "refs" ? movedRefs : kind === "new-commit" ? additions : base;
    const before = metrics();
    const start = performance.now();
    for (const listener of listeners.get("graph:changed") ?? []) listener({ repoId });
    while (peopleAnswers === before.peopleAnswers) await wait(2);
    await frames();
    await wait(0);
    const end = performance.now();
    const after = metrics();
    const tasks = longTasks.filter(task => task.startTime >= start && task.startTime <= end);
    // The aligned default branch chip is compact ("origin"). Include both
    // forms so a stale chip at the old tip also fails the ref move check.
    const originMainChips = kind === "refs"
      ? [...document.querySelectorAll(".ref-chip--remote .ref-chip__name")].flatMap((chip) => {
        const name = chip.textContent;
        return name === "origin/main" || name === "origin"
          ? [{ name, hash: chip.closest<HTMLElement>(".graph-row")?.dataset.hash }]
          : [];
      })
      : [];
    return {
      wallMs: end - start, longTasks: tasks.length, longest: Math.max(0, ...tasks.map(task => task.duration)),
      commits: after.commits - before.commits, graphRequests: after.graphRequests - before.graphRequests,
      peopleAnswers: after.peopleAnswers - before.peopleAnswers, searchChanges: after.searchChanges - before.searchChanges,
      rows: document.querySelectorAll(".graph-row").length,
      originMainChips,
      timingEnabled: typeof console.timeStamp === "function"
    };
  }
};
declare global {
  interface Window {
    graphBench: typeof graphBench;
    graphCommits: number;
  }
}
window.graphBench = graphBench;
createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
