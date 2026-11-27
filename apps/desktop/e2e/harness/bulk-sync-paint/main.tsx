import {
  EXPERIMENTAL_DEFAULTS,
  type BulkSyncProgress,
  type BulkSyncRepoResult,
  type BulkSyncSummary,
  type LaneGraph,
  type Profile,
  type Repo
} from "@pwrgit/shared";
import { useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { LineageGraph } from "../../../src/renderer/src/features/graph/LineageGraph";
import { ChangesTab } from "../../../src/renderer/src/features/rail/ChangesTab";
import { Sidebar } from "../../../src/renderer/src/features/sidebar/Sidebar";
import {
  BULK_SYNC_VIEW_KEY,
  FETCH_INTERVAL_KEY,
  FETCH_SCOPE_KEY,
  SYNC_VERB_KEY
} from "../../../src/renderer/src/features/sidebar/bulk-sync-prefs";
import { useRepoTree } from "../../../src/renderer/src/state/useRepoTree";
import "../../../src/renderer/src/styles/app.css";

const profile: Profile = {
  id: "demo",
  name: "Widget Studio",
  email: "demo@example.test",
  mono: "WS",
  roots: ["/example/widgets"],
  onboardingCompleted: true,
  showInMenu: true
};
const profiles = [profile];
const manual = new URLSearchParams(location.search).has("manual");
const recent = new Date().toISOString();
const familySize = 210;
const repos: Repo[] = Array.from({ length: 30 }, (_, i) => {
  const id = `fixture-${i + 1}`;
  const name = `widget-${String(i + 1).padStart(2, "0")}`;
  const path = `${profile.roots[0]}/${name}`;
  return {
    id, name, path, profileId: profile.id, pinned: false,
    worktrees: Array.from({ length: manual && i === 0 ? familySize + 1 : 1 }, (_, j) => ({
      id: j === 0 ? `${id}-main` : `${id}-tree-${j}`, repoId: id,
      path: j === 0 ? path : `${path}/.worktrees/task-${j}`,
      branch: j === 0 ? "main" : `task-${j}`, defaultBranch: "main",
      dirty: 0, ahead: 0, behind: j < 8 ? 1 : 0, behindDefault: 0, isPrimary: j === 0, pinned: false,
      isDefaultBranch: j === 0, mergedIntoDefault: false, divergedFromDefault: false,
      ...(manual ? { lastAuthoredAt: recent } : {}),
      ...(manual && j < 8 ? { lastActivityAt: recent } : {})
    }))
  };
});
const results: BulkSyncRepoResult[] = repos.map((repo, i) => ({
  repoId: repo.id, name: repo.name, path: repo.path,
  outcome: i === 5 ? "skipped" : "success",
  remotes: [{ remote: "origin", outcome: "fetched" }],
  worktrees: repo.worktrees.map((tree) => ({
    worktreeId: tree.id, path: tree.path, branch: tree.branch,
    ...(i === 5 ? { outcome: "skipped", reason: "dirty" } : { outcome: tree.behind > 0 ? "updated" : "up_to_date" })
  }))
}));

const selected = repos[0]!.worktrees[0]!;
const hash = (i: number) => (i + 1).toString(16).padStart(7, "0").padEnd(40, "0");
const graph: LaneGraph = {
  commits: Array.from({ length: 44 }, (_, i) => ({
    hash: hash(i), shortHash: hash(i).slice(0, 7), parents: i < 43 ? [hash(i + 1)] : [],
    subject: ["Build the widget catalog", "Polish search filters", "Refresh demo projects"][i % 3]!,
    authorName: "Widget Author", authorEmail: profile.email,
    committedAt: new Date(Date.now() - i * 3600_000).toISOString(), isMerge: false
  })),
  tips: { [hash(0)]: ["main"], [hash(3)]: ["catalog"], [hash(9)]: ["search"] },
  remoteTips: {}, branches: {}, head: hash(0), headOnlyCommits: [],
  defaultBranch: "main", defaultRef: "main", defaultRefTips: [hash(0)],
  shownBranches: [], upstreamRefs: [], matchedBranches: 3, hiddenBranches: 0
};
const refreshedGraph: LaneGraph = {
  ...graph,
  commits: [{
    ...graph.commits[0]!, hash: hash(44), shortHash: hash(44).slice(0, 7),
    parents: [hash(0)], subject: "Publish the widget catalog"
  }, ...graph.commits],
  tips: { [hash(44)]: ["main"], [hash(3)]: ["catalog"], [hash(9)]: ["search"] },
  head: hash(44), defaultRefTips: [hash(44)]
};

const listeners = new Map<string, Set<(payload: unknown) => void>>();
const emit = (event: string, payload: unknown) => {
  for (const handler of listeners.get(event) ?? []) handler(payload);
};
const updated = new Set<string>();
let committedRepos: Repo[] = [];
let run: { id: string; finish: (summary: BulkSyncSummary) => void } | undefined;
let completed = 0;
let targetedReads = 0;
let repoTreeCommits = 0;
let detailEvents = 0;
let graphReads = 0;
let changesReads = 0;
let intervalTick: (() => void) | undefined;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

Object.assign(window, {
  pwrgit: {
    profileId: profile.id,
    platform: "darwin",
    on(event: string, handler: (payload: unknown) => void) {
      const handlers = listeners.get(event) ?? new Set();
      handlers.add(handler);
      listeners.set(event, handlers);
      return () => handlers.delete(handler);
    },
    async dispatch(command: string, request?: { repoIds?: string[]; operationId?: string; mode?: string }) {
      switch (command) {
        case "settings:read":
          return { ok: true, value: {
            general: { tagCheckAfterSync: false },
            experimental: EXPERIMENTAL_DEFAULTS
          } };
        case "repo:list": {
          const ids = request?.repoIds;
          if (ids !== undefined) {
            targetedReads++;
            await delay(4);
          }
          const visible = ids === undefined ? repos : repos.filter((repo) => ids.includes(repo.id));
          return { ok: true, value: visible.map((repo) => ({
            ...repo,
            worktrees: repo.worktrees.map((tree) => ({
              ...tree, behind: updated.has(repo.id) ? 0 : tree.behind
            }))
          })) };
        }
        case "repo:refs":
          return { ok: true, value: { branches: [], remotes: [], previewTags: [], tagCount: 0 } };
        case "graph:lanes":
          graphReads++;
          return { ok: true, value: updated.has(selected.repoId) ? refreshedGraph : graph };
        case "people:replaceInterest":
          return { ok: true, value: {} };
        case "changes:list":
          changesReads++;
          return { ok: true, value: { staged: [], unstaged: [] } };
        case "submodules:list":
          return { ok: true, value: { submodules: [], truncated: false, issues: [] } };
        case "changes:ignoredSummary":
        case "identity:inspect":
          return { ok: true, value: null };
        case "remote:bulkSync": {
          const { operationId, mode, repoIds } = request ?? {};
          if (operationId === undefined || mode !== "soft-pull" || (manual && repoIds?.length !== repos.length)) {
            throw new Error("Unexpected soft pull request");
          }
          return new Promise((resolve) => {
            run = { id: operationId, finish: (summary) => resolve({ ok: true, value: summary }) };
          });
        }
        case "remote:cancelBulkSync":
          return { ok: true, value: undefined };
        default:
          return { ok: false, error: { message: `Fixture has no response for ${command}` } };
      }
    }
  }
});
document.documentElement.dataset["platform"] = "darwin";
localStorage.setItem(FETCH_INTERVAL_KEY, manual ? "0" : "5");
localStorage.setItem(SYNC_VERB_KEY, "pull");
localStorage.setItem(FETCH_SCOPE_KEY, manual ? "recent" : "all");
if (manual) {
  localStorage.setItem(BULK_SYNC_VIEW_KEY, "toast");
  localStorage.setItem(`pwrgit.unpinnedWorktreesOpen.${selected.repoId}`, "1");
}

// Run the real five-minute timer callback on demand, with normal time for
// React, ResizeObserver, and all CSS animation. No Git or external IPC runs.
const setIntervalReal = (window as Window).setInterval.bind(window);
(window as Window).setInterval = (handler, ms, ...args: unknown[]) => {
  if (ms === 300_000 && typeof handler === "function") {
    intervalTick = () => handler(...args);
  }
  return setIntervalReal(handler, ms, ...args);
};

const noop = () => undefined;
const ready = { status: "ready" } as const;
const selectedCommits = new Set<string>();
function App() {
  const tree = useRepoTree(profile.id);
  useLayoutEffect(() => {
    committedRepos = tree.repos;
    repoTreeCommits++;
  }, [tree.repos]);
  return (
    <div style={{ display: "flex", height: "100vh" }}>
      <div className="pane pane--sidebar" style={{ width: manual ? 440 : 320 }}>
        <Sidebar
          profiles={profiles} activeProfile={profile}
          profileLoadState={ready} onRetryProfiles={noop} onSwitchProfile={noop}
          repos={tree.repos} repoLoadState={tree.loadState} onRetryRepos={tree.retry}
          selectedWorktreeId={selected.id} onSelectWorktree={noop}
          onSetRepoPin={noop} onSetWorktreePin={noop} onSetBranchPin={noop}
          onRemoveWorktree={noop} onRemoveWorktrees={tree.removeWorktrees}
          onCreateWorktree={async () => null} onPersistOrder={noop} onPersistRepoOrder={noop}
          refreshingRepoIds={tree.refreshingRepoIds} onRefreshRepo={noop} onRefreshPullRequest={noop}
          onCloneRepo={noop} onForkRepo={noop} onForkCheckout={noop} onAddFolder={noop}
          onExpandRepo={noop} onNewProfile={noop} onManageProfile={noop}
        />
      </div>
      {manual && (
        <>
          <div className="pane pane--main" style={{ flex: 1 }}>
            <LineageGraph
              repoId={selected.repoId} repoName={repos[0]!.name} worktreeId={selected.id}
              worktreePath={selected.path} viewingBranch="main" activeEmail={profile.email}
              selectedCommits={selectedCommits} focusedCommit={null} revealCommit={null}
              onEditHistory={noop} onCommitsChange={noop} onOpenCommit={noop}
              onRevealWorktree={noop} onRevealCreatedWorktree={noop}
            />
          </div>
          <div className="pane pane--rail" style={{ width: 340 }}>
            <ChangesTab worktree={selected} activeEmail={profile.email} activeFile={null}
              onOpenDiff={noop} onOpenFileInsight={noop} />
          </div>
        </>
      )}
    </div>
  );
}

function progress(phase: BulkSyncProgress["phase"], repo?: BulkSyncRepoResult, fields?: Partial<BulkSyncProgress>) {
  if (run === undefined) throw new Error("No pull in progress");
  const message: BulkSyncProgress = {
    operationId: run.id, mode: "soft-pull", phase, totalRepos: repos.length,
    completedRepos: completed, ...(repo && { repoId: repo.repoId, repoName: repo.name }),
    ...fields
  };
  if (phase === "repo_progress") detailEvents++;
  emit("remote:bulkSyncProgress", message);
}

async function start() {
  completed = 0;
  targetedReads = 0;
  detailEvents = 0;
  repoTreeCommits = 0;
  graphReads = 0;
  changesReads = 0;
  if (!manual) {
    if (intervalTick === undefined) throw new Error("Five-minute timer wasn't installed");
    intervalTick();
  }
  for (let i = 0; run === undefined && i < 100; i++) await delay(10);
  progress("starting");
  for (const repo of results.slice(0, 3)) progress("repo_started", repo);
}

function complete(index: number, invalidate: boolean, laneStride = 3) {
  const repo = results[index]!;
  completed++;
  progress("repo_completed", repo, { result: repo });
  if (invalidate && repo.outcome === "success") {
    updated.add(repo.repoId);
    if (manual) {
      for (const worktree of repo.worktrees) {
        if (worktree.outcome === "updated") emit("worktree:changed", { worktreeId: worktree.worktreeId });
      }
      emit("graph:changed", { repoId: repo.repoId });
    }
    emit("repo:changed", { profileId: profile.id, repoIds: [repo.repoId] });
  }
  const next = laneStride === 0 ? undefined : results[index + laneStride];
  if (next !== undefined) progress("repo_started", next);
}

function finish() {
  if (run === undefined || completed !== repos.length) throw new Error("Incomplete synthetic pull");
  const date = new Date().toISOString();
  run.finish({
    operationId: run.id, mode: "soft-pull", cancelled: false, startedAt: date, finishedAt: date,
    counts: {
      repos: { success: 29, partial: 0, skipped: 1, failed: 0, cancelled: 0 },
      remotes: { fetched: 30, skipped: 0, failed: 0, cancelled: 0 },
      worktrees: { updated: manual ? 36 : 29, upToDate: manual ? familySize - 7 : 0, nothingToPull: 0, skipped: 1, failed: 0, cancelled: 0 }
    },
    results
  });
  run = undefined;
}

function worktreeProgress(index: number, worktreeIndex: number) {
  const repo = results[index]!;
  const worktree = repo.worktrees[worktreeIndex]!;
  progress("repo_progress", repo, {
    detail: `${worktree.branch}: Checking for uncommitted changes…`,
    worktreePath: worktree.path, totalWorktrees: repo.worktrees.length
  });
  progress("repo_progress", repo, { worktreeResult: worktree, totalWorktrees: repo.worktrees.length });
}

export const bulkSyncPaint = {
  ready: (async () => {
    await Promise.all([
      '500 11px "Geist Sans"', '600 11px "Geist Sans"', '600 11px "Geist Mono"'
    ].map((font) => document.fonts.load(font)));
    createRoot(document.getElementById("root")!).render(<App />);
    await nextFrame();
  })(),
  start,
  complete,
  finish,
  worktreeProgress,
  get delivery() { return { completed, targetedReads, repoTreeCommits, detailEvents, graphReads, changesReads }; },
  get refreshesCommitted() {
    return committedRepos.length === repos.length && committedRepos.every((repo) =>
      !updated.has(repo.id) || repo.worktrees[0]?.behind === 0
    );
  },
  async afterPaint() {
    await nextFrame();
    await nextFrame();
  },
  async manualWorkload({ detail, invalidate }: { detail: boolean; invalidate: boolean }) {
    // The large family starts early and its worker remains occupied while
    // the other two lanes cycle through their repositories.
    await Promise.all([
      (async () => {
        for (let first = 0; first < results[0]!.worktrees.length; first += 3) {
          await delay(54);
          if (detail) {
            for (let i = first; i < Math.min(first + 3, results[0]!.worktrees.length); i++) {
              worktreeProgress(0, i);
            }
          }
        }
      })(),
      ...[1, 2].map(async (lane) => {
        await delay(lane * 56);
        for (let index = lane; index < results.length; index += 2) {
          const repo = results[index]!;
          await delay(92);
          if (detail) progress("repo_progress", repo, {
            detail: "Fetching origin…", remoteResult: repo.remotes[0]!, totalWorktrees: 1
          });
          await delay(92);
          if (detail) worktreeProgress(index, 0);
          await delay(40);
          complete(index, invalidate, 2);
        }
      })
    ]);
  },
  async workload({ detail, invalidate }: { detail: boolean; invalidate: boolean }) {
    // Three worker lanes, ten repositories per lane. Distinct timer tasks
    // stand in for IPC delivery. The batch finishes in about five seconds.
    await Promise.all([0, 1, 2].map(async (lane) => {
      await delay(lane * 43);
      for (let index = lane; index < results.length; index += 3) {
        const repo = results[index]!;
        await delay(120);
        if (detail) progress("repo_progress", repo, { detail: "Fetching origin…", totalWorktrees: 1 });
        await delay(120);
        if (detail) progress("repo_progress", repo, {
          detail: "Checking main…", totalWorktrees: 1, remoteResult: repo.remotes[0]!
        });
        await delay(120);
        if (detail) progress("repo_progress", repo, {
          detail: "Checking main…", totalWorktrees: 1, worktreeResult: repo.worktrees[0]!
        });
        await delay(120);
        complete(index, invalidate);
      }
    }));
    finish();
    return { completed, targetedReads };
  }
};
Object.assign(window, { bulkSyncPaint });
