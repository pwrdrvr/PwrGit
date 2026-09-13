// @vitest-environment jsdom

import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RECLAIM_DEFAULT_EXCLUDES,
  type PruneCandidate,
  type ReclaimPlan,
  type ReclaimSummary
} from "@pwrgit/shared";

const { dispatch, subscribe } = vi.hoisted(() => ({
  dispatch: vi.fn(),
  subscribe: vi.fn()
}));
vi.mock("../../lib/pwrgit", () => ({ dispatch, subscribe }));

const { confirmDialog } = vi.hoisted(() => ({ confirmDialog: vi.fn() }));
vi.mock("../shell/dialogs", () => ({ confirmDialog }));

import { ReclaimDiskPanel } from "./ReclaimDiskPanel";

const candidates: PruneCandidate[] = [
  {
    worktreeId: "w1",
    repoId: "r1",
    repoName: "alpha",
    branch: "feat/a",
    path: "/w/a",
    reason: { kind: "merged_into_default", defaultBranch: "main" },
    sizeBytes: 4096
  },
  {
    worktreeId: "w2",
    repoId: "r2",
    repoName: "beta",
    branch: "feat/b",
    path: "/w/b",
    reason: { kind: "merged_pr", prNumber: 9 },
    sizeBytes: 2048
  }
];

function plan(worktreeId: string, excludes: string[]): ReclaimPlan {
  const spared = excludes.length > 0;
  const entries = [
    { path: "node_modules/", isDirectory: true, sizeBytes: 4_000_000 },
    { path: "dist/", isDirectory: true, sizeBytes: 40_000 },
    ...(spared ? [] : [{ path: ".env", isDirectory: false, sizeBytes: 30 }])
  ];
  return {
    worktreeId,
    repoName: worktreeId === "w1" ? "alpha" : "beta",
    branch: worktreeId === "w1" ? "feat/a" : "feat/b",
    path: `/w/${worktreeId}`,
    excludes,
    entries,
    totalBytes: entries.reduce((at, entry) => at + entry.sizeBytes, 0),
    pathCount: entries.length,
    truncated: false
  };
}

const summary: ReclaimSummary = {
  operationId: "reclaim-1",
  cancelled: false,
  startedAt: "2026-09-13T00:00:00.000Z",
  finishedAt: "2026-09-13T00:00:02.000Z",
  counts: {
    worktrees: {
      reclaimed: 2,
      nothing_to_reclaim: 0,
      skipped: 0,
      failed: 0,
      cancelled: 0
    },
    freedBytes: 8_080_060
  },
  results: []
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  subscribe.mockImplementation(() => vi.fn());
  confirmDialog.mockResolvedValue(true);
  dispatch.mockImplementation((command: string, request: unknown) => {
    if (command === "prune:reclaimPreview") {
      const { worktreeId, excludes } = request as {
        worktreeId: string;
        excludes: string[];
      };
      return Promise.resolve({ ok: true, value: plan(worktreeId, excludes) });
    }
    if (command === "prune:reclaim") {
      return Promise.resolve({ ok: true, value: summary });
    }
    if (command === "prune:cancelReclaim") {
      return Promise.resolve({ ok: true, value: { cancelled: true } });
    }
    return Promise.resolve({ ok: true, value: null });
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  dispatch.mockReset();
  subscribe.mockReset();
  confirmDialog.mockReset();
});

async function render(
  onFinished: (value: ReclaimSummary) => void = vi.fn()
): Promise<void> {
  await act(async () => {
    root.render(
      <StrictMode>
        <ReclaimDiskPanel
          candidates={candidates}
          onBack={vi.fn()}
          onFinished={onFinished}
        />
      </StrictMode>
    );
  });
}

type PreviewRequest = {
  worktreeId: string;
  excludes: string[];
  operationId: string;
};

const rawPreviewRequests = (): PreviewRequest[] =>
  dispatch.mock.calls
    .filter(([command]) => command === "prune:reclaimPreview")
    .map(([, request]) => request as PreviewRequest);

/** Without the cancellation id, which every request carries and no assertion
 *  about *which patterns git was asked for* should have to spell out. */
const previewRequests = (): { worktreeId: string; excludes: string[] }[] =>
  rawPreviewRequests().map(({ worktreeId, excludes }) => ({
    worktreeId,
    excludes
  }));

const field = (): HTMLTextAreaElement => {
  const found = container.querySelector<HTMLTextAreaElement>(
    ".prune__excludes-field"
  );
  if (found === null) throw new Error("no exclude field");
  return found;
};

const buttonNamed = (label: string): HTMLButtonElement => {
  const found = Array.from(
    container.querySelectorAll<HTMLButtonElement>("button")
  ).find((button) => button.textContent?.includes(label));
  if (found === undefined) throw new Error(`no button matching "${label}"`);
  return found;
};

/** React tracks the DOM value itself; set through the descriptor or the
 *  change event is swallowed as a no-op. */
function typeInto(element: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value"
  )?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("ReclaimDiskPanel", () => {
  it("previews every selected worktree with the default spare list", async () => {
    await render();
    expect(previewRequests()).toEqual([
      { worktreeId: "w1", excludes: [...RECLAIM_DEFAULT_EXCLUDES] },
      { worktreeId: "w2", excludes: [...RECLAIM_DEFAULT_EXCLUDES] }
    ]);
    expect(container.querySelectorAll(".prune__plan")).toHaveLength(2);
    // The total is the whole point of the panel; show it up front.
    expect(container.querySelector(".prune__count")?.textContent).toBe("7.7 MB");
  });

  it("lists the paths biggest first, as git reported them", async () => {
    await render();
    const paths = Array.from(
      container.querySelectorAll(".prune__plan")[0]?.querySelectorAll(
        ".prune__paths li > span"
      ) ?? []
    ).map((node) => node.textContent);
    expect(paths).toEqual(["node_modules/", "dist/"]);
  });

  it("re-previews with the user's patterns instead of filtering locally", async () => {
    // Filtering the rows we already have would show one answer and delete
    // another: only git can say what `clean -Xd` would remove.
    await render();
    await act(async () => typeInto(field(), "dist/"));
    await act(async () => buttonNamed("Update preview").click());
    expect(previewRequests().slice(-2)).toEqual([
      { worktreeId: "w1", excludes: ["dist/"] },
      { worktreeId: "w2", excludes: ["dist/"] }
    ]);
  });

  it("leaves Update preview inert until the patterns actually change", async () => {
    await render();
    expect(buttonNamed("Update preview").disabled).toBe(true);
    await act(async () => typeInto(field(), "dist/"));
    expect(buttonNamed("Update preview").disabled).toBe(false);
  });

  it("warns when the user clears every guard", async () => {
    await render();
    expect(container.querySelector(".prune__excludes-foot")?.textContent).toContain(
      "patterns spared"
    );
    await act(async () => typeInto(field(), ""));
    // The dangerous fact stays visible even though the edit is also unapplied:
    // "not applied yet" must never displace "nothing spared".
    const foot = container.querySelector(".prune__excludes-foot")?.textContent;
    expect(foot).toContain("Nothing spared");
    expect(foot).toContain("Not applied yet");
  });

  it("refuses to delete while the spare list has unapplied edits", async () => {
    // `reclaim()` sends the applied list, so deleting here would drop a
    // pattern the user just typed to protect something.
    await render();
    expect(buttonNamed("Delete ignored files").disabled).toBe(false);
    await act(async () => typeInto(field(), "dist/"));
    expect(buttonNamed("Delete ignored files").disabled).toBe(true);
    await act(async () => buttonNamed("Update preview").click());
    expect(buttonNamed("Delete ignored files").disabled).toBe(false);
  });

  it("runs every preview in a run under one cancellable id", async () => {
    // One id per run, not per worktree: a cancel has to reach whichever
    // worktree the walk is currently inside.
    await render();
    const ids = rawPreviewRequests().map((request) => request.operationId);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toMatch(/\S/);
    expect(new Set(ids).size).toBe(1);

    await act(async () => typeInto(field(), "dist/"));
    await act(async () => buttonNamed("Update preview").click());
    // A new run gets a new id, so cancelling one never stops the other.
    expect(rawPreviewRequests().at(-1)?.operationId).not.toBe(ids[0]);
  });

  it("cancels the walk main is still doing when the panel goes away", async () => {
    // A preview holds the worktree lock and walks every ignored directory it
    // finds. Leaving must stop that work, not just stop reading its answer.
    const held: { release: (() => void) | null } = { release: null };
    dispatch.mockImplementation((command: string, request: unknown) => {
      if (command === "prune:reclaimPreview") {
        const { worktreeId, excludes } = request as {
          worktreeId: string;
          excludes: string[];
        };
        if (worktreeId === "w2") {
          return new Promise((resolve) => {
            held.release = () =>
              resolve({ ok: true, value: plan(worktreeId, excludes) });
          });
        }
        return Promise.resolve({ ok: true, value: plan(worktreeId, excludes) });
      }
      return Promise.resolve({ ok: true, value: null });
    });

    await render();
    const inFlight = rawPreviewRequests().at(-1)?.operationId;
    expect(inFlight).toMatch(/\S/);
    await act(async () => root.unmount());

    const cancels = dispatch.mock.calls
      .filter(([command]) => command === "prune:cancelReclaim")
      .map(([, request]) => (request as { operationId: string }).operationId);
    expect(cancels).toContain(inFlight);
    held.release?.();
  });

  it("confirms with the byte total before deleting anything", async () => {
    await render();
    confirmDialog.mockResolvedValueOnce(false);
    await act(async () => buttonNamed("Delete ignored files").click());
    expect(
      dispatch.mock.calls.filter(([command]) => command === "prune:reclaim")
    ).toHaveLength(0);
    expect(confirmDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Delete ignored files in 2 worktrees?",
        confirmLabel: "Delete, free 7.7 MB",
        danger: true
      })
    );
    expect(confirmDialog.mock.calls[0]?.[0].message).toContain(
      "cannot be undone"
    );
  });

  it("deletes with the patterns the preview was taken with", async () => {
    const onFinished = vi.fn();
    await render(onFinished);
    await act(async () => typeInto(field(), "dist/"));
    await act(async () => buttonNamed("Update preview").click());
    await act(async () => buttonNamed("Delete ignored files").click());
    const reclaim = dispatch.mock.calls.find(
      ([command]) => command === "prune:reclaim"
    );
    expect(reclaim?.[1]).toMatchObject({
      worktreeIds: ["w1", "w2"],
      excludes: ["dist/"]
    });
    expect(onFinished).toHaveBeenCalledExactlyOnceWith(summary);
    expect(container.querySelector(".prune__summary")?.textContent).toContain(
      "2 reclaimed"
    );
  });

  it("says so when git finds nothing ignored, and refuses to run", async () => {
    dispatch.mockImplementation((command: string, request: unknown) => {
      if (command === "prune:reclaimPreview") {
        const { worktreeId, excludes } = request as {
          worktreeId: string;
          excludes: string[];
        };
        return Promise.resolve({
          ok: true,
          value: {
            ...plan(worktreeId, excludes),
            entries: [],
            pathCount: 0,
            totalBytes: 0
          }
        });
      }
      return Promise.resolve({ ok: true, value: null });
    });
    await render();
    expect(buttonNamed("Delete ignored files").disabled).toBe(true);
  });

  it("surfaces a preview failure without losing the worktrees that worked", async () => {
    dispatch.mockImplementation((command: string, request: unknown) => {
      if (command !== "prune:reclaimPreview") {
        return Promise.resolve({ ok: true, value: null });
      }
      const { worktreeId, excludes } = request as {
        worktreeId: string;
        excludes: string[];
      };
      if (worktreeId === "w1") {
        return Promise.resolve({
          ok: false,
          error: { kind: "git", code: "boom", message: "Git refused." }
        });
      }
      return Promise.resolve({ ok: true, value: plan(worktreeId, excludes) });
    });
    await render();
    expect(container.querySelector(".modal__error")?.textContent).toBe(
      "Git refused."
    );
    expect(container.querySelectorAll(".prune__plan")).toHaveLength(1);
  });
});
