import type {
  BulkSyncProgress,
  BulkSyncRepoResult,
  BulkSyncSummary,
  Profile,
  Repo
} from "@pwrgit/shared";
import { createRoot } from "react-dom/client";
import { Sidebar } from "../../../src/renderer/src/features/sidebar/Sidebar";
import {
  FETCH_INTERVAL_KEY,
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
const repos: Repo[] = Array.from({ length: 30 }, (_, i) => {
  const id = `fixture-${i + 1}`;
  const name = `widget-${String(i + 1).padStart(2, "0")}`;
  const path = `${profile.roots[0]}/${name}`;
  return {
    id, name, path, profileId: profile.id, pinned: false,
    worktrees: [{
      id: `${id}-main`, repoId: id, path, branch: "main", defaultBranch: "main",
      dirty: 0, ahead: 0, behind: 1, behindDefault: 0, isPrimary: true, pinned: false,
      isDefaultBranch: true, mergedIntoDefault: false, divergedFromDefault: false
    }]
  };
});
const results: BulkSyncRepoResult[] = repos.map((repo, i) => ({
  repoId: repo.id, name: repo.name, path: repo.path,
  outcome: i === 5 ? "skipped" : "success",
  remotes: [{ remote: "origin", outcome: "fetched" }],
  worktrees: [{
    worktreeId: repo.worktrees[0]!.id,
    path: repo.path,
    branch: "main",
    ...(i === 5 ? { outcome: "skipped", reason: "dirty" } : { outcome: "updated" })
  }]
}));

const listeners = new Map<string, Set<(payload: unknown) => void>>();
const emit = (event: string, payload: unknown) => {
  for (const handler of listeners.get(event) ?? []) handler(payload);
};
const updated = new Set<string>();
let run: { id: string; finish: (summary: BulkSyncSummary) => void } | undefined;
let completed = 0;
let targetedReads = 0;
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
          return { ok: true, value: { general: { tagCheckAfterSync: false } } };
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
        case "remote:bulkSync": {
          const { operationId, mode } = request ?? {};
          if (operationId === undefined || mode !== "soft-pull") {
            throw new Error("Expected an automatic soft pull");
          }
          return new Promise((resolve) => {
            run = { id: operationId, finish: (summary) => resolve({ ok: true, value: summary }) };
          });
        }
        default:
          return { ok: false, error: { message: `Fixture has no response for ${command}` } };
      }
    }
  }
});
document.documentElement.dataset["platform"] = "darwin";
localStorage.setItem(FETCH_INTERVAL_KEY, "5");
localStorage.setItem(SYNC_VERB_KEY, "pull");

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
function App() {
  const tree = useRepoTree(profile.id);
  return (
    <div className="pane pane--sidebar" style={{ width: 320, height: "100vh" }}>
      <Sidebar
        profiles={profiles} activeProfile={profile}
        profileLoadState={ready} onRetryProfiles={noop} onSwitchProfile={noop}
        repos={tree.repos} repoLoadState={tree.loadState} onRetryRepos={tree.retry}
        selectedWorktreeId={repos[0]!.worktrees[0]!.id} onSelectWorktree={noop}
        onSetRepoPin={noop} onSetWorktreePin={noop} onSetBranchPin={noop}
        onRemoveWorktree={noop} onRemoveWorktrees={tree.removeWorktrees}
        onCreateWorktree={async () => null} onPersistOrder={noop} onPersistRepoOrder={noop}
        refreshingRepoIds={tree.refreshingRepoIds} onRefreshRepo={noop} onRefreshPullRequest={noop}
        onCloneRepo={noop} onForkRepo={noop} onForkCheckout={noop} onAddFolder={noop}
        onExpandRepo={noop} onNewProfile={noop} onManageProfile={noop}
      />
    </div>
  );
}

function progress(phase: BulkSyncProgress["phase"], repo?: BulkSyncRepoResult, fields?: Partial<BulkSyncProgress>) {
  if (run === undefined) throw new Error("No automatic pull in progress");
  const message: BulkSyncProgress = {
    operationId: run.id, mode: "soft-pull", phase, totalRepos: repos.length,
    completedRepos: completed, ...(repo && { repoId: repo.repoId, repoName: repo.name }),
    ...fields
  };
  emit("remote:bulkSyncProgress", message);
}

async function start() {
  completed = 0;
  targetedReads = 0;
  if (intervalTick === undefined) throw new Error("Five-minute timer wasn't installed");
  intervalTick();
  for (let i = 0; run === undefined && i < 100; i++) await delay(10);
  progress("starting");
  for (const repo of results.slice(0, 3)) progress("repo_started", repo);
}

function complete(index: number, invalidate: boolean) {
  const repo = results[index]!;
  completed++;
  progress("repo_completed", repo, { result: repo });
  if (invalidate && repo.outcome === "success") {
    updated.add(repo.repoId);
    emit("repo:changed", { profileId: profile.id, repoIds: [repo.repoId] });
  }
  const next = results[index + 3];
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
      worktrees: { updated: 29, upToDate: 0, nothingToPull: 0, skipped: 1, failed: 0, cancelled: 0 }
    },
    results
  });
  run = undefined;
}

export const bulkSyncPaint = {
  ready: (async () => {
    await Promise.all(['500 11px "Geist Sans"', '600 11px "Geist Mono"'].map((font) => document.fonts.load(font)));
    createRoot(document.getElementById("root")!).render(<App />);
    await nextFrame();
  })(),
  start,
  complete,
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
