import type {
  ForkStatus,
  Repo,
  RepoRefs,
  Worktree,
  WorktreeState
} from "@pwrgit/shared";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { WorktreeHeader } from "../../../src/renderer/src/features/graph/WorktreeHeader";
import { RepoRefsModal } from "../../../src/renderer/src/features/sidebar/RepoRefsModal";
import "../../../src/renderer/src/styles/app.css";

type Mode = "pull-before" | "pull-after" | "pull-disabled" | "remotes-before" | "remotes-after";

const sampledAt = "2026-11-24T15:00:00.000Z";
const headSha = "a".repeat(40);
const upstreamSha = "b".repeat(40);
const personalSha = "c".repeat(40);

const repo: Repo = {
  id: "canvas-repo",
  name: "canvas",
  path: "/example/canvas",
  profileId: "demo",
  pinned: false,
  worktrees: [],
  identity: {
    host: "github",
    hostname: "github.com",
    owner: "northwind",
    name: "canvas",
    nameWithOwner: "northwind/canvas",
    visibility: "public",
    viewerCanPush: true,
    parent: {
      nameWithOwner: "acme-labs/canvas",
      url: "https://github.com/acme-labs/canvas"
    }
  }
};

const worktree: Worktree = {
  id: "wt-main",
  repoId: repo.id,
  path: repo.path,
  branch: "main",
  head: headSha,
  ahead: 0,
  behind: 0,
  dirty: 0,
  behindDefault: 0,
  defaultBranch: "main",
  mergedIntoDefault: false,
  divergedFromDefault: false,
  isDefaultBranch: true,
  pinned: false,
  isPrimary: true
};

repo.worktrees = [worktree];

const wtState: WorktreeState = {
  worktreeId: worktree.id,
  branch: "main",
  head: headSha,
  ahead: 0,
  behind: 0,
  dirty: 0,
  behindDefault: 0,
  defaultBranch: "main",
  mergedIntoDefault: false,
  divergedFromDefault: false,
  isDefaultBranch: true,
  hasUpstream: true,
  updatedAt: sampledAt
};

const syncPrefs: Record<string, boolean> = { origin: true, personal: true };

function makeForkStatus(multi: boolean): ForkStatus {
  const originPushBack = {
    remote: "origin",
    branch: "main",
    ref: "refs/remotes/origin/main",
    head: headSha,
    overwrites: 0,
    adds: 4
  };
  return {
    branch: "main",
    head: headSha,
    source: {
      ref: "refs/remotes/upstream/main",
      label: "upstream/main",
      remote: "upstream",
      head: upstreamSha,
      ahead: 0,
      behind: 4,
      parent: "acme-labs/canvas",
      pushBack: originPushBack,
      ...(multi
        ? {
            syncTargets: [
              {
                remote: "origin",
                branch: "main",
                nameWithOwner: "northwind/canvas",
                tracked: true,
                enabled: syncPrefs["origin"] ?? true,
                pushBack: originPushBack
              },
              {
                remote: "personal",
                branch: "main",
                nameWithOwner: "riverbend/canvas",
                tracked: false,
                enabled: syncPrefs["personal"] ?? true,
                pushBack: {
                  remote: "personal",
                  branch: "main",
                  ref: "refs/remotes/personal/main",
                  head: personalSha,
                  overwrites: 0,
                  adds: 4
                }
              }
            ]
          }
        : {})
    },
    tracked: {
      ref: "refs/remotes/origin/main",
      label: "origin/main",
      remote: "origin",
      head: headSha,
      ahead: 0,
      behind: 0
    },
    drift: null
  };
}

function makeRefs(multi: boolean): RepoRefs {
  return {
    branches: [
      {
        name: "main",
        fullName: "refs/heads/main",
        head: headSha,
        upstream: "origin/main",
        ahead: 0,
        behind: 0,
        tracking: "up_to_date",
        checkedOutWorktreeIds: [worktree.id]
      }
    ],
    previewTags: [],
    tagCount: 0,
    remotes: [
      {
        name: "origin",
        fetchUrl: "git@github.com:northwind/canvas.git",
        pushUrl: "git@github.com:northwind/canvas.git",
        defaultBranch: "main",
        skipFetchAll: false,
        previewBranches: [],
        branchCount: 1,
        ...(multi
          ? {
              viewerCanPush: true,
              forkParent: "acme-labs/canvas",
              forkSyncEligible: true,
              forkSyncEnabled: syncPrefs["origin"] ?? true
            }
          : {})
      },
      {
        name: "personal",
        fetchUrl: "git@github.com:riverbend/canvas.git",
        pushUrl: "git@github.com:riverbend/canvas.git",
        defaultBranch: "main",
        skipFetchAll: false,
        previewBranches: [],
        branchCount: 1,
        ...(multi
          ? {
              viewerCanPush: true,
              forkParent: "acme-labs/canvas",
              forkSyncEligible: true,
              forkSyncEnabled: syncPrefs["personal"] ?? true
            }
          : {})
      },
      {
        name: "coworker",
        fetchUrl: "git@github.com:lee/canvas.git",
        pushUrl: "git@github.com:lee/canvas.git",
        defaultBranch: "main",
        skipFetchAll: false,
        previewBranches: [],
        branchCount: 1,
        ...(multi
          ? {
              viewerCanPush: false,
              forkParent: "acme-labs/canvas"
            }
          : {})
      },
      {
        name: "upstream",
        fetchUrl: "git@github.com:acme-labs/canvas.git",
        pushUrl: "git@github.com:acme-labs/canvas.git",
        defaultBranch: "main",
        skipFetchAll: false,
        previewBranches: [],
        branchCount: 1
      }
    ]
  };
}

let currentMode: Mode = "pull-after";
function currentForkStatus(): ForkStatus {
  const disabled = currentMode === "pull-disabled";
  const status = makeForkStatus(disabled || currentMode === "pull-after");
  if (disabled && status.source?.syncTargets !== undefined) {
    status.source.syncTargets = status.source.syncTargets
      .filter((target) => target.tracked)
      .map((target) => ({ ...target, enabled: false }));
  }
  return status;
}

let renderKey = 0;
const listeners = new Map<string, Set<(payload: unknown) => void>>();

function emit(channel: string, payload: unknown): void {
  for (const handler of listeners.get(channel) ?? []) handler(payload);
}

Object.assign(window, {
  pwrgit: {
    profileId: "demo",
    platform: "darwin",
    on(channel: string, handler: (payload: unknown) => void) {
      const set = listeners.get(channel) ?? new Set();
      set.add(handler);
      listeners.set(channel, set);
      return () => set.delete(handler);
    },
    async dispatch(command: string, req?: Record<string, unknown>) {
      switch (command) {
        case "remote:forkStatus":
          return {
            ok: true,
            value: currentForkStatus()
          };
        case "remote:setForkSyncRemote": {
          const remote = String(req?.["remote"] ?? "");
          const enabled = Boolean(req?.["enabled"]);
          syncPrefs[remote] = enabled;
          emit("graph:changed", { repoId: repo.id });
          return { ok: true, value: { remote, enabled } };
        }
        case "remote:checkSelected":
          return { ok: true, value: { status: "checked" } };
        case "remote:activities":
          return { ok: true, value: [] };
        case "repo:getGitLfsStatus":
          return { ok: true, value: { status: { required: false, installed: true, configured: true }, becameReady: false } };
        case "repo:setup":
          return { ok: true, value: null };
        case "repo:remoteBranches":
          return { ok: true, value: { rows: [], total: 0 } };
        case "forge:hosts":
          return { ok: true, value: { overrides: {} } };
        case "tag:status":
          return { ok: true, value: { rows: [], total: 0, counts: { all: 0, differs: 0, localOnly: 0, remoteOnly: 0 } } };
        default:
          return { ok: false, error: { kind: "unknown", code: "not_stubbed", message: `No fixture for ${command}` } };
      }
    }
  }
});

const root = createRoot(document.getElementById("root")!);

function renderScene(): void {
  const isRemotes = currentMode === "remotes-before" || currentMode === "remotes-after";
  const multi = currentMode === "pull-after" || currentMode === "remotes-after";
  flushSync(() => {
    root.render(
      isRemotes ? (
        <div className="shot-frame shot-frame--remotes">
          <RepoRefsModal
            key={renderKey}
            repo={repo}
            refs={makeRefs(multi)}
            now={Date.parse(sampledAt)}
            initialTab="remotes"
            focusedWorktree={worktree}
            onRefresh={() => {
              renderKey += 1;
              renderScene();
            }}
            onRevealWorktree={() => undefined}
            onCreateWorktree={() => undefined}
            onClose={() => undefined}
          />
        </div>
      ) : (
        <div className="shot-frame">
          <WorktreeHeader
            key={renderKey}
            repo={repo}
            worktree={worktree}
            state={wtState}
          />
        </div>
      )
    );
  });
}

export const multiForkHarness = {
  ready: Promise.all(
    [
      '400 11px "Geist Sans"',
      '500 11px "Geist Sans"',
      '600 12px "Geist Sans"',
      '700 13px "Geist Mono"',
      '500 10.5px "Geist Mono"'
    ].map((font) => document.fonts.load(font))
  ),
  mount(mode: Mode) {
    syncPrefs["origin"] = true;
    syncPrefs["personal"] = true;
    currentMode = mode;
    renderKey += 1;
    renderScene();
  }
};

Object.assign(window, { multiForkHarness });
