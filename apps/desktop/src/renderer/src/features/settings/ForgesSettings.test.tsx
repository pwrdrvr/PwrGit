// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { err, ok, type ForgeStatus } from "@pwrgit/shared";

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  subscribe: vi.fn()
}));

vi.mock("../../lib/pwrgit", () => ({
  dispatch: mocks.dispatch,
  subscribe: mocks.subscribe
}));

import { ForgesSettings } from "./ForgesSettings";

function forge(overrides: Partial<ForgeStatus> = {}): ForgeStatus {
  return {
    kind: "github",
    cli: "gh",
    installed: true,
    loggedIn: true,
    capabilities: {
      batchedBranchLookup: true,
      batchedCommitAssociation: true,
      changeSizeAndTimeline: true,
      commitAuthorIdentity: true,
      forkDefaultBranchOnly: true
    },
    ...overrides
  };
}

let container: HTMLDivElement;
let root: Root;
let listener: ((payload: { forges: ForgeStatus[] }) => void) | undefined;
const unsubscribe = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  listener = undefined;
  mocks.subscribe.mockImplementation((_channel: string, cb: typeof listener) => {
    listener = cb;
    return unsubscribe;
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(forges: ForgeStatus[]): Promise<void> {
  mocks.dispatch.mockResolvedValue(ok({ forges }));
  await act(async () => {
    root.render(<ForgesSettings />);
  });
}

describe("ForgesSettings", () => {
  it("reads status from main rather than probing a forge itself", async () => {
    await render([forge()]);

    expect(mocks.dispatch).toHaveBeenCalledWith("forge:status", undefined);
    // Exactly one channel, and nothing that reaches a vendor API.
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("GitHub");
    expect(container.textContent).toContain("Connected");
  });

  it("replaces an initial failure with useful retry UI and recovers", async () => {
    mocks.dispatch.mockResolvedValue(
      err({
        kind: "unknown",
        code: "probe_failed",
        message: "The local service did not answer."
      })
    );
    await act(async () => root.render(<ForgesSettings />));

    const alert = container.querySelector<HTMLElement>("[role='alert']");
    expect(alert?.textContent).toContain("Forge connections couldn’t be checked");
    expect(alert?.textContent).toContain("The local service did not answer.");
    expect(container.textContent).not.toContain("Checking…");

    mocks.dispatch.mockResolvedValue(ok({ forges: [forge()] }));
    await act(async () => {
      alert?.querySelector<HTMLButtonElement>("button")?.click();
    });

    expect(container.textContent).toContain("Connected");
    expect(container.querySelector("[role='alert']")).toBeNull();
  });

  it("names the command that unblocks a signed-out forge", async () => {
    await render([forge({ kind: "gitlab", cli: "glab", loggedIn: false })]);

    expect(container.textContent).toContain("Signed out");
    expect(container.textContent).toContain("glab auth login");
  });

  it("tells the user to install a missing CLI instead of blaming the login", async () => {
    await render([forge({ kind: "gitlab", cli: "glab", installed: false, loggedIn: false })]);

    expect(container.textContent).toContain("Not installed");
    expect(container.textContent).toContain("Install the GitLab CLI");
    expect(container.textContent).not.toContain("auth login");
  });

  it("states an unsupported capability as a limit of that forge", async () => {
    await render([
      forge({
        kind: "gitlab",
        cli: "glab",
        capabilities: {
          batchedBranchLookup: true,
          batchedCommitAssociation: false,
          changeSizeAndTimeline: true,
          commitAuthorIdentity: true,
          forkDefaultBranchOnly: false
        }
      })
    ]);

    // So a missing feature reads as a known limit, not as a bug in PwrGit.
    expect(container.textContent).toContain("Not supported by this forge");
    expect(container.textContent).toContain("commit links in bulk");
  });

  it("repaints when main pushes a change, without being asked again", async () => {
    await render([forge({ loggedIn: false })]);
    expect(container.textContent).toContain("Signed out");

    await act(async () => {
      listener?.({ forges: [forge({ loggedIn: true })] });
    });

    expect(container.textContent).toContain("Connected");
    // Signing in from a terminal must not require a second request.
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
  });

  it("lets a pushed success win over a slower failed read", async () => {
    let settle: ((value: unknown) => void) | undefined;
    mocks.dispatch.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      })
    );
    await act(async () => {
      root.render(<ForgesSettings />);
    });

    // The push lands first, then the stale read resolves.
    await act(async () => {
      listener?.({ forges: [forge({ loggedIn: true })] });
    });
    await act(async () => {
      settle?.(
        err({
          kind: "unknown",
          code: "probe_failed",
          message: "Stale failure"
        })
      );
    });

    expect(container.textContent).toContain("Connected");
    expect(container.textContent).not.toContain("Stale failure");
  });

  it("keeps asking while open, so a terminal sign-in can reach the pane", async () => {
    // Main never probes on its own: `forge:statusChanged` only has something to
    // announce because somebody asked again. Without this tick the pane would
    // sit on "Signed out" forever while the user ran `gh auth login`.
    vi.useFakeTimers();
    try {
      await render([forge({ loggedIn: false })]);
      expect(mocks.dispatch).toHaveBeenCalledTimes(1);

      mocks.dispatch.mockResolvedValue(ok({ forges: [forge({ loggedIn: true })] }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });

      expect(mocks.dispatch.mock.calls.length).toBeGreaterThan(1);
      expect(container.textContent).toContain("Connected");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops asking once the pane closes", async () => {
    vi.useFakeTimers();
    try {
      await render([forge()]);
      act(() => root.unmount());
      root = createRoot(container);
      const afterUnmount = mocks.dispatch.mock.calls.length;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000);
      });

      expect(mocks.dispatch.mock.calls.length).toBe(afterUnmount);
    } finally {
      vi.useRealTimers();
    }
  });

  it("unsubscribes on unmount", async () => {
    await render([forge()]);
    act(() => root.unmount());
    expect(unsubscribe).toHaveBeenCalled();
    root = createRoot(container);
  });
});
