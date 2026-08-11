// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  err,
  ok,
  type PullProgressPhase,
  type SshRemoteRecovery,
  type Worktree
} from "@pwrgit/shared";

const bridge = vi.hoisted(() => ({
  dispatch: vi.fn(),
  subscribe: vi.fn(),
  onProgress: undefined as
    | ((event: { worktreeId: string; phase: PullProgressPhase }) => void)
    | undefined
}));

vi.mock("../../lib/pwrgit", () => ({
  dispatch: bridge.dispatch,
  subscribe: bridge.subscribe
}));
vi.mock("../../lib/toast", () => ({
  showErrorToast: vi.fn(),
  showInfoToast: vi.fn()
}));
vi.mock("../shell/WorktreeMenu", () => ({ WorktreeMenu: () => null }));

import { WorktreeHeader } from "./WorktreeHeader";

const worktree: Worktree = {
  id: "worktree-1",
  repoId: "repo-1",
  branch: "main",
  path: "/repos/project",
  dirty: 0,
  ahead: 0,
  behind: 24,
  behindDefault: 0,
  defaultBranch: "main",
  mergedIntoDefault: false,
  divergedFromDefault: false,
  isDefaultBranch: true,
  pinned: false,
  isPrimary: true
};

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  bridge.dispatch.mockReturnValue(new Promise(() => undefined));
  bridge.subscribe.mockImplementation((_channel, handler) => {
    bridge.onProgress = handler;
    return () => undefined;
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<WorktreeHeader worktree={worktree} state={null} />);
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  bridge.onProgress = undefined;
  vi.clearAllMocks();
});

describe("WorktreeHeader pull progress", () => {
  it("replaces the indefinite pull label with each worktree-scoped phase", async () => {
    const pull = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Pull"]'
    );
    expect(pull).not.toBeNull();

    await act(async () => pull?.click());
    expect(pull?.getAttribute("aria-busy")).toBe("true");
    expect(container.textContent).toContain("Fetching updates…");
    expect(
      container
        .querySelector('[role="status"]')
        ?.classList.contains("sync-chip--progress")
    ).toBe(true);

    for (const [phase, label] of [
      ["prepare", "Preparing local changes…"],
      ["fast_forward", "Fast-forwarding and checking out files…"],
      ["reapply", "Reapplying local changes…"],
      ["refresh", "Finishing refresh…"]
    ] as const) {
      await act(async () => {
        bridge.onProgress?.({ worktreeId: worktree.id, phase });
      });
      expect(container.textContent).toContain(label);
      expect(pull?.getAttribute("aria-label")).toBe(label);
    }

    await act(async () => {
      bridge.onProgress?.({
        worktreeId: "another-worktree",
        phase: "fetch"
      });
    });
    expect(container.textContent).toContain("Finishing refresh…");
  });

  it("offers SSH recovery after a GitHub HTTPS authentication failure", async () => {
    const recovery: SshRemoteRecovery = {
      remote: "origin",
      httpsUrl: "https://github.com/pwrdrvr/PwrAgent.git",
      sshUrl: "git@github.com:pwrdrvr/PwrAgent.git",
      pushUrlWillAlsoChange: true
    };
    bridge.dispatch.mockImplementation((name: string) => {
      if (name === "remote:pull") {
        return Promise.resolve(
          err({
            kind: "remote",
            code: "authentication_required",
            message: "Pull needs authentication."
          })
        );
      }
      if (name === "remote:inspectSshRecovery") {
        return Promise.resolve(ok(recovery));
      }
      return new Promise(() => undefined);
    });
    const pull = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Pull"]'
    );

    await act(async () => {
      pull?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(bridge.dispatch).toHaveBeenCalledWith("remote:inspectSshRecovery", {
      worktreeId: worktree.id
    });
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(container.textContent).toContain("Try this remote with SSH?");
    expect(container.textContent).toContain(recovery.sshUrl);
  });
});
