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

const offer = {
  branch: "main", upstream: "upstream/main", upstreamRemote: "upstream", target: "origin/main",
  parent: "team/widget", targets: [{ remote: "origin", nameWithOwner: "me/widget", ref: "origin/main" }]
};
const answerReview = (repair: unknown = ok(null)) => dispatchMock.mockImplementation((name: string) =>
  Promise.resolve(name === "repo:refreshIdentities" ? ok({ changed: 0, outcomes: [] })
    : name === "remote:inspectForkTracking" ? ok(offer)
      : name === "remote:repairForkTracking" ? repair : ok(null)));
const clickIn = async (selector: string, label: string) => {
  const button = [...document.querySelectorAll<HTMLButtonElement>(`${selector} button`)].find((node) => node.textContent === label)!;
  await act(async () => button.click());
};

it("draws the route and repairs the primary checkout through the reviewed dialog", async () => {
  answerReview();
  await render();
  expect(container.textContent).toContain("Fork of team/widget");
  // The route as it is: main pulls from and pushes to the original, and the
  // fork sits unused beside it — no refusal, since nothing was refused here.
  expect(container.querySelector(".fork-route__grid")?.getAttribute("aria-label"))
    .toBe("main pulls from and pushes to team/widget. me/widget is not used.");
  expect(container.querySelector(".fork-route__node--unused")?.textContent).toContain("me/widget");
  expect(container.querySelector(".fork-route__arrow--bad")).toBeNull();
  expect(container.textContent).toContain("main pulls from and pushes to the original instead of your fork, me/widget.");
  // Nothing changes from the card itself: it opens the same review Push and
  // Pull open.
  await click("Use your fork for main…");
  expect(dispatchMock).not.toHaveBeenCalledWith("remote:repairForkTracking", expect.anything());
  expect(document.querySelector(".fork-tracking-dialog strong")?.textContent).toBe("Use your fork for main");
  await clickIn(".fork-tracking-dialog", "Use my fork");
  expect(dispatchMock).toHaveBeenCalledWith("remote:repairForkTracking", {
    worktreeId: "worktree-a", branch: "main", upstream: "upstream/main",
    target: { remote: "origin", nameWithOwner: "me/widget" }
  });
  expect(refresh).toHaveBeenCalledOnce();
  expect(document.querySelector(".fork-tracking-dialog")).toBeNull();
  expect(container.textContent).toContain("main now pulls from and pushes to me/widget");
  expect(container.textContent).not.toContain("Use your fork for main…");
});

it("draws a healthy fork's route every time, with Sync only where the original has the branch", async () => {
  const healthy: RepoRefs = {
    ...refs,
    branches: [{ ...refs.branches[0]!, upstream: "origin/main" }],
    remotes: refs.remotes.map((remote) => remote.name === "upstream" ? { ...remote, defaultBranch: "main" } : remote)
  };
  await render(repo, healthy);
  expect(container.textContent).toContain("main pulls from and pushes to your fork. Sync in the Pull menu brings in the original's new work.");
  expect(container.querySelector(".fork-route__grid")?.getAttribute("aria-label"))
    .toBe("main pulls from and pushes to me/widget. Sync in the Pull menu brings in team/widget.");
  expect(container.querySelector(".fork-route__arrow--ghost")?.textContent).toContain("Sync");
  expect(container.textContent).not.toContain("Use your fork for main…");

  await render(
    { ...repo, worktrees: [{ ...worktree, branch: "feature" }] },
    { ...healthy, branches: [{ ...healthy.branches[0]!, name: "feature", fullName: "refs/heads/feature", upstream: "origin/feature" }] }
  );
  expect(container.querySelector(".fork-route__grid")?.getAttribute("aria-label"))
    .toBe("feature pulls from and pushes to me/widget.");
  expect(container.querySelector(".fork-route__arrow--ghost")).toBeNull();

  // A fetched branch of the same name on the original is proof enough.
  const fetched = {
    name: "feature", qualifiedName: "upstream/feature", fullName: "refs/remotes/upstream/feature",
    head: "b".repeat(40), lastCommitAt: "2026-10-01T10:00:00Z", subject: "Add feature"
  };
  await render(
    { ...repo, worktrees: [{ ...worktree, branch: "feature" }] },
    {
      ...healthy,
      branches: [{ ...healthy.branches[0]!, name: "feature", fullName: "refs/heads/feature", upstream: "origin/feature" }],
      remotes: healthy.remotes.map((remote) => remote.name === "upstream" ? { ...remote, previewBranches: [fetched] } : remote)
    }
  );
  expect(container.querySelector(".fork-route__arrow--ghost")?.textContent).toContain("Sync");
});

it("draws nothing for a branch that follows neither the fork nor its parent", async () => {
  await render(repo, { ...refs, branches: [{ ...refs.branches[0]!, upstream: "elsewhere/main" }] });
  expect(container.querySelector(".fork-route")).toBeNull();
  expect(container.textContent).toContain("me/widget is recognized as a fork.");
});

it("recognizes an old fork through an explicit re-check even if no metadata was stored", async () => {
  const { identity: _identity, ...unrecognized } = repo;
  dispatchMock.mockResolvedValue(ok({ changed: 1, outcomes: [{ repoId: repo.id, status: "resolved", identity }] }));
  await render(unrecognized);
  expect(container.textContent).not.toContain("Use your fork for main…");
  await click("Re-check origin");
  expect(dispatchMock).toHaveBeenCalledExactlyOnceWith("repo:refreshIdentities", {
    profileId: "profile-a", repoId: "repo-a", force: true
  });
  expect(container.textContent).toContain("Fork of team/widget");
  expect(container.textContent).toContain("Use your fork for main…");
});

it("keeps a failed repair visible with its reason and does not refresh as if it succeeded", async () => {
  answerReview(err({ kind: "remote", code: "stale", message: "The remotes changed." }));
  await render();
  await click("Use your fork for main…");
  await clickIn(".fork-tracking-dialog", "Use my fork");
  expect(document.querySelector('.fork-tracking-dialog [role="alert"]')?.textContent).toBe("The remotes changed.");
  expect(refresh).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Use your fork for main…");
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
  expect(container.textContent).not.toContain("Use your fork for main…");
});

it("does not offer tracking repair after the branch already tracks the fork", async () => {
  await render(repo, { ...refs, branches: refs.branches.map((row) => ({ ...row, upstream: "origin/main" })) });
  expect(container.textContent).toContain("Fork of team/widget");
  expect(container.textContent).not.toContain("Use your fork for main…");
});
