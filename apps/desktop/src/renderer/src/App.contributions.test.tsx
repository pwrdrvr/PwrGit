// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Commit, Repo, RepoSearchHit } from "@pwrgit/shared";
import type { RepoSwitcherOverlay } from "./features/sidebar/RepoSwitcherOverlay";

const mocks = vi.hoisted(() => ({
  profiles: {} as Record<string, unknown>, tree: {} as Record<string, unknown>,
  openProfile: vi.fn(), dispatch: vi.fn(),
  subscribers: new Map<string, (payload: unknown) => void>(),
  reveal: null as ((repoId: string, remote: string | null) => void) | null,
  search: null as ComponentProps<typeof RepoSwitcherOverlay> | null
}));
vi.mock("./state/useProfiles", () => ({ useProfiles: () => mocks.profiles }));
vi.mock("./state/useRepoTree", () => ({ useRepoTree: () => mocks.tree }));
vi.mock("./state/useWorktreeState", () => ({ useWorktreeState: () => null }));
vi.mock("./features/agent/agent-store", () => ({ useAgentOffered: () => false }));
vi.mock("./features/change-request/useChangeRequestView", () => ({ useChangeRequestView: () => ({ view: null }) }));
vi.mock("./lib/pwrgit", () => ({
  windowProfileId: () => "demo-profile", dispatch: mocks.dispatch,
  subscribe: (name: string, handler: (payload: unknown) => void) => {
    mocks.subscribers.set(name, handler); return () => { mocks.subscribers.delete(name); };
  }
}));
vi.mock("./features/chrome/TitleBar", () => ({ TitleBar: ({ onOpenContributions }: { onOpenContributions: () => void }) => <button onClick={onOpenContributions}>Contributions</button> }));
vi.mock("./features/contributions/ContributionScreen", () => ({ ContributionScreen: () => <div data-testid="contributions">Analytics</div> }));
vi.mock("./features/sidebar/Sidebar", () => ({ Sidebar: () => null }));
vi.mock("./features/sidebar/RepoSwitcherOverlay", () => ({ RepoSwitcherOverlay: (props: ComponentProps<typeof RepoSwitcherOverlay>) => { mocks.search = props; return <div data-testid="switcher" />; } }));
vi.mock("./features/graph/LineageGraph", () => ({ LineageGraph: ({ repoId, revealCommit }: { repoId: string; revealCommit: { hash: string } | null }) => <div data-testid="lineage">{repoId}:{revealCommit?.hash}</div> }));
vi.mock("./features/graph/WorktreeHeader", () => ({ WorktreeHeader: () => null }));
vi.mock("./features/rail/Rail", () => ({ Rail: () => null }));
vi.mock("./features/shell/ToastHost", () => ({ ToastHost: ({ onReveal }: { onReveal: (repoId: string, remote: string | null) => void }) => { mocks.reveal = onReveal; return null; } }));
vi.mock("./features/sidebar/NewWorktreeModal", () => ({ NewWorktreeModal: () => <div data-testid="new-worktree" /> }));
vi.mock("./features/shell/DialogHost", () => ({ DialogHost: () => null }));
vi.mock("./features/graph/ResetToRemoteHost", () => ({ ResetToRemoteHost: () => null }));
vi.mock("./features/diff/FileInsightsPane", () => ({
  insightContextKey: () => "workingTree", FileInsightsPane: ({ path }: { path: string }) => <div data-testid="file">{path}</div>
}));
import { App } from "./App";

const repos: Repo[] = ["demo-one", "demo-two"].map(id => ({
  id, profileId: "demo-profile", name: id, path: `/demo/${id}`, pinned: false,
  worktrees: [{ id: `${id}-wt`, repoId: id, branch: "main", path: `/demo/${id}`, dirty: 0, ahead: 0, behind: 0,
    behindDefault: 0, defaultBranch: "main", mergedIntoDefault: false, divergedFromDefault: false, isDefaultBranch: true, pinned: false, isPrimary: true }]
}));
const hit = (repoId: string): RepoSearchHit => ({ kind: "repo", repoId, name: repoId, path: `/demo/${repoId}`, profileId: "demo-profile", profileName: "Demo", worktreeCount: 1, pinned: false });
let container: HTMLDivElement, root: Root;
beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem("pwrgit.worktreeSelection.demo-profile", JSON.stringify({ repoId: repos[0]!.id, worktreeId: repos[0]!.worktrees[0]!.id }));
  const profile = { id: "demo-profile", name: "Demo", email: "demo@example.test", mono: "D", roots: [], onboardingCompleted: true, showInMenu: true };
  mocks.profiles = { profiles: [profile], activeProfile: profile, loadState: { status: "ready" }, openProfile: mocks.openProfile };
  mocks.tree = { repos, loadState: { status: "ready" }, refreshingRepoIds: new Set(), removalProgress: null };
  mocks.openProfile.mockReset(); mocks.search = null; mocks.reveal = null; mocks.subscribers.clear();
  mocks.dispatch.mockReset().mockResolvedValue({ ok: true, value: { repoId: null, worktreeId: null, branch: null } });
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); window.localStorage.clear(); vi.restoreAllMocks(); });
async function openAnalytics() {
  await act(async () => root.render(<App />));
  await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
  expect(container.querySelector("[data-testid=contributions]")).not.toBeNull();
}
async function openSwitcher() {
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true })));
  expect(container.querySelector("[data-testid=switcher]")).not.toBeNull();
}
function expectRepository(repoId: string) {
  expect(container.querySelector("[data-testid=contributions]")).toBeNull();
  expect(container.querySelector("[data-testid=lineage]")?.textContent).toContain(repoId);
}

describe("Contributions navigation in App", () => {
  it.each(["demo-one", "demo-two"])("reveals a same-profile search pick even when %s was already selected", async repoId => {
    await openAnalytics(); await openSwitcher();
    await act(async () => mocks.search!.onPick(hit(repoId)));
    expectRepository(repoId);
  });
  it("reveals a commit picked from the switcher", async () => {
    await openAnalytics(); await openSwitcher();
    await act(async () => mocks.search!.onPickCommit!({ hash: "DEMO_COMMIT", shortHash: "DEMO", parents: [], subject: "Invented commit", authorName: "Demo", authorEmail: "demo@example.test", committedAt: "2026-10-10T12:00:00Z", isMerge: false } satisfies Commit));
    expectRepository("demo-one");
    expect(container.querySelector("[data-testid=lineage]")?.textContent).toContain("DEMO_COMMIT");
  });
  it("reveals file details picked from the switcher", async () => {
    await openAnalytics(); await openSwitcher();
    await act(async () => mocks.search!.onPickFile!("demo.ts"));
    expectRepository("demo-one");
    expect(container.querySelector("[data-testid=file]")?.textContent).toBe("demo.ts");
  });
  it.each(["demo-one", "demo-two"])("honors an incoming repository reveal for %s", async repoId => {
    await openAnalytics();
    await act(async () => mocks.subscribers.get("ui:revealRepo")!({ profileId: "demo-profile", repoId, worktreeId: null, branch: null }));
    expectRepository(repoId);
  });
  it.each(["demo-one", "demo-two"])("reveals repository content through a toast for %s", async repoId => {
    await openAnalytics();
    await act(async () => mocks.reveal!(repoId, null));
    expectRepository(repoId);
  });
  it("waits for an incoming target to be available before leaving Contributions", async () => {
    await openAnalytics();
    await act(async () => mocks.subscribers.get("ui:revealRepo")!({ profileId: "demo-profile", repoId: "demo-later", worktreeId: null, branch: null }));
    expect(container.querySelector("[data-testid=contributions]")).not.toBeNull();
    const later: Repo = { ...repos[0]!, id: "demo-later", worktrees: [{ ...repos[0]!.worktrees[0]!, id: "later-wt", repoId: "demo-later" }] };
    mocks.tree = { ...mocks.tree, repos: [...repos, later] };
    await act(async () => root.render(<App />));
    expectRepository("demo-later");
  });
  it("opens a worktree-less branch on repository content", async () => {
    await openAnalytics(); await openSwitcher();
    await act(async () => mocks.search!.onPick({ ...hit("demo-one"), kind: "local_branch", name: "demo-feature" }));
    expectRepository("demo-one");
    expect(container.querySelector("[data-testid=new-worktree]")).not.toBeNull();
  });
  it("keeps this window on Contributions when a search pick opens another profile", async () => {
    await openAnalytics(); await openSwitcher();
    await act(async () => mocks.search!.onPick({ ...hit("external-demo"), profileId: "other-profile" }));
    expect(mocks.openProfile).toHaveBeenCalledWith("other-profile", "external-demo", undefined, undefined);
    expect(container.querySelector("[data-testid=contributions]")).not.toBeNull();
  });
});
