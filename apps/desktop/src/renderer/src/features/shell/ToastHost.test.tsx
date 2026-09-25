// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ok, type Repo } from "@pwrgit/shared";

const dispatchMock = vi.hoisted(() => vi.fn());
const subscribeMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/pwrgit", () => ({
  dispatch: dispatchMock,
  subscribe: subscribeMock,
  windowProfileId: () => "profile-1"
}));

import { ToastHost } from "./ToastHost";
import {
  dismissToast,
  showErrorToast,
  showInfoToast,
  subscribeToasts,
  type Toast
} from "../../lib/toast";

let container: HTMLDivElement;
let root: Root;
const revealMock = vi.fn();
const diskhound: Repo = {
  id: "repo-1",
  name: "diskhound",
  path: "/repos/diskhound",
  profileId: "profile-1",
  pinned: false,
  worktrees: [
    {
      id: "wt-linked",
      repoId: "repo-1",
      branch: "feat/scan",
      path: "/worktrees/diskhound/scan",
      dirty: 0,
      ahead: 0,
      behind: 0,
      behindDefault: 0,
      defaultBranch: "main",
      mergedIntoDefault: false,
      divergedFromDefault: false,
      isDefaultBranch: false,
      pinned: false,
      isPrimary: false
    }
  ]
};

function eyebrows(): string[] {
  return [...container.querySelectorAll(".app-toast__eyebrow")].map((node) =>
    node.className.includes("--info") ? `info:${node.textContent}` : `error:${node.textContent}`
  );
}

beforeEach(async () => {
  // Command-aware: the host now also mounts the live-activity cards, whose
  // store asks for a snapshot on mount and expects a list back.
  dispatchMock.mockImplementation((name: string) =>
    Promise.resolve(ok(name === "remote:activities" ? [] : { status: "idle" }))
  );
  subscribeMock.mockReturnValue(() => undefined);
  let current: Toast[] = [];
  const unsubscribe = subscribeToasts((next) => {
    current = next;
  });
  for (const toast of [...current]) dismissToast(toast.id);
  unsubscribe();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<ToastHost repos={[diskhound]} onReveal={revealMock} />);
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("ToastHost", () => {
  it.each([true, false])("copies the explicit payload when present: %s", async (commandsOnly) => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText }
    });
    await act(async () => {
      showErrorToast({
        title: "Git LFS setup needed",
        message: "Explanation",
        detail: "git lfs install && git lfs pull",
        ...(commandsOnly ? {
          copyText: "git lfs install && git lfs pull",
          copyLabel: "Copy commands"
        } : {})
      });
    });
    const copy = container.querySelector<HTMLButtonElement>(
      `[aria-label="${commandsOnly ? "Copy commands" : "Copy error"}"]`
    );
    expect(copy).not.toBeNull();
    await act(async () => copy?.click());
    expect(writeText).toHaveBeenCalledExactlyOnceWith(commandsOnly
      ? "git lfs install && git lfs pull"
      : "Git LFS setup needed\nExplanation\ngit lfs install && git lfs pull");
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("names the repository and remote a toast is about, as chips that go there", async () => {
    await act(async () => {
      showInfoToast({
        title: "Fetched upstream",
        message: "Remote-tracking branches are up to date.",
        subject: {
          repoId: "repo-1",
          remote: { name: "upstream", url: "git@example.test:someone/diskhound.git" }
        }
      });
      showInfoToast({ title: "Tag created", message: "v1.2.3" });
    });

    const cards = [...container.querySelectorAll(".app-toast")];
    const chips = (card: Element | undefined) =>
      [...(card?.querySelectorAll<HTMLButtonElement>(".app-toast__chip") ?? [])];
    // Only the card with a subject grows the row — a notice about no
    // repository in particular stays as it was.
    expect(chips(cards[0]).map((chip) => chip.textContent)).toEqual([
      "diskhound",
      "upstream"
    ]);
    expect(cards[1]?.querySelector(".app-toast__subject")).toBeNull();
    // The visible word is inside each accessible name (SC 2.5.3).
    expect(chips(cards[0]).map((chip) => chip.getAttribute("aria-label"))).toEqual([
      "Show diskhound in the sidebar",
      "Show remote upstream of diskhound in the sidebar"
    ]);

    await act(async () => chips(cards[0])[0]?.click());
    expect(revealMock).toHaveBeenLastCalledWith("repo-1", null);
    await act(async () => chips(cards[0])[1]?.click());
    expect(revealMock).toHaveBeenLastCalledWith("repo-1", "upstream");
  });

  it("draws a repo chip alone for a toast about the whole repository", async () => {
    await act(async () => {
      showInfoToast({
        title: "Fetched all remotes",
        message: "Remote-tracking branches are up to date.",
        subject: { repoId: "repo-1" }
      });
    });

    expect(
      [...container.querySelectorAll(".app-toast__chip")].map((chip) => chip.textContent)
    ).toEqual(["diskhound"]);
    expect(container.querySelector(".app-toast__subject-sep")).toBeNull();
  });

  it("finds the repository of a toast that names only a worktree", async () => {
    await act(async () => {
      showErrorToast({
        title: "Could not create stash",
        message: "…",
        subject: { worktreeId: "wt-linked" }
      });
    });
    const chip = container.querySelector<HTMLButtonElement>(".app-toast__chip");
    expect(chip?.textContent).toBe("diskhound");
    await act(async () => chip?.click());
    expect(revealMock).toHaveBeenLastCalledWith("repo-1", null);
  });

  it("draws no chip for a repository no longer in the list", async () => {
    // Nowhere left to go — and the card still says what happened.
    await act(async () => {
      showInfoToast({
        title: "Branch deleted",
        message: "feat/scan was deleted locally.",
        subject: { repoId: "repo-gone" }
      });
    });
    expect(eyebrows()).toEqual(["info:Branch deleted"]);
    expect(container.querySelector(".app-toast__subject")).toBeNull();
  });

  it("puts the subject in a copied error, where the chips cannot go", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText }
    });
    await act(async () => {
      showErrorToast({
        title: "Fetch failed",
        message: "Could not resolve host",
        subject: {
          repoId: "repo-1",
          remote: { name: "upstream", url: "git@example.test:someone/diskhound.git" }
        }
      });
    });
    const copy = container.querySelector<HTMLButtonElement>('[aria-label="Copy error"]');
    await act(async () => copy?.click());
    expect(writeText).toHaveBeenCalledExactlyOnceWith(
      "Fetch failed\nRepository: diskhound · Remote: upstream\nCould not resolve host"
    );
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("keeps a confirmation out of the danger color", async () => {
    await act(async () => {
      showErrorToast({ title: "Push failed", message: "remote rejected" });
      showInfoToast({ title: "Tag created", message: "v1.2.3" });
    });

    expect(eyebrows()).toEqual(["error:Push failed", "info:Tag created"]);
  });

  it("replaces a keyed toast in place instead of stacking it", async () => {
    await act(async () => {
      showInfoToast({ key: "check", title: "Checking", message: "…" });
      showErrorToast({ title: "Push failed", message: "remote rejected" });
      showInfoToast({ key: "check", title: "Up to date", message: "v1.0.0" });
    });

    expect(eyebrows()).toEqual(["info:Up to date", "error:Push failed"]);
  });

  it("keeps a hovered toast paused across a keyed replacement", async () => {
    await act(async () => {
      showInfoToast({ key: "check", title: "Checking", message: "…" });
    });
    const card = container.querySelector(".app-toast");
    await act(async () => {
      card?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    expect(
      container.querySelector(".app-toast__timer")?.getAttribute("data-paused")
    ).toBe("true");

    await act(async () => {
      showInfoToast({ key: "check", title: "Up to date", message: "v1.0.0" });
    });

    // The pointer never left, so it will not fire onMouseEnter again — a
    // remount here would silently resume the countdown under the cursor.
    expect(eyebrows()).toEqual(["info:Up to date"]);
    expect(
      container.querySelector(".app-toast__timer")?.getAttribute("data-paused")
    ).toBe("true");
  });

  it("keeps a sticky toast standing with no countdown, until dismissed by hand", async () => {
    vi.useFakeTimers();
    try {
      await act(async () => {
        showErrorToast({ title: "Git LFS setup needed", message: "…", sticky: true });
        showInfoToast({ title: "Tag created", message: "v1.2.3" });
      });

      // The standing card renders nearest the corner — after the transient,
      // whatever order they were raised in — so come-and-go above it never
      // shoves it around. Only the transient card wears the draining bar.
      expect(eyebrows()).toEqual([
        "info:Tag created",
        "error:Git LFS setup needed"
      ]);
      expect(container.querySelectorAll(".app-toast__timer")).toHaveLength(1);

      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
      expect(eyebrows()).toEqual(["error:Git LFS setup needed"]);

      const dismiss = [...container.querySelectorAll("button")].find(
        (button) => button.getAttribute("aria-label") === "Dismiss"
      );
      await act(async () => dismiss?.click());
      expect(eyebrows()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("arms the countdown when a keyed confirmation replaces a sticky complaint", async () => {
    vi.useFakeTimers();
    try {
      await act(async () => {
        showErrorToast({
          key: "lfs",
          title: "Git LFS setup needed",
          message: "…",
          sticky: true
        });
      });
      expect(container.querySelectorAll(".app-toast__timer")).toHaveLength(0);

      await act(async () => {
        showInfoToast({ key: "lfs", title: "Git LFS ready", message: "…" });
      });

      // The card that never had a countdown must start one now.
      expect(eyebrows()).toEqual(["info:Git LFS ready"]);
      expect(container.querySelectorAll(".app-toast__timer")).toHaveLength(1);
      await act(async () => {
        vi.advanceTimersByTime(9_000);
      });
      expect(eyebrows()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("dismisses one toast without disturbing the others", async () => {
    await act(async () => {
      showInfoToast({ title: "Tag created", message: "v1.2.3" });
      showErrorToast({ title: "Push failed", message: "remote rejected" });
    });

    const dismiss = [...container.querySelectorAll("button")].find(
      (button) => button.getAttribute("aria-label") === "Dismiss"
    );
    await act(async () => dismiss?.click());

    expect(eyebrows()).toEqual(["error:Push failed"]);
  });

  it("offers release notes only for a toast that names a version", async () => {
    // "You're up to date (v1.0.0)" is the only place that version appears, so
    // the card that says it carries the way to read what is in it. Every other
    // notice in this stack names none, and must not grow a control for it.
    await act(async () => {
      showInfoToast({
        key: "check",
        title: "PwrGit is up to date",
        message: "You're running v1.0.0.",
        notesUrl: "https://github.com/pwrdrvr/PwrGit/releases/tag/v1.0.0"
      });
      showInfoToast({ title: "Tag created", message: "v1.2.3" });
    });

    const links = container.querySelectorAll<HTMLButtonElement>(
      "button.app-toast__notes"
    );
    expect(links).toHaveLength(1);

    await act(async () => links[0]?.click());
    expect(dispatchMock).toHaveBeenLastCalledWith("shell:openExternal", {
      url: "https://github.com/pwrdrvr/PwrGit/releases/tag/v1.0.0"
    });
  });
});
