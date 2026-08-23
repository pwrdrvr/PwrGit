// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ok,
  type RemoteSummary,
  type RemoteTagPlan,
  type Repo,
  type TagSummary
} from "@pwrgit/shared";

const dispatchMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/pwrgit", () => ({ dispatch: dispatchMock }));
vi.mock("../../lib/toast", () => ({
  showErrorToast: vi.fn(),
  showInfoToast: vi.fn()
}));

import { TagRemoteDialog } from "./TagRemoteDialog";

const localObject = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const target = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const repo: Repo = {
  id: "repo-1",
  name: "PwrGit",
  path: "/repos/PwrGit",
  profileId: "profile-1",
  pinned: false,
  worktrees: []
};
const tag: TagSummary = {
  name: "v1.2.0",
  fullName: "refs/tags/v1.2.0",
  kind: "annotated",
  objectId: localObject,
  objectType: "tag",
  targetId: target,
  targetType: "commit",
  annotation: { subject: "Release 1.2" }
};
const remotes: RemoteSummary[] = [
  {
    name: "origin",
    fetchUrl: "git@example.com:pwr/PwrGit.git",
    pushUrl: "git@example.com:pwr/PwrGit.git",
    skipFetchAll: false,
    previewBranches: [],
    branchCount: 0
  }
];
const pushPlan: RemoteTagPlan = {
  action: "push",
  remote: "origin",
  tagName: "v1.2.0",
  fullName: "refs/tags/v1.2.0",
  localObjectId: localObject,
  localTargetId: target,
  status: "create"
};

let container: HTMLDivElement;
let root: Root;
const onCompleted = vi.fn();
const onClose = vi.fn();

async function render(): Promise<void> {
  await act(async () => {
    root.render(
      <TagRemoteDialog
        repo={repo}
        tag={tag}
        remotes={remotes}
        onCompleted={onCompleted}
        onClose={onClose}
      />
    );
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  dispatchMock.mockImplementation((command: string) =>
    Promise.resolve(
      command === "tag:planRemote"
        ? ok(pushPlan)
        : ok({
            action: "push",
            remote: "origin",
            tagName: "v1.2.0",
            outcome: "pushed"
          })
    )
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("TagRemoteDialog", () => {
  it("requires a review and applies the exact returned plan", async () => {
    await render();
    const review = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Review action"
    )!;
    await act(async () => review.click());

    expect(dispatchMock).toHaveBeenNthCalledWith(1, "tag:planRemote", {
      repoId: "repo-1",
      name: "v1.2.0",
      remote: "origin",
      action: "push"
    });
    expect(container.textContent).toContain(localObject.slice(0, 12));
    expect(container.textContent).toContain("requires it to remain absent");

    const push = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Push tag"
    )!;
    await act(async () => push.click());
    expect(dispatchMock).toHaveBeenNthCalledWith(2, "tag:applyRemote", {
      repoId: "repo-1",
      plan: pushPlan
    });
    expect(onCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "pushed" })
    );
  });

  it("offers remote deletion only as a separate reviewed action", async () => {
    const deletePlan: RemoteTagPlan = {
      action: "delete",
      remote: "origin",
      tagName: "v1.2.0",
      fullName: "refs/tags/v1.2.0",
      remoteObjectId: localObject,
      remoteTargetId: target,
      status: "delete"
    };
    dispatchMock.mockResolvedValue(ok(deletePlan));
    await render();
    const action = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Remote tag action"]'
    )!;
    await act(async () => {
      action.value = "delete";
      action.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(
      Array.from(container.querySelectorAll("button")).some(
        (button) => button.textContent === "Delete remote tag"
      )
    ).toBe(false);

    const review = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Review action"
    )!;
    await act(async () => review.click());
    expect(dispatchMock).toHaveBeenCalledWith("tag:planRemote", {
      repoId: "repo-1",
      name: "v1.2.0",
      remote: "origin",
      action: "delete"
    });
    expect(container.textContent).toContain("Delete remote tag");
    expect(container.textContent).toContain("requiring the remote tag to remain exactly");
  });
});
