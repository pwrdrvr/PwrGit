// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ok, type RepoSearchHit } from "@pwrgit/shared";
const mocks = vi.hoisted(() => ({ dispatch: vi.fn(), copyText: vi.fn() }));
vi.mock("../../lib/pwrgit", () => ({ dispatch: mocks.dispatch }));
vi.mock("../../lib/copyText", () => ({ copyText: mocks.copyText }));
import { RepoSwitcherOverlay } from "./RepoSwitcherOverlay";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
const onPick = vi.fn();
const onClose = vi.fn();
const hit: RepoSearchHit = {
  kind: "repo", repoId: "demo", name: "demo", path: "/repos/demo",
  profileId: "default", profileName: "Personal", worktreeCount: 1, pinned: false
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.copyText.mockResolvedValue(undefined);
  vi.stubGlobal("IntersectionObserver", class {
    observe() {} disconnect() {}
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render(hits: RepoSearchHit[], platform = "darwin") {
  mocks.dispatch.mockResolvedValue(ok(hits));
  await act(async () => root.render(<RepoSwitcherOverlay
    commits={[]} commitContext={null} onClose={onClose} onPick={onPick}
    onPickCommit={vi.fn()} onPickFile={vi.fn()} platform={platform}
  />));
}
async function key(key: string, modifiers: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...modifiers });
  await act(async () => container.querySelector("input")!.dispatchEvent(event));
  return event;
}
async function openRow(index: number) {
  const trigger = container.querySelectorAll<HTMLButtonElement>(".overlay-result__actions")[index]!;
  await act(async () => trigger.click());
}
async function choose(label: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find((button) => button.textContent === label)!;
  expect(button).toBeDefined();
  await act(async () => button.click());
}
const menuText = () => document.querySelector('[role="menu"]')?.textContent;

it.each([
  ["repo", "Copy repo name", "demo"],
  ["local_branch", "Copy branch name", "feature/search"],
  ["remote_branch", "Copy branch name", "feature/search"],
  ["worktree", "Copy branch name", "feature/search"]
] as const)("copies the %s row without opening or closing the palette", async (kind, label, name) => {
  await render([hit, { ...hit, kind, name, repoId: "other", remoteRef: "origin/feature/search" }]);
  await openRow(1);
  await choose(label);
  expect(mocks.copyText).toHaveBeenCalledWith(name);
  expect(onPick).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  const rows = container.querySelectorAll('[role="option"]');
  expect(rows[0]?.querySelector('[role="status"]')).toBeNull();
  expect(rows[1]?.querySelector('[role="status"]')?.textContent).toBe("Copied");
  expect(document.activeElement).toBe(container.querySelector("input"));
  expect(document.querySelector('[role="menu"]')).toBeNull();
});
it("copies the clicked worktree's exact path and PR URL, independent of prior selection", async () => {
  const path = "C:\\Repos\\demo space\\worktree";
  const url = "https://example.com/atlas/pull/42";
  await render([hit, {
    ...hit, kind: "worktree", worktreeId: "linked", name: "feature/search", path,
    pr: { number: 42, url, title: "Search", state: "open", isDraft: false }
  }]);
  await openRow(1);
  expect(menuText()).toContain("Copy branch name");
  expect(menuText()).toContain("Copy worktree path");
  expect(menuText()).toContain("Copy pull request URL");
  await choose("Copy worktree path");
  expect(mocks.copyText).toHaveBeenLastCalledWith(path);
  await openRow(1);
  await choose("Copy pull request URL");
  expect(mocks.copyText).toHaveBeenLastCalledWith(url);
});
it("copies the repository path and reports clipboard failure on that row", async () => {
  await render([hit]);
  mocks.copyText.mockRejectedValueOnce(new Error("denied"));
  await openRow(0);
  await choose("Copy repo path");
  expect(mocks.copyText).toHaveBeenCalledWith(hit.path);
  expect(container.querySelector('[role="option"] [role="status"]')?.textContent).toBe("Could not copy. Try again.");
});
it("offers only a path for detached worktrees and only a branch name for branch-only hits", async () => {
  await render([{ ...hit, kind: "worktree", name: "detached@abcdef0" }, { ...hit, kind: "remote_branch", name: "feature/search" }]);
  await openRow(0);
  expect(menuText()).toBe("Copy worktree path");
  await choose("Copy worktree path");
  await openRow(1);
  expect(menuText()).toBe("Copy branch name");
});
it("reaches row actions with Tab and lets menu arrows and Escape act without navigating", async () => {
  await render([hit, { ...hit, repoId: "second", name: "second" }]);
  await key("ArrowDown");
  await key("Tab");
  const trigger = container.querySelectorAll<HTMLButtonElement>(".overlay-result__actions")[1]!;
  expect(document.activeElement).toBe(trigger);
  const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  await act(async () => trigger.dispatchEvent(enter));
  expect(enter.defaultPrevented).toBe(false);
  expect(onPick).not.toHaveBeenCalled();
  // jsdom does not synthesize a button's native keyboard click.
  await act(async () => trigger.click());
  expect(document.activeElement?.textContent).toBe("Copy repo name");
  await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })));
  expect(document.activeElement?.textContent).toBe("Copy repo path");
  await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(container.querySelector("input"));
  await key("Enter");
  expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ name: "second" }));
});
it("leaves normal copy alone and has no actions without results", async () => {
  await render([]);
  expect((await key("c", { metaKey: true })).defaultPrevented).toBe(false);
  expect(mocks.copyText).not.toHaveBeenCalled();
  expect(container.querySelector(".overlay-result__actions")).toBeNull();
  expect(container.querySelector(".overlay-copy-actions")).toBeNull();
});
it("offers a change request's head, URL and an Open action, and opens it in the browser", async () => {
  const url = "https://github.com/octo/orbit/pull/130";
  const request: RepoSearchHit = {
    ...hit, kind: "change_request", repoId: "orbit", name: "feat: never fetched",
    pr: { number: 130, url, title: "feat: never fetched", state: "open", isDraft: false, headRefName: "feat/unfetched" }
  };
  const fork: RepoSearchHit = {
    ...request, name: "docs: typo",
    pr: { ...request.pr!, number: 121, headRefName: "main", headRepoPath: "someone/orbit" }
  };
  await render([request, fork]);
  await openRow(0);
  expect(menuText()).toBe(
    "Copy branch nameCopy pull request URLOpen pull request #130"
  );
  await choose("Copy branch name");
  expect(mocks.copyText).toHaveBeenLastCalledWith("feat/unfetched");
  await openRow(0);
  await choose("Open pull request #130");
  expect(mocks.dispatch).toHaveBeenCalledWith("shell:openExternal", { url });
  // A fork's head is a branch of somebody else's repository.
  await openRow(1);
  expect(menuText()).not.toContain("Copy branch name");
});
it("fetches a change request's head on Enter, then picks the branch it landed on", async () => {
  const request: RepoSearchHit = {
    ...hit, kind: "change_request", repoId: "orbit", name: "feat: never fetched",
    pr: { number: 130, url: "https://github.com/octo/orbit/pull/130", title: "feat: never fetched", state: "open", isDraft: false, headRefName: "feat/unfetched" }
  };
  mocks.dispatch.mockImplementation(async (channel: string) =>
    channel === "pr:fetchHead"
      ? ok({ kind: "remote", branch: "feat/unfetched", fullName: "refs/remotes/origin/feat/unfetched" })
      : ok([request])
  );
  await act(async () => root.render(<RepoSwitcherOverlay
    commits={[]} commitContext={null} onClose={onClose} onPick={onPick}
    onPickCommit={vi.fn()} onPickFile={vi.fn()} platform="darwin"
  />));
  await key("Enter");
  expect(mocks.dispatch).toHaveBeenCalledWith("pr:fetchHead", { repoId: "orbit", number: 130 });
  expect(onPick).toHaveBeenCalledWith(expect.objectContaining({
    kind: "remote_branch",
    name: "feat/unfetched",
    remoteRef: "refs/remotes/origin/feat/unfetched",
    pr: expect.objectContaining({ number: 130 })
  }));
});
