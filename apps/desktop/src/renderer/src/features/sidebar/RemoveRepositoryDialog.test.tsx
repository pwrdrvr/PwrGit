// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ok,
  type RemovalCheckout,
  type RemovalStep,
  type Repo,
  type RepoRemovalProgress,
  type RepoRemovalReview
} from "@pwrgit/shared";

const { dispatch, subscribe } = vi.hoisted(() => ({
  dispatch: vi.fn(),
  subscribe: vi.fn()
}));
vi.mock("../../lib/pwrgit", () => ({ dispatch, subscribe }));

import { RemoveRepositoryDialog } from "./RemoveRepositoryDialog";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const repo: Repo = {
  id: "repo-1",
  name: "harbor-api",
  path: "/src/harbor-api",
  profileId: "profile-1",
  pinned: false,
  worktrees: []
};

const checkout = (over: Partial<RemovalCheckout>): RemovalCheckout => ({
  worktreeId: "wt",
  branch: "feat/x",
  head: "abcdef1234",
  path: "/src/harbor-api-x",
  isPrimary: false,
  missing: false,
  locked: false,
  uncommitted: 0,
  untracked: 0,
  conflicted: 0,
  unpushed: 0,
  upstream: "origin/feat/x",
  inProgress: null,
  pushRemote: "origin",
  bytes: 2048,
  bytesPartial: false,
  inspectError: null,
  ...over
});

const primary = checkout({
  worktreeId: "main",
  branch: "main",
  path: "/src/harbor-api",
  isPrimary: true,
  upstream: "origin/main"
});

const reviewOf = (checkouts: RemovalCheckout[]): RepoRemovalReview => ({
  repoId: "repo-1",
  profileId: "profile-1",
  name: "harbor-api",
  path: "/src/harbor-api",
  remotes: [{ name: "origin", url: "git@example.com:acme/harbor-api.git" }],
  checkouts,
  stashes: { count: 0, newestSubject: null, newestAt: null },
  branches: [],
  reviewedAt: "2026-10-01T00:00:00.000Z"
});

let container: HTMLDivElement;
let root: Root;
let progress: ((event: RepoRemovalProgress) => void) | undefined;
const onClose = vi.fn();
const onRemoved = vi.fn();
const onOpenWorktree = vi.fn();

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  progress = undefined;
  subscribe.mockImplementation(
    (_channel: string, handler: (event: RepoRemovalProgress) => void) => {
      progress = handler;
      return vi.fn();
    }
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.resetAllMocks();
});

async function open(review: RepoRemovalReview, onRemove?: () => unknown): Promise<void> {
  dispatch.mockImplementation((channel: string) => {
    if (channel === "repo:removalReview") return Promise.resolve(ok(review));
    if (channel === "repo:remove") return Promise.resolve(onRemove?.());
    return Promise.resolve(ok(null));
  });
  await act(async () => {
    root.render(
      <RemoveRepositoryDialog
        repo={repo}
        platform="darwin"
        onClose={onClose}
        onRemoved={onRemoved}
        onOpenWorktree={onOpenWorktree}
      />
    );
  });
}

const dangerButton = (): HTMLButtonElement =>
  container.querySelector<HTMLButtonElement>(".modal__create--danger")!;
const radio = (group: string, label: string): HTMLButtonElement =>
  [...container.querySelectorAll<HTMLButtonElement>(`[aria-label="${group}"] [role="radio"]`)].find(
    (button) => button.textContent === label
  )!;
const text = (): string => container.textContent ?? "";

describe("RemoveRepositoryDialog", () => {
  it("lands on Cancel and says what goes and what stays", async () => {
    await open(reviewOf([checkout({ worktreeId: "done", branch: "feat/done" }), primary]));
    expect(document.activeElement?.textContent).toBe("Cancel");
    expect(text()).toContain("Remove harbor-api from disk");
    expect(text()).toContain("Moved to the Trash");
    expect(text()).toContain("2 folders · 4 KB");
    expect(text()).toContain("git@example.com:acme/harbor-api.git");
    expect(text()).toContain("2 safe");
    expect(dangerButton().textContent).toBe("Move 2 folders to Trash");
    expect(dangerButton().disabled).toBe(false);
  });

  it("holds the button until every risk has an answer", async () => {
    await open(
      reviewOf([
        checkout({ worktreeId: "dirty", branch: "feat/dirty", uncommitted: 3, unpushed: 2 }),
        primary
      ])
    );
    expect(text()).toContain("3 uncommitted files · 2 unpushed commits");
    expect(text()).toContain(
      "Push first is off: it would save the 2 commits but not the 3 uncommitted files."
    );
    expect(text()).toContain("1 needs a choice · 1 safe");
    expect(dangerButton().disabled).toBe(true);

    await act(async () => radio("What to do with feat/dirty", "Keep").click());
    // Keeping a worktree keeps the main checkout: a partial removal, which
    // here removes nothing at all.
    expect(text()).toContain("harbor-api stays in PwrGit");
    expect(dangerButton().disabled).toBe(true);

    await act(async () => radio("What to do with feat/dirty", "Discard").click());
    // A full removal that discards work asks for the name.
    expect(text()).toContain("This discards 3 uncommitted files, 2 commits in feat/dirty");
    expect(dangerButton().textContent).toBe("Remove harbor-api");
    expect(dangerButton().disabled).toBe(true);
    const input = container.querySelector<HTMLInputElement>(".remove-repo__gate input")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "harbor-api");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(dangerButton().disabled).toBe(false);
  });

  it("sends the answers and the typed name, then streams the steps", async () => {
    const steps: RemovalStep[] = [
      { id: "dirty", kind: "trash", worktreeId: "dirty", label: "feat/dirty", path: "/src/harbor-api-x", isPrimary: false, status: "done" },
      { id: "main", kind: "trash", worktreeId: "main", label: "Main checkout", path: "/src/harbor-api", isPrimary: true, status: "done" }
    ];
    await open(
      reviewOf([checkout({ worktreeId: "dirty", branch: "feat/dirty", untracked: 1 }), primary]),
      () => {
        progress?.({ operationId: "x", profileId: "profile-1", repoId: "repo-1", steps });
        return ok({ outcome: "removed", steps });
      }
    );
    await act(async () => radio("What to do with feat/dirty", "Discard").click());
    const input = container.querySelector<HTMLInputElement>(".remove-repo__gate input")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "harbor-api");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => dangerButton().click());
    const call = dispatch.mock.calls.find(([channel]) => channel === "repo:remove");
    expect(call?.[1]).toMatchObject({
      repoId: "repo-1",
      decisions: { checkouts: { dirty: "discard" }, branches: {} },
      confirmName: "harbor-api"
    });
    expect(text()).toContain("Removed harbor-api");
    expect(text()).toContain("2 folders, 4 KB, are in the Trash.");
    expect(onRemoved).toHaveBeenCalledTimes(1);
  });

  it("sends a blocked worktree to its checkout, and only Keep gets past it", async () => {
    await open(
      reviewOf([
        checkout({ worktreeId: "rb", branch: "feat/rb", inProgress: "rebase", uncommitted: 1 }),
        primary
      ])
    );
    expect(text()).toContain("Finish or abort the rebase first.");
    expect(text()).toContain("1 blocked · 1 safe");
    const openButton = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Open worktree"
    );
    await act(async () => openButton?.click());
    expect(onOpenWorktree).toHaveBeenCalledWith("rb");
    expect(onClose).toHaveBeenCalled();
  });

  it("pushes first through the ordinary push, then removes on a fresh review", async () => {
    const ahead = checkout({ worktreeId: "ahead", branch: "feat/ahead", unpushed: 2, upstream: null });
    let reviews = 0;
    dispatch.mockImplementation((channel: string) => {
      if (channel === "repo:removalReview") {
        reviews += 1;
        // After the push the worktree has nothing left to lose.
        return Promise.resolve(
          ok(reviewOf([reviews === 1 ? ahead : { ...ahead, unpushed: 0, upstream: "origin/feat/ahead" }, primary]))
        );
      }
      if (channel === "repo:remove") return Promise.resolve(ok({ outcome: "removed", steps: [] }));
      return Promise.resolve(ok(null));
    });
    await act(async () => {
      root.render(
        <RemoveRepositoryDialog repo={repo} onClose={onClose} onOpenWorktree={onOpenWorktree} />
      );
    });
    await act(async () => radio("What to do with feat/ahead", "Push first").click());
    expect(container.querySelector(".remove-repo__gate")).toBeNull();
    await act(async () => dangerButton().click());
    const channels = dispatch.mock.calls.map(([channel]) => channel);
    expect(channels).toEqual([
      "repo:removalReview",
      "remote:push",
      "repo:removalReview",
      "repo:remove"
    ]);
    expect(dispatch.mock.calls[1]?.[1]).toEqual({
      worktreeId: "ahead",
      publish: { remote: "origin" }
    });
  });
});
