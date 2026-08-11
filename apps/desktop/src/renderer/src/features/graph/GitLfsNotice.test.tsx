// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ok, type GitLfsStatus } from "@pwrgit/shared";

const dispatchMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/pwrgit", () => ({ dispatch: dispatchMock }));

import { GitLfsNotice, LFS_READY_DISMISS_MS } from "./GitLfsNotice";

let container: HTMLDivElement;
let root: Root;

async function renderStatus(status: GitLfsStatus): Promise<void> {
  dispatchMock.mockResolvedValue(ok(status));
  await act(async () => {
    root.render(<GitLfsNotice repoId="repo-1" worktreeId="worktree-1" />);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("GitLfsNotice", () => {
  it("shows ready as a transient dismissible confirmation", async () => {
    await renderStatus({
      required: true,
      installed: true,
      configured: true,
      version: "git-lfs/3.7.1"
    });

    expect(container.textContent).toContain("Git LFS required");
    expect(container.textContent).toContain("Ready");
    expect(container.textContent).toContain("Dismiss");
    expect(container.textContent).not.toContain("Check again");
    expect(container.textContent).not.toContain("Setup instructions");

    await act(async () => {
      vi.advanceTimersByTime(LFS_READY_DISMISS_MS);
    });
    expect(container.textContent).toBe("");
  });

  it("dismisses a ready confirmation immediately on request", async () => {
    await renderStatus({
      required: true,
      installed: true,
      configured: true
    });

    const dismiss = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Dismiss"
    );
    expect(dismiss).toBeDefined();
    await act(async () => dismiss?.click());
    expect(container.textContent).toBe("");
  });

  it("keeps setup-needed visible with repair actions", async () => {
    await renderStatus({
      required: true,
      installed: true,
      configured: false,
      version: "git-lfs/3.7.1"
    });

    expect(container.textContent).toContain("Setup needed");
    expect(container.textContent).toContain("Check again");
    expect(container.textContent).toContain("Setup instructions");
    expect(container.textContent).not.toContain("Dismiss");

    await act(async () => {
      vi.advanceTimersByTime(LFS_READY_DISMISS_MS * 2);
    });
    expect(container.textContent).toContain("Setup needed");
  });
});
