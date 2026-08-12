// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  err,
  ok,
  type PullProgressPhase,
  type SshRemoteRecovery,
  type Worktree,
  type WorktreeState
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

describe("WorktreeHeader default-branch drift", () => {
  const feature: Worktree = {
    ...worktree,
    branch: "releases/1.0",
    isDefaultBranch: false,
    isPrimary: false,
    behind: 0,
    behindDefault: 4
  };
  const render = async (
    w: Worktree,
    state: WorktreeState | null = null
  ): Promise<void> => {
    await act(async () => {
      root.render(<WorktreeHeader worktree={w} state={state} />);
    });
  };
  const drift = (): HTMLElement | null =>
    container.querySelector(".sync-chip--drift");

  it("names the branch the count belongs to, without the warn rung", async () => {
    await render(feature);
    expect(drift()?.textContent).toBe("main +4");
    expect(drift()?.getAttribute("title")).toBe(
      "main has 4 commits not in releases/1.0; this is not commits available to pull"
    );
    // Warn is reserved for ↓behind, which Pull actually clears.
    expect(drift()?.classList.contains("sync-chip--warn")).toBe(false);
  });

  it("reads the count and the name from one source, never a mix", async () => {
    // A stale tree row beside a fresh snapshot that resolved a different
    // default: pairing "main" with 9 would name the wrong comparison.
    await render(
      { ...feature, defaultBranch: "main", behindDefault: 4 },
      {
        worktreeId: feature.id,
        branch: "releases/1.0",
        head: "abc1234",
        hasUpstream: true,
        ahead: 0,
        behind: 0,
        dirty: 0,
        behindDefault: 9,
        defaultBranch: "develop",
        mergedIntoDefault: false,
        divergedFromDefault: false,
        isDefaultBranch: false,
        updatedAt: "2026-08-12T00:00:00.000Z"
      }
    );
    expect(drift()?.textContent).toBe("develop +9");
  });

  it("ignores the snapshot still held from the previous selection", async () => {
    // useWorktreeState keeps the old worktree's state until the new
    // `worktree:getState` resolves. Trusting it here would tell the user
    // viewing `main` that main is 9 commits ahead of a branch they left.
    await render(worktree, {
      worktreeId: "worktree-2",
      branch: "releases/1.0",
      head: "abc1234",
      hasUpstream: true,
      ahead: 0,
      behind: 0,
      dirty: 0,
      behindDefault: 9,
      defaultBranch: "main",
      mergedIntoDefault: false,
      divergedFromDefault: false,
      isDefaultBranch: false,
      updatedAt: "2026-08-12T00:00:00.000Z"
    });
    expect(drift()).toBeNull();
  });

  it("says nothing on the default branch, or once the work is in it", async () => {
    await render(worktree);
    expect(drift()).toBeNull();
    await render({ ...feature, mergedIntoDefault: true });
    expect(drift()).toBeNull();
    await render({ ...feature, behindDefault: 0 });
    expect(drift()).toBeNull();
  });
});
