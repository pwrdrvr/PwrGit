// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Commit, Repo, RepoSearchHit, RepositoryStack, StackPlanPreview, StackSnapshot, Worktree } from "@pwrgit/shared";
import { useStackNavigation } from "./features/stacks/stack-navigation";
import type { RepoSwitcherOverlay } from "./features/sidebar/RepoSwitcherOverlay";

const exampleStack: RepositoryStack = {
  id: "demo-stack", source: "tracked", catalogRepository: "", trunk: { branch: "main" },
  layers: [{ branch: "demo-branch", parent: "main", health: {
    inSync: true, needsRestack: false, needsPush: false, remoteAhead: false, drift: false, parentMerged: false,
  } }],
};

const mocks = vi.hoisted(() => ({
  profiles: {} as Record<string, unknown>,
  tree: {} as Record<string, unknown>,
  openProfile: vi.fn(),
  stack: null as RepositoryStack | null,
  dispatch: vi.fn(),
  subscribers: new Map<string, (payload: unknown) => void>(),
  reveal: null as ((repoId: string, remote: string | null) => void) | null,
  search: null as ComponentProps<typeof RepoSwitcherOverlay> | null
}));
vi.mock("./state/useProfiles", () => ({ useProfiles: () => mocks.profiles }));
vi.mock("./state/useRepoTree", () => ({ useRepoTree: () => mocks.tree }));
vi.mock("./state/useWorktreeState", () => ({ useWorktreeState: () => null }));
vi.mock("./features/agent/agent-store", () => ({
  useAgentOffered: () => false
}));
vi.mock("./features/change-request/useChangeRequestView", () => ({
  useChangeRequestView: () => ({ view: null })
}));
vi.mock("./lib/pwrgit", () => ({
  windowProfileId: () => "demo-profile",
  dispatch: mocks.dispatch,
  subscribe: (name: string, handler: (payload: unknown) => void) => {
    mocks.subscribers.set(name, handler);
    return () => {
      mocks.subscribers.delete(name);
    };
  }
}));
vi.mock("./features/chrome/TitleBar", () => ({
  TitleBar: ({ onOpenContributions, repo, worktree }: { onOpenContributions: () => void; repo?: Repo; worktree?: Worktree }) => (
    <button data-repo={repo?.id} data-worktree={worktree?.id} onClick={onOpenContributions}>Contributions</button>
  )
}));
vi.mock("./features/contributions/ContributionScreen", () => ({
  ContributionScreen: () => <div data-testid="contributions">Analytics</div>
}));
vi.mock("./features/sidebar/Sidebar", () => ({
  Sidebar: () => {
    const nav = useStackNavigation();
    return <>
      <button data-testid="stack-pick" aria-pressed={nav?.pick != null}
        onClick={() => nav?.select({ repoId: "demo-two", stack: mocks.stack ?? exampleStack })}>Open demo stack</button>
      <button onClick={() => nav?.select({ repoId: "demo-one", stack: exampleStack })}>Open clone stack</button>
      <button onClick={() => nav?.select({ repoId: "demo-one", stack: exampleStack, action: { kind: "restack" } })}>Restack clone stack</button>
    </>;
  },
}));
vi.mock("./features/sidebar/RepoSwitcherOverlay", () => ({
  RepoSwitcherOverlay: (props: ComponentProps<typeof RepoSwitcherOverlay>) => {
    mocks.search = props;
    return <div data-testid="switcher" />;
  }
}));
vi.mock("./features/graph/LineageGraph", () => ({
  LineageGraph: ({
    repoId,
    revealCommit
  }: {
    repoId: string;
    revealCommit: { hash: string } | null;
  }) => (
    <div data-testid="lineage">
      {repoId}:{revealCommit?.hash}
    </div>
  )
}));
vi.mock("./features/graph/WorktreeHeader", () => ({
  WorktreeHeader: () => null
}));
vi.mock("./features/rail/Rail", () => ({ Rail: () => null }));
vi.mock("./features/shell/ToastHost", () => ({
  ToastHost: ({
    onReveal
  }: {
    onReveal: (repoId: string, remote: string | null) => void;
  }) => {
    mocks.reveal = onReveal;
    return null;
  }
}));
vi.mock("./features/sidebar/NewWorktreeModal", () => ({
  NewWorktreeModal: () => <div data-testid="new-worktree" />
}));
vi.mock("./features/shell/DialogHost", () => ({ DialogHost: () => null }));
vi.mock("./features/graph/ResetToRemoteHost", () => ({
  ResetToRemoteHost: () => null
}));
vi.mock("./features/diff/FileInsightsPane", () => ({
  insightContextKey: () => "workingTree",
  FileInsightsPane: ({ path }: { path: string }) => (
    <div data-testid="file">{path}</div>
  )
}));
import { App } from "./App";

const repos: Repo[] = ["demo-one", "demo-two"].map((id) => ({
  id,
  profileId: "demo-profile",
  name: id,
  path: `/demo/${id}`,
  pinned: false,
  worktrees: [
    {
      id: `${id}-wt`,
      repoId: id,
      branch: "main",
      path: `/demo/${id}`,
      dirty: 0,
      ahead: 0,
      behind: 0,
      behindDefault: 0,
      defaultBranch: "main",
      mergedIntoDefault: false,
      divergedFromDefault: false,
      isDefaultBranch: true,
      pinned: false,
      isPrimary: true
    }
  ]
}));
const hit = (repoId: string): RepoSearchHit => ({
  kind: "repo",
  repoId,
  name: repoId,
  path: `/demo/${repoId}`,
  profileId: "demo-profile",
  profileName: "Demo",
  worktreeCount: 1,
  pinned: false
});
let container: HTMLDivElement, root: Root;
beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem(
    "pwrgit.worktreeSelection.demo-profile",
    JSON.stringify({
      repoId: repos[0]!.id,
      worktreeId: repos[0]!.worktrees[0]!.id
    })
  );
  const profile = {
    id: "demo-profile",
    name: "Demo",
    email: "demo@example.test",
    mono: "D",
    roots: [],
    onboardingCompleted: true,
    showInMenu: true
  };
  mocks.profiles = {
    profiles: [profile],
    activeProfile: profile,
    loadState: { status: "ready" },
    openProfile: mocks.openProfile
  };
  mocks.tree = {
    repos,
    loadState: { status: "ready" },
    refreshingRepoIds: new Set(),
    removalProgress: null
  };
  mocks.openProfile.mockReset();
  mocks.search = null;
  mocks.reveal = null;
  mocks.stack = null;
  mocks.subscribers.clear();
  mocks.dispatch
    .mockReset()
    .mockResolvedValue({
      ok: true,
      value: { repoId: null, worktreeId: null, branch: null }
    });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  window.localStorage.clear();
  vi.restoreAllMocks();
});
async function openAnalytics() {
  await act(async () => root.render(<App />));
  await act(async () =>
    container.querySelector<HTMLButtonElement>("button")!.click()
  );
  expect(container.querySelector("[data-testid=contributions]")).not.toBeNull();
}
async function openSwitcher() {
  await act(async () =>
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true })
    )
  );
  expect(container.querySelector("[data-testid=switcher]")).not.toBeNull();
}
function expectRepository(repoId: string) {
  expect(container.querySelector("[data-testid=contributions]")).toBeNull();
  expect(
    container.querySelector("[data-testid=lineage]")?.textContent
  ).toContain(repoId);
}

describe("Contributions navigation in App", () => {
  it.each(["demo-one", "demo-two"])(
    "reveals a same-profile search pick even when %s was already selected",
    async (repoId) => {
      await openAnalytics();
      await openSwitcher();
      await act(async () => mocks.search!.onPick(hit(repoId)));
      expectRepository(repoId);
    }
  );
  it("reveals a commit picked from the switcher", async () => {
    await openAnalytics();
    await openSwitcher();
    await act(async () =>
      mocks.search!.onPickCommit!({
        hash: "DEMO_COMMIT",
        shortHash: "DEMO",
        parents: [],
        subject: "Invented commit",
        authorName: "Demo",
        authorEmail: "demo@example.test",
        committedAt: "2026-10-10T12:00:00Z",
        isMerge: false
      } satisfies Commit)
    );
    expectRepository("demo-one");
    expect(
      container.querySelector("[data-testid=lineage]")?.textContent
    ).toContain("DEMO_COMMIT");
  });
  it("reveals file details picked from the switcher", async () => {
    await openAnalytics();
    await openSwitcher();
    await act(async () => mocks.search!.onPickFile!("demo.ts"));
    expectRepository("demo-one");
    expect(container.querySelector("[data-testid=file]")?.textContent).toBe(
      "demo.ts"
    );
  });
  it.each(["demo-one", "demo-two"])(
    "honors an incoming repository reveal for %s",
    async (repoId) => {
      await openAnalytics();
      await act(async () =>
        mocks.subscribers.get("ui:revealRepo")!({
          profileId: "demo-profile",
          repoId,
          worktreeId: null,
          branch: null
        })
      );
      expectRepository(repoId);
    }
  );
  it.each(["demo-one", "demo-two"])(
    "reveals repository content through a toast for %s",
    async (repoId) => {
      await openAnalytics();
      await act(async () => mocks.reveal!(repoId, null));
      expectRepository(repoId);
    }
  );
  it("waits for an incoming target to be available before leaving Contributions", async () => {
    await openAnalytics();
    await act(async () =>
      mocks.subscribers.get("ui:revealRepo")!({
        profileId: "demo-profile",
        repoId: "demo-later",
        worktreeId: null,
        branch: null
      })
    );
    expect(
      container.querySelector("[data-testid=contributions]")
    ).not.toBeNull();
    const later: Repo = {
      ...repos[0]!,
      id: "demo-later",
      worktrees: [
        { ...repos[0]!.worktrees[0]!, id: "later-wt", repoId: "demo-later" }
      ]
    };
    mocks.tree = { ...mocks.tree, repos: [...repos, later] };
    await act(async () => root.render(<App />));
    expectRepository("demo-later");
  });
  it("opens a worktree-less branch on repository content", async () => {
    await openAnalytics();
    await openSwitcher();
    await act(async () =>
      mocks.search!.onPick({
        ...hit("demo-one"),
        kind: "local_branch",
        name: "demo-feature"
      })
    );
    expectRepository("demo-one");
    expect(
      container.querySelector("[data-testid=new-worktree]")
    ).not.toBeNull();
  });
  it("keeps this window on Contributions when a search pick opens another profile", async () => {
    await openAnalytics();
    await openSwitcher();
    await act(async () =>
      mocks.search!.onPick({
        ...hit("external-demo"),
        profileId: "other-profile"
      })
    );
    expect(mocks.openProfile).toHaveBeenCalledWith(
      "other-profile",
      "external-demo",
      undefined,
      undefined
    );
    expect(
      container.querySelector("[data-testid=contributions]")
    ).not.toBeNull();
  });
});

describe("Stack navigation in App", () => {
  it.each(["plan", "apply"] as const)("isolates a clone's stack state across a pending %s", async command => {
    vi.stubGlobal("pwrgit", {});
    const plan: StackPlanPreview = { id: "plan", action: { kind: "restack" }, steps: [], moves: [], blocked: [], cleanPrefix: false };
    let completePlan!: (result: unknown) => void;
    const firstPlan = new Promise(resolve => { completePlan = resolve; });
    mocks.dispatch.mockImplementation(async (name: string, request: { repoId?: string }) => {
      switch (name) {
        case "stack:list":
          return { ok: true, value: { schemaVersion: 1, readOnly: false, stacks: [exampleStack] } };
        case "stack:plan":
          return command === "plan" && request.repoId === "demo-two" ? firstPlan : { ok: true, value: plan };
        case "stack:apply":
          return { ok: true, value: { operationId: "applied", plan, stack: exampleStack } };
        case "stack:conflict":
          return { ok: true, value: null };
        default:
          return { ok: true, value: { repoId: null, worktreeId: null, branch: null } };
      }
    });
    const button = (label: string) => [...container.querySelectorAll("button")].find(node => node.textContent === label)!;
    const ledger = () => container.querySelector('[aria-label="Proof ledger"]');
    try {
      await act(async () => root.render(<App />));
      await act(async () => button("Open demo stack").click());
      await act(async () => button("Restack").click());
      if (command === "plan") {
        await act(async () => button("Restack clone stack").click());
        const requests = mocks.dispatch.mock.calls.filter(([name]) => name === "stack:plan").map(([, request]) => request.repoId);
        expect(requests).toEqual(["demo-two", "demo-one"]);
      } else {
        await act(async () => button("Run locally").click());
        expect(ledger()).not.toBeNull();
        await act(async () => button("Open clone stack").click());
        expect(ledger()).toBeNull();
      }
    } finally {
      await act(async () => completePlan({ ok: true, value: plan }));
      vi.unstubAllGlobals();
    }
  });

  it.each([false, true])("keeps an adopted stack selected as reads catch up (inferred stack disappears before apply returns: %s)",
    async notifyBeforeReply => {
      vi.stubGlobal("pwrgit", {});
      const inferred: RepositoryStack = { ...exampleStack, id: "inferred", source: "inferred" };
      const adopted: RepositoryStack = { ...exampleStack, id: "adopted" };
      const plan: StackPlanPreview = { id: "plan", action: { kind: "adopt" }, steps: [], moves: [], blocked: [], cleanPrefix: false };
      let finishApply!: (result: unknown) => void;
      let finishRead!: (result: unknown) => void;
      const apply = new Promise(resolve => { finishApply = resolve; });
      const read = new Promise(resolve => { finishRead = resolve; });
      let latest: RepositoryStack[] | null = [inferred];
      const snapshot = (stacks: RepositoryStack[]) => ({ ok: true, value: { stacks, schemaVersion: 1, readOnly: false } });
      mocks.stack = inferred;
      mocks.dispatch.mockImplementation(async (name: string, request: { repoId?: string }) => {
        if (name === "stack:list") {
          if (request.repoId !== "demo-two") return snapshot([]);
          return latest ? snapshot(latest) : read;
        }
        if (name === "stack:plan") return { ok: true, value: plan };
        if (name === "stack:apply") return apply;
        if (name === "stack:conflict") return { ok: true, value: null };
        return { ok: true, value: { repoId: null, worktreeId: null, branch: null } };
      });
      const button = (label: string) => [...container.querySelectorAll("button")].find(node => node.textContent === label)!;
      try {
        await act(async () => root.render(<App />));
        await act(async () => button("Open demo stack").click());
        await act(async () => button("Adopt stack").click());
        await act(async () => button("Run locally").click());
        if (notifyBeforeReply) {
          latest = [];
          await act(async () => window.dispatchEvent(new Event("focus")));
          expect(container.querySelector(".stack-view")).not.toBeNull();
        }
        latest = null;
        await act(async () => finishApply({ ok: true, value: { operationId: "adopt", plan, stack: adopted } }));
        expect(button("Restack")).toBeDefined();
        expect(container.querySelector('[aria-label="Proof ledger"]')).not.toBeNull();
        latest = [adopted];
        await act(async () => finishRead(snapshot(latest!)));
        expect(button("Restack")?.disabled).toBe(false);
        latest = [];
        await act(async () => window.dispatchEvent(new Event("focus")));
        expect(container.querySelector(".stack-view")).toBeNull();
      } finally {
        await act(async () => {
          finishApply({ ok: false, error: { message: "cancelled test" } });
          finishRead(snapshot([]));
        });
        vi.unstubAllGlobals();
      }
    });
  it.each([false, true])("uses one pane owner and restores the title after removal (worktree selected: %s)", async selected => {
    if (!selected) window.localStorage.clear();
    vi.stubGlobal("pwrgit", {});
    let snapshot: StackSnapshot = { schemaVersion: 1, readOnly: false, stacks: [exampleStack] };
    mocks.dispatch.mockImplementation(async (name: string, request: { repoId?: string }) => ({
      ok: true,
      value: name === "stack:list" ? { ...snapshot, stacks: request.repoId === "demo-two" ? snapshot.stacks : [] }
        : { repoId: null, worktreeId: null, branch: null },
    }));
    try {
      await act(async () => root.render(<App />));
      const pick = container.querySelector<HTMLButtonElement>("[data-testid=stack-pick]")!;
      const title = container.querySelector("button")!;
      const main = container.querySelector("main")!;
      await act(async () => pick.click());
      expect(main.querySelector(".stack-view")).not.toBeNull();
      expect(main.querySelector(".main-empty")).toBeNull();
      expect(title.dataset["repo"]).toBe("demo-two");
      expect(title.dataset["worktree"]).toBeUndefined();

      snapshot = { ...snapshot, stacks: [] };
      await act(async () => window.dispatchEvent(new Event("focus")));
      expect(main.querySelector(".stack-view")).toBeNull();
      expect(pick.getAttribute("aria-pressed")).toBe("false");
      expect(title.dataset["repo"]).toBe(selected ? "demo-one" : undefined);
      expect(title.dataset["worktree"]).toBe(selected ? "demo-one-wt" : undefined);
      expect(Boolean(main.querySelector(".main-empty"))).toBe(!selected);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
