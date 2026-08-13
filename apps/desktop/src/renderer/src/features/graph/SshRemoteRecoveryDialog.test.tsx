// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ok, type SshRemoteRecovery } from "@pwrgit/shared";

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  showErrorToast: vi.fn(),
  showInfoToast: vi.fn()
}));

vi.mock("../../lib/pwrgit", () => ({ dispatch: mocks.dispatch }));
vi.mock("../../lib/toast", () => ({
  showErrorToast: mocks.showErrorToast,
  showInfoToast: mocks.showInfoToast
}));

import { SshRemoteRecoveryDialog } from "./SshRemoteRecoveryDialog";

const recovery: SshRemoteRecovery = {
  remote: "origin",
  httpsUrl: "https://github.com/pwrdrvr/PwrAgent.git",
  sshUrl: "git@github.com:pwrdrvr/PwrAgent.git",
  pushUrlWillAlsoChange: true
};

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  mocks.dispatch.mockResolvedValue(ok(null));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <SshRemoteRecoveryDialog
        worktreeId="worktree-1"
        recovery={recovery}
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />
    );
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("SshRemoteRecoveryDialog", () => {
  it("explains that checkout-time Git LFS authentication can use SSH", () => {
    expect(container.textContent).toContain("Git LFS during checkout");
    expect(container.textContent).toContain(
      "LFS access is exercised when you choose Pull again"
    );
  });

  it("tests first, changes only after success, and never retries Pull", async () => {
    const onChanged = vi.fn();
    await act(async () => {
      root.render(
        <SshRemoteRecoveryDialog
          worktreeId="worktree-1"
          recovery={recovery}
          onClose={vi.fn()}
          onChanged={onChanged}
        />
      );
    });
    const testButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Test SSH connection"
    );

    await act(async () => {
      testButton?.click();
      await Promise.resolve();
    });

    expect(mocks.dispatch).toHaveBeenCalledExactlyOnceWith(
      "remote:testSshRecovery",
      { worktreeId: "worktree-1", recovery }
    );
    expect(container.textContent).toContain("SSH can read this repository");
    expect(container.textContent).toContain("and effective push URL");
    const changeButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Change origin to SSH"
    );

    await act(async () => {
      changeButton?.click();
      await Promise.resolve();
    });

    expect(mocks.dispatch).toHaveBeenLastCalledWith(
      "remote:applySshRecovery",
      { worktreeId: "worktree-1", recovery }
    );
    expect(
      mocks.dispatch.mock.calls.some(([name]) => name === "remote:pull")
    ).toBe(false);
    expect(mocks.showInfoToast).toHaveBeenCalledWith({
      title: "Remote changed to SSH",
      message: "origin now uses SSH. Pull again when you are ready."
    });
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it("warns when changing the fetch URL also changes the effective push URL", () => {
    expect(container.textContent).toContain(
      "Changing this remote to SSH will also change the address Git uses for pushes"
    );
    expect(container.textContent).toContain(
      "The read-only test does not verify push permission"
    );
  });

  it("explains when a separate push URL remains unchanged", async () => {
    await act(async () => {
      root.render(
        <SshRemoteRecoveryDialog
          worktreeId="worktree-1"
          recovery={{ ...recovery, pushUrlWillAlsoChange: false }}
          onClose={vi.fn()}
          onChanged={vi.fn()}
        />
      );
    });

    expect(container.textContent).toContain(
      "A separate push URL is configured and will remain unchanged"
    );
    expect(container.textContent).not.toContain(
      "also change the address Git uses for pushes"
    );
  });
});
