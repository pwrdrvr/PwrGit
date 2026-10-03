// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { err, ok, type Repo, type RepoIdentity, type RepoRefs, type Worktree } from "@pwrgit/shared";

const dispatchMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/pwrgit", () => ({ dispatch: dispatchMock, subscribe: () => () => undefined }));
vi.mock("../../lib/useForgeHostMap", () => ({ useForgeHostMap: () => ({}) }));
import { ForkRemoteStatus } from "./ForkRemoteStatus";

const identity: RepoIdentity = {
  host: "github", hostname: "github.com", owner: "me", name: "widget",
  nameWithOwner: "me/widget", visibility: "public",
  parent: { nameWithOwner: "team/widget", url: "https://github.com/team/widget" }
};
const worktree: Worktree = {
  id: "worktree-a", repoId: "repo-a", branch: "main", path: "/repo-a",
  dirty: 0, ahead: 0, behind: 0, behindDefault: 0, defaultBranch: "main",
  mergedIntoDefault: true, divergedFromDefault: false, isDefaultBranch: true,
  pinned: false, isPrimary: true
};
const repo: Repo = {
  id: "repo-a", name: "widget", path: "/repo-a", profileId: "profile-a",
  pinned: false, worktrees: [worktree], identity
};
const refs: RepoRefs = {
  branches: [{ name: "main", fullName: "refs/heads/main", head: "a".repeat(40),
    upstream: "upstream/main", ahead: 0, behind: 0, tracking: "up_to_date", checkedOutWorktreeIds: [worktree.id] }],
  previewTags: [], tagCount: 0,
  remotes: [
    { name: "origin", fetchUrl: "git@github.com:me/widget.git", pushUrl: "git@github.com:me/widget.git", skipFetchAll: false, previewBranches: [], branchCount: 1 },
    { name: "upstream", fetchUrl: "git@github.com:team/widget.git", pushUrl: "git@github.com:team/widget.git", skipFetchAll: false, previewBranches: [], branchCount: 1 }
  ]
};
let container: HTMLDivElement;
let root: Root;
const refresh = vi.fn();
beforeEach(() => {
  dispatchMock.mockResolvedValue(ok(null));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.resetAllMocks();
});
const render = async (currentRepo = repo, currentRefs = refs) => {
  await act(async () => root.render(<ForkRemoteStatus repo={currentRepo} refs={currentRefs} focusedWorktree={null} onRefresh={refresh} />));
};
const click = async (label: string) => {
  const button = [...container.querySelectorAll("button")].find((node) => node.textContent === label)!;
  await act(async () => button.click());
};

it("explains the parent tracking and repairs the primary checkout in its own profile", async () => {
  await render();
  expect(container.textContent).toContain("Fork of team/widget");
  expect(container.textContent).toContain("main still tracks upstream/main");
  await click("Track origin/main");
  expect(dispatchMock).toHaveBeenCalledExactlyOnceWith("remote:repairForkTracking", {
    worktreeId: "worktree-a", branch: "main", upstream: "upstream/main"
  });
  expect(refresh).toHaveBeenCalledOnce();
  expect(container.textContent).toContain("main now tracks origin/main");
  expect(container.textContent).not.toContain("Track origin/main");
});

it("recognizes an old fork through an explicit re-check even if no metadata was stored", async () => {
  const { identity: _identity, ...unrecognized } = repo;
  dispatchMock.mockResolvedValue(ok({ changed: 1, outcomes: [{ repoId: repo.id, status: "resolved", identity }] }));
  await render(unrecognized);
  expect(container.textContent).not.toContain("Track origin/main");
  await click("Re-check origin");
  expect(dispatchMock).toHaveBeenCalledExactlyOnceWith("repo:refreshIdentities", {
    profileId: "profile-a", repoId: "repo-a", force: true
  });
  expect(container.textContent).toContain("Fork of team/widget");
  expect(container.textContent).toContain("Track origin/main");
});

it("keeps a failed repair visible with its reason and does not refresh as if it succeeded", async () => {
  dispatchMock.mockResolvedValue(err({ kind: "remote", code: "stale", message: "The remotes changed." }));
  await render();
  await click("Track origin/main");
  expect(container.querySelector('[role="status"]')?.textContent).toBe("The remotes changed.");
  expect(refresh).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Track origin/main");
});

it("does not report retained metadata as a successful signed-out refresh", async () => {
  dispatchMock.mockResolvedValue(ok({ changed: 0, outcomes: [{ repoId: repo.id, status: "signed_out", identity }] }));
  await render();
  await click("Re-check origin");
  expect(container.textContent).toContain("Sign in in Settings");
  expect(container.textContent).not.toContain("Fork relationship refreshed.");
});

it("offers a re-check instead of asserting an old origin's fork relationship", async () => {
  await render(repo, { ...refs, remotes: refs.remotes.map((row) => row.name === "origin" ? { ...row, fetchUrl: "git@github.com:stranger/widget.git" } : row) });
  expect(container.textContent).not.toContain("Fork of team/widget");
  expect(container.textContent).not.toContain("Track origin/main");
});

it("does not offer tracking repair after the branch already tracks the fork", async () => {
  await render(repo, { ...refs, branches: refs.branches.map((row) => ({ ...row, upstream: "origin/main" })) });
  expect(container.textContent).toContain("Fork of team/widget");
  expect(container.textContent).not.toContain("Track origin/main");
});
