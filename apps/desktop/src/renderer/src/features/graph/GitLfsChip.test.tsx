// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ok, type GitLfsReport, type Result } from "@pwrgit/shared";

const dispatchMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/pwrgit", () => ({ dispatch: dispatchMock }));

const toast = vi.hoisted(() => ({
  showErrorToast: vi.fn(),
  showInfoToast: vi.fn(),
  dismissToastKey: vi.fn()
}));
vi.mock("../../lib/toast", () => toast);

import { GitLfsChip } from "./GitLfsChip";

const KEY = "git-lfs:/repos/proj";
const READY = {
  required: true,
  installed: true,
  configured: true,
  version: "git-lfs/3.7.1 (GitHub; darwin arm64)"
} as const;

let container: HTMLDivElement;
let root: Root;

function mount(worktreeId: string, platform: string): void {
  root.render(
    <GitLfsChip
      repoId="repo-1"
      repoName="proj"
      repoPath="/repos/proj"
      worktreeId={worktreeId}
      platform={platform}
    />
  );
}

async function render(
  report: GitLfsReport,
  worktreeId = "wt-1",
  platform = "darwin"
): Promise<void> {
  dispatchMock.mockResolvedValueOnce(ok(report));
  await act(async () => {
    mount(worktreeId, platform);
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
  it("renders nothing and says nothing when no rules ask for LFS", async () => {
    await render({ status: { required: false }, announceReady: false });

    expect(chip()).toBeNull();
    // A checkout without rules says nothing about the repo's setup — it must
    // not take down a complaint a sibling worktree's rules still justify.
    expect(toast.dismissToastKey).not.toHaveBeenCalled();
    expect(toast.showErrorToast).not.toHaveBeenCalled();
    expect(toast.showInfoToast).not.toHaveBeenCalled();
  });

  it("wears green and announces a newly working setup once", async () => {
    await render({ status: READY, announceReady: true });

    const ready = chip();
    expect(ready?.classList.contains("lfs-chip--ok")).toBe(true);
    expect(ready?.getAttribute("title")).toContain(
      "git-lfs/3.7.1 is available"
    );
    // The pointer-only title is mirrored for the accessibility tree.
    expect(ready?.querySelector(".a11y-sr-only")?.textContent).toContain(
      "git-lfs/3.7.1 is available"
    );
    expect(toast.showInfoToast).toHaveBeenCalledExactlyOnceWith({
      key: KEY,
      title: "Git LFS ready",
      message:
        "proj stores large files with Git LFS. git-lfs/3.7.1 is available " +
        "to PwrGit and the Git LFS filters are configured."
    });
    expect(toast.showErrorToast).not.toHaveBeenCalled();
  });

  it("quietly clears a standing complaint when ready is old news", async () => {
    await render({ status: READY, announceReady: false });

    expect(chip()?.classList.contains("lfs-chip--ok")).toBe(true);
    expect(toast.showInfoToast).not.toHaveBeenCalled();
    // Ready with nothing to announce still means yesterday's complaint for
    // this repo must not keep standing.
    expect(toast.dismissToastKey).toHaveBeenCalledExactlyOnceWith(KEY);
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

  it("hands Windows and Linux their own install steps", async () => {
    const broken = {
      status: { required: true, installed: false, configured: false },
      announceReady: false
    } as const;

    await render(broken, "wt-1", "win32");
    expect(toast.showErrorToast).toHaveBeenLastCalledWith(
      expect.objectContaining({
        detail: "winget install GitHub.GitLFS\ngit lfs install\ngit lfs pull"
      })
    );

    await render(broken, "wt-2", "linux");
    expect(toast.showErrorToast).toHaveBeenLastCalledWith(
      expect.objectContaining({
        detail:
          "# install git-lfs with your package manager\n" +
          "git lfs install\ngit lfs pull"
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
        status: READY,
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

  it("still raises the news from a superseded check", async () => {
    // The main process consumes the once-per-repo announcement while
    // answering, so a response that lost the requestId race may be the only
    // one that will ever carry announceReady — it must not be dropped.
    let resolveFirst: (r: Result<GitLfsReport>) => void = () => undefined;
    dispatchMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFirst = resolve;
      })
    );
    await act(async () => {
      mount("wt-1", "darwin");
    });

    // A sibling worktree supersedes the in-flight check and answers quietly.
    await render({ status: READY, announceReady: false }, "wt-2");
    expect(toast.showInfoToast).not.toHaveBeenCalled();

    await act(async () => {
      resolveFirst(ok({ status: READY, announceReady: true }));
    });
    expect(toast.showInfoToast).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ key: KEY, title: "Git LFS ready" })
    );
  });
});
