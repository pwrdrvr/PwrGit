// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BulkSyncSummary, Repo } from "@pwrgit/shared";

const { dispatch, subscribe } = vi.hoisted(() => ({
  dispatch: vi.fn(),
  subscribe: vi.fn()
}));
vi.mock("../../lib/pwrgit", () => ({ dispatch, subscribe }));

import {
  BulkSyncDialog,
  livePathLine,
  TOAST_DISMISS_MS,
  type BulkSyncPresentation
} from "./BulkSyncDialog";
import type { BulkSyncView } from "./bulk-sync-prefs";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The run outlives its view: the dialog minimises to a toast (button,
 * Escape, backdrop, or by itself on a first run), the toast expands back,
 * and none of it touches the Git operation underneath.
 * Design: design/Fetch Toast and Scope - UX Review.dc.html, turn 2.
 */
const repos: Repo[] = [
  {
    id: "repo-a",
    name: "atlas-api",
    path: "/repos/atlas-api",
    profileId: "profile-1",
    pinned: false,
    worktrees: []
  }
];

function cleanSummary(): BulkSyncSummary {
  return {
    operationId: "op",
    mode: "fetch",
    cancelled: false,
    startedAt: "2026-10-27T12:00:00.000Z",
    finishedAt: "2026-10-27T12:00:03.000Z",
    counts: {
      repos: { success: 1, partial: 0, skipped: 0, failed: 0, cancelled: 0 },
      remotes: { fetched: 1, skipped: 0, failed: 0, cancelled: 0 },
      worktrees: { updated: 0, upToDate: 0, skipped: 0, failed: 0, cancelled: 0 }
    },
    results: [
      {
        repoId: "repo-a",
        name: "atlas-api",
        path: "/repos/atlas-api",
        outcome: "success",
        remotes: [{ remote: "origin", outcome: "fetched" }],
        worktrees: []
      }
    ]
  };
}

let container: HTMLDivElement;
let root: Root;
let finish: (summary: BulkSyncSummary) => void;
const views: BulkSyncView[] = [];

function Harness({
  initial,
  autoMinimizeMs = null,
  onClose,
  onFinished
}: {
  initial: BulkSyncPresentation;
  autoMinimizeMs?: number | null;
  onClose: () => void;
  onFinished?: () => void;
}) {
  const [view, setView] = useState<BulkSyncPresentation>(initial);
  return (
    <BulkSyncDialog
      profileId="profile-1"
      repos={repos}
      repoIds={["repo-a"]}
      scope="recent"
      mode="fetch"
      platform="darwin"
      view={view}
      autoMinimizeMs={autoMinimizeMs}
      onViewChange={(next) => {
        views.push(next);
        setView(next);
      }}
      {...(onFinished === undefined ? {} : { onFinished })}
      onClose={onClose}
    />
  );
}

async function render(props: Parameters<typeof Harness>[0]): Promise<void> {
  await act(async () => {
    root.render(<Harness {...props} />);
  });
}

const dialog = (): Element | null => document.querySelector('[role="dialog"]');
const toast = (): Element | null => document.querySelector(".bulk-sync-toast");
const byName = (name: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll("button")].find(
    (el) => el.getAttribute("aria-label") === name || el.textContent === name
  );
  if (found === undefined) throw new Error(`no button ${name}`);
  return found;
};

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  views.length = 0;
  subscribe.mockImplementation(() => vi.fn());
  dispatch.mockImplementation((command: string) => {
    if (command === "remote:bulkSync") {
      return new Promise((resolve) => {
        finish = (value) => resolve({ ok: true, value });
      });
    }
    return Promise.resolve({ ok: true, value: { cancelled: true } });
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  dispatch.mockReset();
  subscribe.mockReset();
  vi.useRealTimers();
});

describe("BulkSyncDialog views", () => {
  it("fetches only the repositories it was given, under a title that says so", async () => {
    await render({ initial: "dialog", onClose: vi.fn() });
    expect(dispatch).toHaveBeenCalledWith(
      "remote:bulkSync",
      expect.objectContaining({ mode: "fetch", repoIds: ["repo-a"] })
    );
    expect(dialog()?.getAttribute("aria-label")).toBe(
      "Fetch recent repositories"
    );
  });

  it("minimises to a toast without stopping the run, and expands back", async () => {
    await render({ initial: "dialog", onClose: vi.fn() });
    await act(async () => byName("Minimise to a toast").click());
    expect(views).toEqual(["toast"]);
    expect(dialog()).toBeNull();
    expect(toast()?.textContent).toContain("Preparing the next repository…");
    // Minimising is not cancelling.
    expect(
      dispatch.mock.calls.filter(([c]) => c === "remote:cancelBulkSync")
    ).toHaveLength(0);

    await act(async () => byName("Show details").click());
    expect(views).toEqual(["toast", "dialog"]);
    expect(dialog()).not.toBeNull();
  });

  it("minimises on Escape while running, and closes on Escape once done", async () => {
    const onClose = vi.fn();
    await render({ initial: "dialog", onClose });
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(views).toEqual(["toast"]);
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => byName("Show details").click());
    await act(async () => {
      finish(cleanSummary());
    });
    // Finished: nothing left to minimise, so Escape means close again.
    expect(() => byName("Minimise to a toast")).toThrow();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("minimises on a backdrop click while running", async () => {
    await render({ initial: "dialog", onClose: vi.fn() });
    await act(async () => {
      (document.querySelector(".bulk-sync-backdrop") as HTMLElement).click();
    });
    expect(views).toEqual(["toast"]);
  });

  it("cancels from the toast", async () => {
    await render({ initial: "toast", onClose: vi.fn() });
    await act(async () => byName("Cancel").click());
    expect(dispatch).toHaveBeenCalledWith(
      "remote:cancelBulkSync",
      expect.objectContaining({ operationId: expect.any(String) })
    );
  });

  it("on a first run, minimises itself unless the reader touches the dialog", async () => {
    vi.useFakeTimers();
    await render({ initial: "dialog", autoMinimizeMs: 4_000, onClose: vi.fn() });
    await act(async () => vi.advanceTimersByTime(3_999));
    expect(views).toEqual([]);
    await act(async () => vi.advanceTimersByTime(1));
    expect(views).toEqual(["toast"]);
  });

  it("stays put on a first run once the pointer has moved over it", async () => {
    vi.useFakeTimers();
    await render({ initial: "dialog", autoMinimizeMs: 4_000, onClose: vi.fn() });
    await act(async () => {
      dialog()!.dispatchEvent(new Event("pointermove", { bubbles: true }));
    });
    await act(async () => vi.advanceTimersByTime(10_000));
    expect(views).toEqual([]);
    expect(dialog()).not.toBeNull();
  });

  it("lets a clean finish leave the toast by itself, and reports the end once", async () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const onFinished = vi.fn();
    await render({ initial: "toast", onClose, onFinished });
    await act(async () => {
      finish(cleanSummary());
    });
    expect(onFinished).toHaveBeenCalledTimes(1);
    expect(toast()?.textContent).toContain("Fetched 1 repository");
    await act(async () => vi.advanceTimersByTime(TOAST_DISMISS_MS));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onFinished).toHaveBeenCalledTimes(1);
  });

  it("keeps a finish with failures in the toast until it is dismissed", async () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    await render({ initial: "toast", onClose });
    const failed = cleanSummary();
    failed.counts.repos = { ...failed.counts.repos, success: 0, failed: 1 };
    failed.results = [{ ...failed.results[0]!, outcome: "failed" }];
    await act(async () => {
      finish(failed);
    });
    expect(toast()?.textContent).toContain("1 failed");
    await act(async () => vi.advanceTimersByTime(TOAST_DISMISS_MS * 3));
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => byName("Dismiss").click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("draws the countdown on a clean finish, and none on a failure", async () => {
    vi.useFakeTimers();
    await render({ initial: "toast", onClose: vi.fn() });
    const rail = () => toast()?.querySelector(".bulk-sync-toast__rail") ?? null;
    expect(rail()).toBeNull(); // live: nothing is counting down yet
    await act(async () => {
      finish(cleanSummary());
    });
    expect(rail()?.getAttribute("style")).toContain(`${TOAST_DISMISS_MS}ms`);

    await act(async () => root.unmount());
    root = createRoot(container);
    await render({ initial: "toast", onClose: vi.fn() });
    const failed = cleanSummary();
    failed.counts.repos = { ...failed.counts.repos, success: 0, failed: 1 };
    failed.results = [{ ...failed.results[0]!, outcome: "failed" }];
    await act(async () => {
      finish(failed);
    });
    expect(rail()).toBeNull();
  });

  it("holds the countdown under the pointer and resumes from what was left", async () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    await render({ initial: "toast", onClose });
    await act(async () => {
      finish(cleanSummary());
    });
    await act(async () => vi.advanceTimersByTime(4_000));
    const card = toast()!;
    await act(async () => {
      card.dispatchEvent(new Event("pointerover", { bubbles: true }));
    });
    expect(card.querySelector(".bulk-sync-toast__rail")?.getAttribute("data-paused")).toBe("true");
    await act(async () => vi.advanceTimersByTime(30_000));
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => {
      card.dispatchEvent(new Event("pointerout", { bubbles: true }));
    });
    // The 2s the rail still showed, not a fresh 6s.
    await act(async () => vi.advanceTimersByTime(1_999));
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(1));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("names each finished outcome in the bar's words", async () => {
    vi.useFakeTimers();
    await render({ initial: "toast", onClose: vi.fn() });
    const partial = cleanSummary();
    partial.counts.repos = { ...partial.counts.repos, success: 0, partial: 1 };
    partial.results = [{ ...partial.results[0]!, outcome: "partial" }];
    await act(async () => {
      finish(partial);
    });
    const counts = toast()?.querySelector(".bulk-sync-toast__counts");
    expect(counts?.querySelector(".is-partial")?.textContent).toBe("1 partial");
    expect(toast()?.textContent).not.toContain("click for details");
  });

  it("draws nothing for a timed run nobody has opened, while still running it", async () => {
    await render({ initial: "hidden", onClose: vi.fn() });
    expect(dialog()).toBeNull();
    expect(toast()).toBeNull();
    expect(dispatch).toHaveBeenCalledWith(
      "remote:bulkSync",
      expect.anything()
    );
  });
});

describe("livePathLine", () => {
  const a = { id: "a", path: "/repos/atlas-api" };
  const b = { id: "b", path: "/repos/billing-core" };

  it("names the repository that started last, and counts the others", () => {
    expect(livePathLine([a, b], "b", null, "darwin")).toBe(
      "/repos/billing-core · +1 more"
    );
    expect(livePathLine([a], "b", null, "darwin")).toBe("/repos/atlas-api");
  });

  it("keeps the last line between repositories instead of going blank", () => {
    expect(livePathLine([], null, "/repos/atlas-api", "darwin")).toBe(
      "/repos/atlas-api"
    );
  });
});

describe("the status card's path line", () => {
  it("stays on screen as repositories start and finish (no layout shift)", async () => {
    let progress: ((event: unknown) => void) | undefined;
    subscribe.mockImplementation((_channel: string, handler: (e: unknown) => void) => {
      progress = handler;
      return vi.fn();
    });
    const two: Repo[] = [
      repos[0]!,
      { ...repos[0]!, id: "repo-b", name: "billing-core", path: "/repos/billing-core" }
    ];
    await act(async () => {
      root.render(
        <BulkSyncDialog
          profileId="profile-1"
          repos={two}
          mode="fetch"
          platform="darwin"
          onClose={vi.fn()}
        />
      );
    });
    const operationId = dispatch.mock.calls[0]?.[1].operationId as string;
    const line = (): string | null | undefined =>
      document.querySelector(".bulk-sync__status-copy > span")?.textContent;
    const event = (phase: string, repoId: string, extra: object = {}) =>
      act(async () => {
        progress?.({
          operationId,
          mode: "fetch",
          phase,
          totalRepos: 2,
          completedRepos: 0,
          repoId,
          ...extra
        });
      });

    // Before anything starts: the line is there, holding its height.
    expect(line()).toBe("\u00a0");
    await event("repo_started", "repo-a");
    expect(line()).toBe("/repos/atlas-api");
    await event("repo_started", "repo-b");
    expect(line()).toBe("/repos/billing-core · +1 more");
    await event("repo_completed", "repo-b", {
      result: {
        repoId: "repo-b",
        name: "billing-core",
        path: "/repos/billing-core",
        outcome: "success",
        remotes: [],
        worktrees: []
      }
    });
    expect(line()).toBe("/repos/atlas-api");
  });
});
