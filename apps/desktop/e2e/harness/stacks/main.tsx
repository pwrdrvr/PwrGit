import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ok, type ChangeRequestList, type Repo, type RepositoryStack, type StackPosition } from "@pwrgit/shared";
import "@fontsource/geist-sans/400.css";
import "@fontsource/geist-sans/600.css";
import "@fontsource/geist-mono/500.css";
import "../../../src/renderer/src/styles/app.css";
import { RepoChangeRequestSection } from "../../../src/renderer/src/features/sidebar/RepoChangeRequestSection";
import { GraphRow } from "../../../src/renderer/src/features/graph/GraphRow";
import { StackRail, StackView } from "../../../src/renderer/src/features/stacks/StackViews";
import { StackNavigationContext, type StackPick } from "../../../src/renderer/src/features/stacks/stack-navigation";
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
const positions = new Map<string, StackPosition>(stack.layers.map((layer, index) => [layer.branch, { stack, layer, index: index + 1 }]));

Object.assign(window, { pwrgit: {
  profileId, platform: "darwin", on: () => noop,
  dispatch: async (name: string) => {
    if (name === "pr:openList") return ok(pulls);
    if (name === "stack:list") return ok({ schemaVersion: 1, readOnly: false, stacks: [stack] });
    return ok(null);
  },
} });
document.documentElement.dataset["platform"] = "darwin";
window.localStorage.setItem("pwrgit.changeRequestsOpen.orbit", "1");

function Harness() {
  const [enabled, setEnabled] = useState(false);
  const [pick, select] = useState<StackPick | null>(null);
  const hoverIntent = useHoverIntent();
  Object.assign(window, { showStacks: () => setEnabled(true) });
  return <StackNavigationContext.Provider value={enabled ? { pick, select } : null}>
    <div className="app" style={{ height: "100vh" }}>
      <div className="app-body" style={{ gridTemplateColumns: "300px minmax(0, 1fr) 252px" }}>
        <aside className="pane pane--sidebar" aria-label="Repositories">
          <div className="sidebar__tree" role="tree" style={{ padding: 14 }}>
            <strong>{repo.name}</strong>
            <RepoChangeRequestSection repo={repo} now={1000} focusedWorktree={null} onRevealWorktree={noop}
              onCreateWorktree={noop} onOpenBrowser={noop} />
          </div>
        </aside>
        <main className="pane pane--main">
          {pick ? <StackView stack={pick.stack} repoId={repo.id} onClose={() => select(null)} /> :
            <div className="graph-card" style={{ margin: 14 }}>
              {[...stack.layers].reverse().map((layer, index) => <GraphRow key={layer.branch}
                vm={{
                  commit: { hash: layer.head!, shortHash: layer.head!.slice(0, 7), parents: [], subject: layer.pr!.title,
                    authorName: "Avery Chen", authorEmail: "avery@example.invalid",
                    committedAt: "2026-11-20T14:00:00Z", isMerge: false },
                  row: { lane: 0, top: [{ from: 0, to: 0 }], bottom: [{ from: 0, to: 0 }] },
                  refs: [layer.branch], remoteRefs: ["origin"], isHead: index === 0, isHeadOnly: true, isMine: true, defaultBranch: "main",
                }} laneCount={1} now={Date.parse("2026-11-22T00:00:00Z")}
                selected={false} focused={false} contextOpen={false} flashing={false} hoverIntent={hoverIntent}
                onOpen={noop} onShowContext={noop} onHideContext={noop} onFocusContext={() => false} onOpenContextMenu={noop}
                {...(enabled ? { stackPositions: positions, onOpenStack: (model: RepositoryStack) => select({ repoId: repo.id, stack: model }) } : {})}
              />)}
            </div>}
        </main>
        {pick && <StackRail stack={pick.stack} onCollapse={() => select(null)} />}
      </div>
    </div>
  </StackNavigationContext.Provider>;
}

void document.fonts.ready.then(() => createRoot(document.getElementById("root")!).render(<Harness />));
