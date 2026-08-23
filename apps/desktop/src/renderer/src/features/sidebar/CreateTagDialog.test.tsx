// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ok, type Repo, type TagSummary } from "@pwrgit/shared";

const dispatchMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/pwrgit", () => ({ dispatch: dispatchMock }));
vi.mock("../../lib/toast", () => ({
  showErrorToast: vi.fn(),
  showInfoToast: vi.fn()
}));

import { CreateTagDialog } from "./CreateTagDialog";

const repo: Repo = {
  id: "repo-1",
  name: "PwrGit",
  path: "/repos/PwrGit",
  profileId: "profile-1",
  pinned: false,
  worktrees: []
};
const target = "466c894abcdef0123456789abcdef0123456789a";
const created: TagSummary = {
  name: "v1.2.0",
  fullName: "refs/tags/v1.2.0",
  kind: "lightweight",
  objectId: target,
  objectType: "commit",
  targetId: target,
  targetType: "commit"
};

let container: HTMLDivElement;
let root: Root;
const onCreated = vi.fn();
const onClose = vi.fn();

async function render(): Promise<void> {
  await act(async () => {
    root.render(
      <CreateTagDialog repo={repo} onCreated={onCreated} onClose={onClose} />
    );
  });
}

async function value(element: HTMLInputElement | HTMLTextAreaElement, next: string) {
  await act(async () => {
    const prototype =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, next);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  dispatchMock.mockResolvedValue(ok(created));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("CreateTagDialog", () => {
  it("creates a lightweight tag only at the explicit commit entered", async () => {
    await render();
    const fields = container.querySelectorAll<HTMLInputElement>("input");
    await value(fields[0]!, "v1.2.0");
    await value(fields[1]!, target);
    const button = container.querySelector<HTMLButtonElement>(".modal__create")!;
    expect(button.disabled).toBe(false);
    await act(async () => button.click());

    expect(dispatchMock).toHaveBeenCalledExactlyOnceWith("tag:create", {
      repoId: "repo-1",
      name: "v1.2.0",
      targetCommit: target,
      kind: "lightweight"
    });
    expect(onCreated).toHaveBeenCalledExactlyOnceWith(created);
    expect(container.textContent).toContain("never switches a worktree");
  });

  it("requires and sends the annotated message separately", async () => {
    await render();
    const fields = container.querySelectorAll<HTMLInputElement>("input");
    await value(fields[0]!, "v1.2.0");
    await value(fields[1]!, target);
    const select = container.querySelector<HTMLSelectElement>("select")!;
    await act(async () => {
      select.value = "annotated";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const button = container.querySelector<HTMLButtonElement>(".modal__create")!;
    expect(button.disabled).toBe(true);
    await value(
      container.querySelector<HTMLTextAreaElement>("textarea")!,
      "Release 1.2\n\nReviewed notes"
    );
    await act(async () => button.click());

    expect(dispatchMock).toHaveBeenCalledWith("tag:create", {
      repoId: "repo-1",
      name: "v1.2.0",
      targetCommit: target,
      kind: "annotated",
      message: "Release 1.2\n\nReviewed notes"
    });
  });

  it("rejects a branch name as the target commit", async () => {
    await render();
    const fields = container.querySelectorAll<HTMLInputElement>("input");
    await value(fields[0]!, "v1.2.0");
    await value(fields[1]!, "main");

    expect(container.querySelector<HTMLButtonElement>(".modal__create")?.disabled).toBe(
      true
    );
    expect(container.textContent).toContain("not a branch name");
    expect(dispatchMock).not.toHaveBeenCalled();
  });
});
