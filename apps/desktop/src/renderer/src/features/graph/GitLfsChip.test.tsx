// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ok, type GitLfsReport } from "@pwrgit/shared";

const dispatchMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/pwrgit", () => ({ dispatch: dispatchMock }));

const toast = vi.hoisted(() => ({
  showErrorToast: vi.fn(),
  showInfoToast: vi.fn(),
  dismissToastKey: vi.fn()
}));
vi.mock("../../lib/toast", () => toast);

vi.mock("../../lib/platform", async (importActual) => ({
  ...(await importActual<typeof import("../../lib/platform")>()),
  currentPlatform: () => "darwin"
}));

import { GitLfsChip } from "./GitLfsChip";

const KEY = "git-lfs:/repos/proj";

let container: HTMLDivElement;
let root: Root;

async function render(report: GitLfsReport, worktreeId = "wt-1"): Promise<void> {
  dispatchMock.mockResolvedValueOnce(ok(report));
  await act(async () => {
    root.render(
      <GitLfsChip
        repoId="repo-1"
        repoName="proj"
        repoPath="/repos/proj"
        worktreeId={worktreeId}
      />
    );
  });
}

const chip = (): HTMLElement | null => container.querySelector(".lfs-chip");

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("GitLfsChip", () => {
  it("stays out of the header and takes down a standing complaint when no rules ask for LFS", async () => {
    await render({ status: { required: false }, announceReady: false });

    expect(chip()).toBeNull();
    expect(toast.dismissToastKey).toHaveBeenCalledExactlyOnceWith(KEY);
    expect(toast.showErrorToast).not.toHaveBeenCalled();
    expect(toast.showInfoToast).not.toHaveBeenCalled();
  });

  it("wears green for a working setup and announces it only when the check says so", async () => {
    const status = {
      required: true,
      installed: true,
      configured: true,
      version: "git-lfs/3.7.1 (GitHub; darwin arm64)"
    } as const;
    await render({ status, announceReady: true });

    const ready = chip();
    expect(ready?.classList.contains("lfs-chip--ok")).toBe(true);
    expect(ready?.textContent).toBe("LFS");
    expect(ready?.getAttribute("title")).toContain(
      "git-lfs/3.7.1 is available"
    );
    expect(toast.showInfoToast).toHaveBeenCalledExactlyOnceWith({
      key: KEY,
      title: "Git LFS ready",
      message:
        "proj stores large files with Git LFS. git-lfs/3.7.1 is available " +
        "to PwrGit and the Git LFS filters are configured."
    });

    // The next worktree of the same repo: still green, already announced.
    await render({ status, announceReady: false }, "wt-2");
    expect(chip()?.classList.contains("lfs-chip--ok")).toBe(true);
    expect(toast.showInfoToast).toHaveBeenCalledTimes(1);
    expect(toast.showErrorToast).not.toHaveBeenCalled();
  });

  it("wears danger and raises one sticky repo-keyed toast with the repair steps", async () => {
    await render({
      status: { required: true, installed: false, configured: false },
      announceReady: false
    });

    const broken = chip();
    expect(broken?.tagName).toBe("BUTTON");
    expect(broken?.classList.contains("lfs-chip--broken")).toBe(true);
    expect(broken?.getAttribute("title")).toContain(
      "PwrGit cannot run Git LFS"
    );
    expect(toast.showErrorToast).toHaveBeenCalledExactlyOnceWith({
      key: KEY,
      sticky: true,
      showLogsAction: false,
      title: "Git LFS setup needed",
      message: expect.stringContaining(
        "proj stores large files with Git LFS, but PwrGit cannot run Git " +
          "LFS and the Git LFS filters are not configured."
      ),
      detail: "brew install git-lfs\ngit lfs install\ngit lfs pull"
    });
    expect(toast.showInfoToast).not.toHaveBeenCalled();
  });

  it("skips the install step when only the filters are missing", async () => {
    await render({
      status: { required: true, installed: true, configured: false },
      announceReady: false
    });

    expect(toast.showErrorToast).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        message: expect.stringContaining(
          "but the Git LFS filters are not configured"
        ),
        detail: "git lfs install\ngit lfs pull"
      })
    );
  });

  it("re-checks on click and hands the repair announcement the same key", async () => {
    await render({
      status: { required: true, installed: true, configured: false },
      announceReady: false
    });

    dispatchMock.mockResolvedValueOnce(
      ok({
        status: {
          required: true,
          installed: true,
          configured: true,
          version: "git-lfs/3.7.1"
        },
        announceReady: true
      } satisfies GitLfsReport)
    );
    await act(async () => chip()?.click());

    expect(dispatchMock).toHaveBeenCalledTimes(2);
    expect(chip()?.classList.contains("lfs-chip--ok")).toBe(true);
    expect(toast.showInfoToast).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ key: KEY, title: "Git LFS ready" })
    );
  });
});
