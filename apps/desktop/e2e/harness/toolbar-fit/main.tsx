import type { ForkStatus, LaneGraph, Worktree, WorktreeState } from "@pwrgit/shared";
import wideFont from "@fontsource/geist-sans/files/geist-sans-latin-600-normal.woff2?url";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { LineageGraph } from "../../../src/renderer/src/features/graph/LineageGraph";
import { WorktreeHeader } from "../../../src/renderer/src/features/graph/WorktreeHeader";
import { SidebarToolbar } from "../../../src/renderer/src/features/sidebar/SidebarToolbar";
import { countOutcomes } from "../../../src/renderer/src/features/sidebar/bulk-sync-progress";
import "../../../src/renderer/src/styles/app.css";

type Toolbar = "lineage" | "worktree" | "sidebar";
type Scene = {
  toolbar: Toolbar;
  width: number;
  expanded: boolean;
  overflow: boolean;
  tick: number;
  forkSource?: boolean;
  progress?: { completed: number; inFlight: number };
};

const noop = () => undefined;
const sampledAt = "2026-11-19T15:00:00.000Z";
const repo = { id: "widgets", name: "Widgets", path: "/example/widgets", profileId: "demo" };
const branchState = {
  branch: "main",
  head: "f".repeat(40),
  ahead: 0,
  behind: 12,
  dirty: 1,
  behindDefault: 0,
  defaultBranch: "main",
  mergedIntoDefault: false,
  divergedFromDefault: false,
  isDefaultBranch: true
};
const worktree: Worktree = {
  ...branchState, id: "widget-checkout", repoId: repo.id, path: repo.path,
  pinned: false, isPrimary: true
};
const forkStatus: ForkStatus = {
  branch: branchState.branch,
  head: branchState.head,
  source: {
    ref: "refs/remotes/upstream-widget-automation/main",
    label: "upstream-widget-automation/main",
    remote: "upstream-widget-automation",
    head: "a".repeat(40),
    ahead: 0, behind: 812, pushBack: null
  },
  tracked: {
    ref: "refs/remotes/origin/main", label: "origin/main", remote: "origin",
    head: branchState.head, ahead: 0, behind: 0
  },
  drift: null
};
const compactGraph: LaneGraph = {
  commits: Array.from({ length: 40 }, (_, i) => {
    const hash = (at: number) => (1000 - at).toString(16).padStart(40, "f");
    return {
      hash: hash(i), shortHash: hash(i).slice(-7), parents: i === 39 ? [] : [hash(i + 1)],
      subject: `Document widget revision ${i}`, authorName: "Avery Chen",
      authorEmail: "avery@example.test", committedAt: sampledAt, isMerge: false
    };
  }),
  tips: {}, remoteTips: {}, branches: {}, head: "", headOnlyCommits: [],
  defaultBranch: "main", defaultRef: "origin/main", defaultRefTips: [],
  shownBranches: [], upstreamRefs: [], matchedBranches: 0, hiddenBranches: 0
};
const expandedGraph: LaneGraph = {
  ...compactGraph,
  head: compactGraph.commits[0]!.hash,
  tips: Object.fromEntries(compactGraph.commits.slice(0, 24).map((commit, index) =>
    [commit.hash, [`feature/widget-${index}`]])),
  shownBranches: Array.from({ length: 24 }, (_, i) => `feature/widget-${i}`),
  matchedBranches: 128
};
let graph = compactGraph;
let resolveLfs: (() => void) | null = null;
const progress = {
  counts: { ...countOutcomes([]), success: 10, skipped: 1, failed: 1 },
  inFlight: 2, queued: 13, startedAt: Date.now(), path: repo.path
};
const listeners = new Map<string, Set<(payload: unknown) => void>>();

function emit(channel: string, payload: unknown) {
  for (const handler of listeners.get(channel) ?? []) handler(payload);
}

Object.assign(window, {
  pwrgit: {
    profileId: "demo",
    platform: "darwin",
    on(channel: string, handler: (payload: unknown) => void) {
      const handlers = listeners.get(channel) ?? new Set();
      handlers.add(handler);
      listeners.set(channel, handlers);
      return () => handlers.delete(handler);
    },
    async dispatch(command: string) {
      switch (command) {
        case "graph:lanes": return { ok: true, value: graph };
        case "people:replaceInterest": return { ok: true, value: {} };
        case "repo:getGitLfsStatus":
          return new Promise((resolve) => {
            resolveLfs = () => resolve({ ok: true, value: {
              status: { required: true, installed: true, configured: true }, becameReady: false
            } });
          });
        case "remote:forkStatus":
          return { ok: true, value: scene.forkSource && scene.expanded ? forkStatus : null };
        case "repo:setup": return { ok: true, value: null };
        default: return { ok: false, error: { message: `Fixture has no response for ${command}` } };
      }
    }
  }
});

let scene: Scene = { toolbar: "lineage", width: 360, expanded: false, overflow: false, tick: 0 };
const selected = new Set<string>();
function ToolbarScene({ toolbar, width, expanded, overflow, tick, forkSource, progress: report }: Scene) {
  const state: WorktreeState = {
    ...branchState, worktreeId: worktree.id, hasUpstream: true, updatedAt: sampledAt,
    ...(expanded ? { dirty: 812, behind: forkSource ? 0 : 812 } : {})
  };
  return (
    <div className={`toolbar-case toolbar-case--${toolbar}`} style={{ width }}>
      <div className={toolbar === "sidebar" ? "pane pane--sidebar" : "pane"}>
        {toolbar === "lineage" ? (
          <LineageGraph
            repoId={repo.id} repoName={repo.name} worktreeId={worktree.id}
            worktreePath={worktree.path} viewingBranch={worktree.branch} activeEmail=""
            selectedCommits={selected}
            focusedCommit={tick % 2 === 0 ? null : compactGraph.commits[1]!.hash}
            revealCommit={null} tidyOffered={false}
            onEditHistory={noop} onCommitsChange={noop} onOpenCommit={noop}
            onRevealWorktree={noop} onRevealCreatedWorktree={noop}
          />
        ) : toolbar === "worktree" ? (
          <WorktreeHeader
            repo={repo} worktree={worktree} state={state}
            {...(expanded ? { onShowRail: noop } : {})}
          />
        ) : (
          <SidebarToolbar
            hasProfile rootCount={1} repoCount={42} recentCount={9}
            fetchInterval={15} syncVerb={expanded ? "pull" : "fetch"}
            syncBusy={expanded} syncProgress={!expanded ? null : report === undefined ? progress : {
              ...progress,
              counts: { ...countOutcomes([]), success: report.completed },
              inFlight: report.inFlight,
              queued: 42 - report.completed - report.inFlight
            }}
            syncScope={expanded ? "recent" : "all"} onAddFolder={noop}
            onClone={noop} onFork={noop} onSync={noop} onMaintenance={noop}
          />
        )}
      </div>
      {overflow && <div style={{ height: 450 }} />}
    </div>
  );
}

let key = 0;
const root = createRoot(document.getElementById("root")!);
const render = () => flushSync(() => root.render(<ToolbarScene key={key} {...scene} />));

export const toolbarFit = {
  ready: Promise.all(
    ['500 11px "Geist Sans"', '600 11px "Geist Sans"', '700 10px "Geist Sans"',
      '500 9.5px "Geist Mono"', '600 10px "Geist Mono"', '700 9.5px "Geist Mono"'].map((font) => document.fonts.load(font))
  ),
  mount(next: Omit<Scene, "tick">) {
    document.documentElement.removeAttribute("style");
    graph = next.expanded ? expandedGraph : compactGraph;
    resolveLfs = null;
    scene = { ...next, tick: 0 };
    key++;
    render();
  },
  update(change: Partial<Omit<Scene, "toolbar">> = {}) {
    const previousGraph = graph;
    const wasExpanded = scene.expanded;
    scene = { ...scene, ...change };
    graph = scene.expanded ? expandedGraph : compactGraph;
    render();
    if (
      (scene.toolbar === "lineage" && previousGraph !== graph) ||
      (scene.toolbar === "worktree" && scene.forkSource && scene.expanded !== wasExpanded)
    ) {
      emit("graph:changed", { repoId: repo.id });
    }
  },
  finishLfsRead() {
    if (resolveLfs === null) throw new Error("The LFS probe has not started");
    resolveLfs();
  },
  scale(scaled: boolean) {
    document.documentElement.style.setProperty("--toolbar-test-text-scale", scaled ? "1.6" : "");
  },
  useLateFont() {
    document.documentElement.style.setProperty("--font-sans", '"Toolbar Fit Wide", "Geist Sans", sans-serif');
  },
  async loadWideFont() {
    const style = document.createElement("style");
    style.textContent = `@font-face {
      font-family: "Toolbar Fit Wide";
      src: url("${wideFont}");
      font-weight: 600;
      size-adjust: 145%;
    }`;
    document.head.append(style);
    await document.fonts.load('600 11px "Toolbar Fit Wide"');
  }
};

Object.assign(window, { toolbarFit });
