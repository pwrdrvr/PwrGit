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
it.each([
  ["repo", "Copy repo name", "demo"],
  ["local_branch", "Copy branch name", "feature/search"],
  ["remote_branch", "Copy branch name", "feature/search"],
  ["worktree", "Copy branch name", "feature/search"]
] as const)("copies the %s name without opening or closing the palette", async (kind, label, name) => {
  await render([{ ...hit, kind, name, remoteRef: "origin/feature/search" }]);
  const button = [...container.querySelectorAll("button")].find((button) => button.textContent?.startsWith(label))!;
  await act(async () => button.click());
  expect(mocks.copyText).toHaveBeenCalledWith(name);
  expect(onPick).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  expect(container.querySelector('[role="status"]')?.textContent).toBe("Copied");
  expect(document.activeElement).toBe(container.querySelector("input"));
});
it.each(["darwin", "win32", "linux"])("copies the selected result and its exact path on %s", async (platform) => {
  const path = "C:\\Repos\\demo space\\worktree";
  await render([hit, { ...hit, kind: "worktree", worktreeId: "linked", name: "feature/search", path }], platform);
  await key("ArrowDown");
  const modifier = platform === "darwin" ? { metaKey: true } : { ctrlKey: true };
  await key("c", { ...modifier, shiftKey: true });
  expect(mocks.copyText).toHaveBeenLastCalledWith("feature/search");
  await key(platform === "darwin" ? "ç" : "c", { ...modifier, altKey: true, code: "KeyC" });
  expect(mocks.copyText).toHaveBeenLastCalledWith(path);
  expect((await key("c", modifier)).defaultPrevented).toBe(false);
  expect(mocks.copyText).toHaveBeenCalledTimes(2);
  await key("Enter");
  expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ worktreeId: "linked" }));
});
it("copies the repository path and reports clipboard failure", async () => {
  await render([hit]);
  mocks.copyText.mockRejectedValueOnce(new Error("denied"));
  await key("c", { metaKey: true, altKey: true });
  expect(mocks.copyText).toHaveBeenCalledWith(hit.path);
  expect(container.querySelector('[role="status"]')?.textContent).toBe("Could not copy. Try again.");
});
it("offers only a worktree path for detached HEAD and no worktree path for branch-only hits", async () => {
  await render([{ ...hit, kind: "worktree", name: "detached@abcdef0" }, { ...hit, kind: "remote_branch", name: "feature/search" }]);
  expect(container.querySelector(".overlay-copy-actions")?.textContent).toContain("Copy worktree path");
  expect(container.querySelector(".overlay-copy-actions")?.textContent).not.toContain("Copy branch name");
  await key("ArrowDown");
  expect(container.querySelector(".overlay-copy-actions")?.textContent).not.toContain("path");
});
it("has no copy action when there are no results", async () => {
  await render([]);
  await key("c", { metaKey: true, shiftKey: true });
  expect(mocks.copyText).not.toHaveBeenCalled();
  expect(container.querySelector(".overlay-copy-actions")).toBeNull();
});
