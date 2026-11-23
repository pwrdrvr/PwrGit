import { useState } from "react";
import { createRoot } from "react-dom/client";
import { err, ok, type ChangeRequestList, type ChangeRequestEntry, type PrSummary, type Repo, type RepositoryStack, type StackAction, type StackPlanPreview, type StackPosition, type Worktree, stackPosition } from "@pwrgit/shared";
import "@fontsource/geist-sans/400.css";
import "@fontsource/geist-sans/600.css";
import "@fontsource/geist-mono/500.css";
import "../../../src/renderer/src/styles/app.css";
import { ChangeRequestView } from "../../../src/renderer/src/features/change-request/ChangeRequestView";
import { ChangeRequestSelectionContext, changeRequestPickKey, type ChangeRequestPick } from "../../../src/renderer/src/features/change-request/change-request-selection";
import { RepoChangeRequestSection } from "../../../src/renderer/src/features/sidebar/RepoChangeRequestSection";
import { GraphRow, laneColor } from "../../../src/renderer/src/features/graph/GraphRow";
import { StackPlanRail } from "../../../src/renderer/src/features/stacks/StackPlanRail";
import { StackToolbar } from "../../../src/renderer/src/features/stacks/StackToolbar";
import { useStackOperation } from "../../../src/renderer/src/features/stacks/useStackOperation";
import { StackRail, StackView } from "../../../src/renderer/src/features/stacks/StackViews";
import { StackNavigationContext, type StackPick } from "../../../src/renderer/src/features/stacks/stack-navigation";
import { ToastHost } from "../../../src/renderer/src/features/shell/ToastHost";
import { useHoverIntent } from "../../../src/renderer/src/lib/hoverIntent";

const noop = () => undefined;
const profileId = "demo";
const repo: Repo = {
  id: "orbit", profileId, name: "orbit-deploy", path: "/example/orbit-deploy", pinned: false, worktrees: [],
  identity: { host: "github", hostname: "github.com", owner: "example", name: "orbit-deploy",
    nameWithOwner: "example/orbit-deploy", visibility: "public" },
};
const branches = ["windows/scheduler", "windows/api", "windows/ui"];
const subjects = ["Register Windows workers", "Add deployment API", "Surface deployment status"];
const forgeRepo = "github.com/example/orbit-deploy";
const trunk = { branch: "main", head: "d".repeat(40) };
const stack: RepositoryStack = {
  id: "windows", source: "tracked", catalogRepository: "github.com:example/orbit-deploy", trunk,
  layers: branches.map((branch, index) => {
    const parent = branches[index - 1] ?? trunk.branch;
    return {
      branch, parent, head: String(index + 1).repeat(40), base: "a".repeat(40), forgeRepo,
      pr: { number: 401 + index, url: `https://example.invalid/pull/${401 + index}`, title: subjects[index],
        state: "open", isDraft: false, checkState: index === 1 ? "pending" : "passing", headRefName: branch, baseRefName: parent },
      health: { inSync: index === 0, needsRestack: index > 0, needsPush: index === 0, parentMerged: false, drift: false, remoteAhead: false },
    };
  }),
};
const pulls: ChangeRequestList = {
  forge: "github", fetchedAt: 1000, truncated: false,
  remotes: [{ forge: "github", name: "origin", forgeRepo, path: "example/orbit-deploy", truncated: false, fetchedAt: 1000 }],
  entries: stack.layers.map(layer => ({ pr: layer.pr!, remote: "origin", forgeRepo, location: { kind: "local", branch: layer.branch } })),
};
const review = new URLSearchParams(location.search).has("review");
const releaseStack: RepositoryStack = {
  ...stack, id: "release-policy", source: "inferred", githubNumber: 801,
  githubUrl: "https://example.invalid/stack/801",
  layers: stack.layers.slice(0, 2).map((layer, index) => {
    const branch = index === 0 ? "release/rules" : "release/enforce";
    const parent = index === 0 ? "main" : "release/rules";
    return {
      ...layer, branch, parent, ...(index === 0 ? { behindParent: 14 } : {}),
      pr: { ...layer.pr!, number: index === 0 ? 790 : 798, headRefName: branch, baseRefName: parent,
        title: index === 0 ? "Define release policy rules" : "Enforce approval rules",
        checkState: index === 0 ? "passing" : "failing", mergeState: "mergeable", author: "avery", additions: 84, deletions: 12,
        changedFiles: 3, updatedAt: index === 0 ? 1000 : 3000 },
      health: { ...layer.health, inSync: index === 1, needsRestack: index === 0, needsPush: false },
    };
  }),
};
const ledgerStack: RepositoryStack = {
  ...stack, id: "ledger", layers: stack.layers.map((layer, index) => {
    const branch = ["ledger", "ledger/persist", "ledger/panel"][index]!;
    const parent = ["main", "ledger", "ledger/persist"][index]!;
    const { pr, ...rest } = layer;
    return {
      ...rest, branch, parent, ...(index === 1 ? { syncReady: true } : {}),
      ...(index === 2 ? { commitCount: 2 } : { pr: { ...pr!, number: 792 + index, headRefName: branch, baseRefName: parent,
        title: index === 0 ? "Add an approval ledger" : "Persist approvals across restarts",
        state: index === 0 ? "merged" : "open", isDraft: index === 1, updatedAt: 1000,
        ...(index === 0 ? { mergedAt: Date.now() - 2 * 60 * 60_000 } : {}) } }),
      health: { ...layer.health, needsRestack: false, parentMerged: index === 1, needsPush: false },
    };
  }),
};
const newStack: RepositoryStack = {
  ...stack, id: "diagnostics", layers: stack.layers.slice(0, 2).map(({ pr: _pr, ...layer }, index) => ({
    ...layer, branch: index === 0 ? "diag/trace" : "diag/export", parent: index === 0 ? "main" : "diag/trace",
    health: { ...layer.health, needsRestack: false },
  })),
};
const entry = (pr: PrSummary): ChangeRequestEntry => ({
  pr, forgeRepo, remote: "origin", location: { kind: "local", branch: pr.headRefName! },
});
function single(number: number, title: string, branch: string, updatedAt: number): ChangeRequestEntry {
  return entry({
    number, title, state: "open", isDraft: false, headRefName: branch, baseRefName: "main",
    url: `https://example.invalid/pull/${number}`, checkState: "passing", updatedAt,
  } as ChangeRequestEntry["pr"]);
}
const reviewPulls = {
  ...pulls, entries: [
    entry(releaseStack.layers[1].pr!),
    single(803, "Recover stalled job launches", "fix/job-launch", 2000),
    entry(releaseStack.layers[0].pr!),
    entry(ledgerStack.layers[1].pr!),
    single(804, "Speed up the timeline filter", "perf/timeline", 500),
  ],
};
const graphStack = review ? releaseStack : stack;
const positions = new Map<string, StackPosition>(graphStack.layers.map((layer, index) =>
  [layer.branch, { stack: graphStack, layer, index: index + 1 }]));

const graphLane = new URLSearchParams(location.search).has("alt-lane") ? 2 : 0;
const lanes = { repoId: repo.id, worktreeId: "fixture", byBranch: new Map(graphStack.layers.map(layer =>
  [layer.branch, laneColor(graphLane)])) };
const railWorktrees: Worktree[] = [{
  id: "review-wt", repoId: repo.id, branch: "release/enforce", path: "/example/orbit.release", dirty: 0,
  ahead: 0, behind: 0, behindDefault: 0, defaultBranch: "main", mergedIntoDefault: false,
  divergedFromDefault: false, isDefaultBranch: false, pinned: false, isPrimary: false,
}];

let currentStack = stack;
let mockedPlan: StackPlanPreview;
const makePlan = (action: StackAction): StackPlanPreview => ({
  id: "fixture-operation", action, cleanPrefix: false, blocked: [],
  steps: stack.layers.slice(1).map((layer, index) => ({
    branch: layer.branch, parent: layer.parent, oldBase: layer.base!, newBase: String(5 + index).repeat(40),
    oldTip: layer.head!, newTip: String(6 + index).repeat(40), proof: { preserved: index + 1, dropped: [] },
  })),
  moves: stack.layers.slice(1).map((layer, index) => ({ branch: layer.branch, old: layer.head!, next: String(6 + index).repeat(40) })),
});
const listeners = new Map<string, Set<(data: unknown) => void>>();
const announceChanged = () => {
  for (const listener of listeners.get("stack:changed") ?? []) listener({ repoId: repo.id, profileId });
};
Object.assign(window, { pwrgit: {
  profileId, platform: "darwin",
  on: (channel: string, listener: (data: unknown) => void) => {
    const set = listeners.get(channel) ?? new Set();
    set.add(listener);
    listeners.set(channel, set);
    return () => set.delete(listener);
  },
  dispatch: async (name: string, payload: unknown) => {
    if (name === "pr:openList") return ok(review ? reviewPulls : pulls);
    if (name === "stack:list") return ok({ schemaVersion: 1, readOnly: false, stacks: review ? [releaseStack, ledgerStack, newStack] : [currentStack] });
    if (name === "stack:plan") {
      mockedPlan = makePlan((payload as { action: StackAction }).action);
      return ok(mockedPlan);
    }
    if (name === "stack:apply") {
      currentStack = { ...stack, layers: stack.layers.map(layer => ({
        ...layer, head: mockedPlan.moves.find(move => move.branch === layer.branch)?.next ?? layer.head!,
        health: { ...layer.health, inSync: true, needsRestack: false },
      })) };
      announceChanged();
      return ok({ operationId: "fixture-operation", plan: mockedPlan, stack: currentStack });
    }
    if (name === "stack:undo") {
      currentStack = stack;
      announceChanged();
      return ok(null);
    }
    if (name === "stack:conflict" || name === "diagnostics:readStartupCpuProfile") return ok(null);
    return err({ kind: "unknown", code: "fixture_call", message: `No fixture for ${name}` });
  },
} });
document.documentElement.dataset["platform"] = "darwin";
window.localStorage.setItem("pwrgit.changeRequestsOpen.orbit", "1");

function Harness() {
  const [enabled, setEnabled] = useState(review);
  const [operations, setOperations] = useState(false);
  const [pick, select] = useState<StackPick | null>(null);
  const [selectedBranch, setSelectedBranch] = useState<string>();
  const [prPick, setPr] = useState<ChangeRequestPick | null>(null);
  const chooseStack = (next: StackPick) => { setPr(null); select(next); setSelectedBranch(next.branch); };
  const prPosition = prPick && stackPosition([releaseStack, ledgerStack], layer =>
    layer.pr?.number === prPick.entry.pr.number && layer.forgeRepo === prPick.entry.forgeRepo);
  const displayedStack = pick && (operations ? currentStack : pick.stack);
  const hoverIntent = useHoverIntent();
  const controls = useStackOperation(operations ? repo : undefined, pick?.stack.id, (repoId, updated) => select({ repoId, stack: updated }), noop);
  Object.assign(window, { showStacks: () => setEnabled(true), showOperations: () => setOperations(true) });
  return <StackNavigationContext.Provider value={enabled ? { pick, select: chooseStack, lanes } : null}>
    <ChangeRequestSelectionContext.Provider value={{
      selectedKey: prPick ? changeRequestPickKey(repo.id, prPick.entry) : null,
      select: next => { select(null); setPr(next); }, clear: () => setPr(null),
    }}>
    <div className="app" style={{ height: "100vh" }}>
      <div className="app-body" style={{ gridTemplateColumns: review ? "340px minmax(0, 1fr) 230px" : "300px minmax(0, 1fr) 252px" }}>
        <aside className="pane pane--sidebar" aria-label="Repositories">
          <div className="sidebar__tree" role="tree" style={{ padding: 14 }}>
            <strong>{repo.name}</strong>
            <RepoChangeRequestSection repo={repo} now={1000} focusedWorktree={null} onRevealWorktree={noop}
              onCreateWorktree={noop} onOpenBrowser={noop} />
          </div>
        </aside>
        <main className="pane pane--main">
          {displayedStack ? <StackView stack={displayedStack} repoId={repo.id} onClose={() => select(null)}
            writable selectedBranch={selectedBranch} onSelectBranch={setSelectedBranch}
            {...(operations || review ? {
              toolbar: <StackToolbar stack={displayedStack} disabled={controls.pending !== null} onPlan={action => void controls.requested(action)} />,
              onPlan: (action: StackAction) => void controls.requested(action),
            } : {})} /> : prPick ? <ChangeRequestView entry={prPick.entry} repoId={repo.id} now={1000} manyRemotes={false}
              worktreeId={null} bodyRef={{ current: null }} onGoToWorktree={noop} onCreateWorktree={noop} onClose={() => setPr(null)}
              {...(prPosition ? { stackPosition: prPosition } : {})} stackWritable
              state={{ view: null, fetching: null, error: null, scope: { kind: "all" }, setScope: noop, patch: null,
                scopeError: null, files: [], totals: null, showEnd: noop, fetchNow: noop }} />
            : <div className="graph-card" style={{ margin: 14 }}>
              {[...graphStack.layers].reverse().map((layer, index) => <GraphRow key={layer.branch}
                vm={{
                  commit: { hash: layer.head!, shortHash: layer.head!.slice(0, 7), parents: [], subject: layer.pr!.title,
                    authorName: "Avery Chen", authorEmail: "avery@example.invalid",
                    committedAt: "2026-11-20T14:00:00Z", isMerge: false },
                  row: { lane: graphLane, top: [{ from: graphLane, to: graphLane }], bottom: [{ from: graphLane, to: graphLane }] },
                  refs: [layer.branch], remoteRefs: ["origin"], isHead: index === 0, isHeadOnly: true, isMine: true, defaultBranch: "main",
                }} laneCount={graphLane + 1} now={Date.parse("2026-11-22T00:00:00Z")}
                selected={false} focused={false} contextOpen={false} flashing={false} hoverIntent={hoverIntent}
                onOpen={noop} onShowContext={noop} onHideContext={noop} onFocusContext={() => false} onOpenContextMenu={noop}
                {...(enabled ? { stackPositions: positions, stackRepoId: repo.id, stackWritable: true } : {})}
              />)}
            </div>}
        </main>
        {displayedStack && (operations && (controls.stage.phase !== "idle" || controls.pending)
          ? <StackPlanRail controls={controls} onCollapse={() => select(null)} onOpenWorktree={noop} /> :
            <StackRail stack={displayedStack} worktrees={railWorktrees} branch={selectedBranch} writable onCollapse={() => select(null)} />)}
      </div>
      {operations && <ToastHost profileId={profileId} repos={[repo]} onReveal={noop} />}
    </div>
    </ChangeRequestSelectionContext.Provider>
  </StackNavigationContext.Provider>;
}

void document.fonts.ready.then(() => createRoot(document.getElementById("root")!).render(<Harness />));
