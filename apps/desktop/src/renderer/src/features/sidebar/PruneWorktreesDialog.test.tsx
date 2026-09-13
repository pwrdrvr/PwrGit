// @vitest-environment jsdom

import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PruneCandidate,
  PruneScanProgress,
  PruneScanSummary
} from "@pwrgit/shared";

const { dispatch, subscribe } = vi.hoisted(() => ({
  dispatch: vi.fn(),
  subscribe: vi.fn()
}));
vi.mock("../../lib/pwrgit", () => ({ dispatch, subscribe }));

const { confirmDialog } = vi.hoisted(() => ({ confirmDialog: vi.fn() }));
vi.mock("../shell/dialogs", () => ({ confirmDialog }));

// Only `currentPlatform` is stubbed, and only because it reads the preload
// bridge, which jsdom has no reason to carry. `isMacPlatform` and the rest of
// the module stay real, so the note this produces is the one the app produces.
vi.mock("../../lib/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/platform")>()),
  currentPlatform: () => "darwin"
}));


import { PruneWorktreesDialog } from "./PruneWorktreesDialog";

function candidate(
  partial: Partial<PruneCandidate> & { worktreeId: string }
): PruneCandidate {
  return {
    repoId: "r1",
    repoName: "alpha",
    branch: partial.worktreeId,
    path: `/w/${partial.worktreeId}`,
    reason: { kind: "merged_into_default", defaultBranch: "main" },
    sizeBytes: 1024,
    ...partial
  };
}

function summary(candidates: PruneCandidate[]): PruneScanSummary {
  return {
    operationId: "sweep-1",
    cancelled: false,
    startedAt: "2026-09-13T00:00:00.000Z",
    finishedAt: "2026-09-13T00:00:04.000Z",
    counts: {
      repos: { scanned: 3, cached: 1, skipped: 0, failed: 0, cancelled: 0 },
      worktreesConsidered: 9,
      candidates: candidates.length,
      sizeBytes: candidates.reduce((at, c) => at + (c.sizeBytes ?? 0), 0)
    },
    results: [
      {
        repoId: "r1",
        name: "alpha",
        path: "/repos/alpha",
        outcome: "scanned",
        computed: 3,
        candidates
      }
    ]
  };
}

let container: HTMLDivElement;
let root: Root;
const handlers = new Map<string, (event: unknown) => void>();

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type ScanRequest = { operationId: string; profileId: string; force: boolean };

const scanRequests = (): ScanRequest[] =>
  dispatch.mock.calls
    .filter(([command]) => command === "prune:scan")
    .map(([, request]) => request as ScanRequest);

const currentOperationId = (): string =>
  scanRequests().at(-1)?.operationId ?? "";

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  handlers.clear();
  subscribe.mockImplementation(
    (channel: string, handler: (event: unknown) => void) => {
      handlers.set(channel, handler);
      return vi.fn();
    }
  );
  confirmDialog.mockResolvedValue(true);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  dispatch.mockReset();
  subscribe.mockReset();
  confirmDialog.mockReset();
});

async function render(
  onRemove: (ids: string[]) => Promise<void> = async () => undefined
): Promise<void> {
  await act(async () => {
    root.render(
      <StrictMode>
        <PruneWorktreesDialog
          profileId="profile-1"
          onRemove={onRemove}
          onClose={vi.fn()}
        />
      </StrictMode>
    );
  });
}

const rows = (): HTMLElement[] =>
  Array.from(container.querySelectorAll<HTMLElement>(".prune__row"));

const dangerButton = (): HTMLButtonElement | null =>
  container.querySelector<HTMLButtonElement>(".modal__create--danger");

const buttonNamed = (label: string): HTMLButtonElement => {
  const found = Array.from(
    container.querySelectorAll<HTMLButtonElement>("button")
  ).find((button) => button.textContent?.includes(label));
  if (found === undefined) throw new Error(`no button matching "${label}"`);
  return found;
};

describe("PruneWorktreesDialog", () => {
  it("starts exactly one sweep through the app's StrictMode mount cycle", async () => {
    dispatch.mockReturnValue(deferred<unknown>().promise);
    await render();
    expect(scanRequests()).toHaveLength(1);
  });

  it("shows sweep progress, then the candidates it found", async () => {
    const scan = deferred<{ ok: true; value: PruneScanSummary }>();
    dispatch.mockImplementation((command: string) =>
      command === "prune:scan" ? scan.promise : Promise.resolve({ ok: true, value: null })
    );
    await render();
    expect(container.querySelector(".prune__activity")).not.toBeNull();

    const progress = handlers.get("prune:scanProgress");
    await act(async () => {
      progress?.({
        operationId: currentOperationId(),
        phase: "repo_started",
        totalRepos: 4,
        completedRepos: 1,
        repoId: "r1",
        repoName: "alpha"
      } satisfies PruneScanProgress);
    });
    expect(container.querySelector(".prune__count")?.textContent).toBe("1 / 4");
    expect(container.querySelector(".prune__activity")?.textContent).toContain(
      "Reading alpha"
    );

    await act(async () => {
      progress?.({
        operationId: currentOperationId(),
        phase: "sizing",
        totalRepos: 4,
        completedRepos: 4,
        sizedCandidates: 1,
        totalCandidates: 2
      } satisfies PruneScanProgress);
    });
    expect(container.querySelector(".prune__activity")?.textContent).toContain(
      "1 of 2 candidates measured"
    );

    await act(async () => {
      scan.resolve({
        ok: true,
        value: summary([
          candidate({ worktreeId: "a", sizeBytes: 10 }),
          candidate({ worktreeId: "b", sizeBytes: 5_000_000 })
        ])
      });
    });
    expect(container.querySelector(".prune__activity")).toBeNull();
    // Biggest first — the pruner exists to recover disk.
    expect(rows()).toHaveLength(2);
    expect(rows()[0]?.textContent).toContain("b");
    expect(container.querySelector(".prune__summary")?.textContent).toContain(
      "9 worktrees considered"
    );
  });

  it("selects nothing by default, and disables both actions until it has to", async () => {
    dispatch.mockResolvedValue({
      ok: true,
      value: summary([candidate({ worktreeId: "a" })])
    });
    await render();
    expect(
      container.querySelectorAll<HTMLInputElement>(".prune__row input:checked")
    ).toHaveLength(0);
    expect(dangerButton()?.disabled).toBe(true);
    expect(buttonNamed("Reclaim disk space").disabled).toBe(true);

    const checkbox = rows()[0]?.querySelector<HTMLInputElement>("input");
    await act(async () => checkbox?.click());
    expect(dangerButton()?.disabled).toBe(false);
    expect(buttonNamed("Reclaim disk space").disabled).toBe(false);
    expect(container.querySelector(".prune__select")?.textContent).toContain(
      "1 selected · 1 KB"
    );
  });

  it("selects and clears every row from one control", async () => {
    dispatch.mockResolvedValue({
      ok: true,
      value: summary([
        candidate({ worktreeId: "a" }),
        candidate({ worktreeId: "b" })
      ])
    });
    await render();
    const all = container.querySelector<HTMLInputElement>(
      ".prune__select input"
    );
    await act(async () => all?.click());
    expect(
      container.querySelectorAll(".prune__row input:checked")
    ).toHaveLength(2);
    await act(async () => all?.click());
    expect(
      container.querySelectorAll(".prune__row input:checked")
    ).toHaveLength(0);
  });

  it("confirms with the count before removing, and removes nothing on cancel", async () => {
    dispatch.mockResolvedValue({
      ok: true,
      value: summary([candidate({ worktreeId: "a" })])
    });
    const onRemove = vi.fn(async () => undefined);
    await render(onRemove);
    await act(async () => rows()[0]?.querySelector("input")?.click());

    confirmDialog.mockResolvedValueOnce(false);
    await act(async () => dangerButton()?.click());
    expect(onRemove).not.toHaveBeenCalled();
    expect(confirmDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Remove 1 worktree?",
        confirmLabel: "Remove 1",
        danger: true
      })
    );

    confirmDialog.mockResolvedValueOnce(true);
    await act(async () => dangerButton()?.click());
    expect(onRemove).toHaveBeenCalledExactlyOnceWith(["a"]);
  });

  it("drops a row from the list as its removal lands", async () => {
    dispatch.mockResolvedValue({
      ok: true,
      value: summary([
        candidate({ worktreeId: "a" }),
        candidate({ worktreeId: "b" })
      ])
    });
    await render();
    expect(rows()).toHaveLength(2);
    await act(async () => {
      handlers.get("worktree:removed")?.({ worktreeId: "a" });
    });
    expect(rows()).toHaveLength(1);
    expect(rows()[0]?.textContent).toContain("b");
  });

  it("names each reason on its row", async () => {
    dispatch.mockResolvedValue({
      ok: true,
      value: summary([
        candidate({
          worktreeId: "pr",
          sizeBytes: 3000,
          reason: { kind: "merged_pr", prNumber: 41 }
        }),
        candidate({
          worktreeId: "orphan",
          sizeBytes: 2000,
          reason: { kind: "diverged", defaultBranch: "main" }
        }),
        candidate({ worktreeId: "merged", sizeBytes: 1000 })
      ])
    });
    await render();
    const reasons = Array.from(
      container.querySelectorAll(".prune__reason")
    ).map((node) => node.textContent);
    expect(reasons).toEqual([
      "merged PR #41",
      "no common ancestor with main",
      "merged into main"
    ]);
  });

  it("explains an empty result rather than looking broken", async () => {
    dispatch.mockResolvedValue({ ok: true, value: summary([]) });
    await render();
    expect(container.querySelector(".prune__empty")?.textContent).toContain(
      "Nothing is safe to remove"
    );
    expect(dangerButton()?.disabled).toBe(true);
  });

  it("surfaces a failed sweep and the repos it could not read", async () => {
    dispatch.mockResolvedValue({
      ok: false,
      error: { kind: "git", code: "boom", message: "Git went away." }
    });
    await render();
    expect(container.querySelector(".modal__error")?.textContent).toBe(
      "Git went away."
    );
  });

  it("asks main to cancel a running sweep", async () => {
    dispatch.mockImplementation((command: string) =>
      command === "prune:scan"
        ? deferred<unknown>().promise
        : Promise.resolve({ ok: true, value: { cancelled: true } })
    );
    await render();
    await act(async () => buttonNamed("Cancel").click());
    expect(dispatch).toHaveBeenCalledWith("prune:cancelScan", {
      operationId: currentOperationId()
    });
    expect(buttonNamed("Stopping…").disabled).toBe(true);
  });

  it("re-reads every repository when asked, rather than reusing the cache", async () => {
    dispatch.mockResolvedValue({
      ok: true,
      value: summary([candidate({ worktreeId: "a" })])
    });
    await render();
    expect(scanRequests()[0]).toMatchObject({ force: false });
    await act(async () => buttonNamed("Re-read all").click());
    expect(scanRequests()).toHaveLength(2);
    expect(scanRequests()[1]).toMatchObject({ force: true });
  });

  it("cancels the sweep it started when the dialog closes", async () => {
    dispatch.mockReturnValue(deferred<unknown>().promise);
    await render();
    const operationId = currentOperationId();
    await act(async () => root.unmount());
    expect(dispatch).toHaveBeenCalledWith("prune:cancelScan", { operationId });
    // Re-create so afterEach's unmount stays valid.
    root = createRoot(container);
  });
});
