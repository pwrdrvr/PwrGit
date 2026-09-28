// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MaintenanceProgress,
  MaintenanceRepo,
  MaintenanceRepoResult,
  MaintenanceSummary
} from "@pwrgit/shared";
const { dispatch, subscribe } = vi.hoisted(() => ({
  dispatch: vi.fn(),
  subscribe: vi.fn()
}));
vi.mock("../../lib/pwrgit", () => ({ dispatch, subscribe }));
import { MaintenanceDialog } from "./MaintenanceDialog";

const repo: MaintenanceRepo = {
  id: "repo",
  name: "example",
  path: "/fixtures/example",
  profileId: "one",
  profileName: "One"
};
const candidate = {
  repoId: "repo",
  branch: "finished",
  expectedHead: "abc123",
  upstream: "refs/remotes/origin/finished",
  evidence: "ancestry" as const
};
const squashed = {
  repoId: "repo",
  branch: "fix/tooltip",
  expectedHead: "f".repeat(40),
  upstream: "refs/remotes/origin/fix/tooltip",
  evidence: "pr" as const,
  pr: { number: 412, url: "https://example.test/pull/412" }
};
const kept = [
  { branch: "spike/a", reason: "pr_closed" as const, detail: "#377 closed without merging" },
  { branch: "spike/b", reason: "pr_closed" as const, detail: "#378 closed without merging" },
  { branch: "wip", reason: "recent" as const, detail: "Touched yesterday, inside the 7-day guard" }
];
/** What `settings:read` answers on mount — only the two fields the dialog
 *  reads matter. */
const settings = (prProof: boolean, keepDays: number | null) => ({
  ok: true,
  value: { general: { branchCleanupPrProof: prProof, branchCleanupKeepDays: keepDays } }
});
const runCalls = () =>
  dispatch.mock.calls.filter(([name]) => name === "maintenance:run");
function summary(results: MaintenanceRepoResult[]): MaintenanceSummary {
  return {
    operationId: "run",
    startedAt: "2026-09-26T12:00:00Z",
    finishedAt: "2026-09-26T12:00:02Z",
    cancelled: false,
    results
  };
}
let root: Root;
let container: HTMLDivElement;
let onClose: ReturnType<typeof vi.fn<() => void>>;
let listener: ((event: MaintenanceProgress) => void) | undefined;
function button(text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (node) => node.textContent === text
  );
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}
async function click(text: string): Promise<void> {
  await act(async () => button(text).click());
}
beforeEach(async () => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  onClose = vi.fn();
  subscribe.mockImplementation(
    (_name: string, handler: (event: MaintenanceProgress) => void) => {
      listener = handler;
      return vi.fn();
    }
  );
  dispatch.mockImplementation(async (name: string) =>
    name === "settings:read" ? settings(true, 7) : { ok: true, value: null }
  );
  await act(async () =>
    root.render(
      <StrictMode>
        <MaintenanceDialog profileId="one" platform="linux" onClose={onClose} />
      </StrictMode>
    )
  );
  // The mount's `settings:read` is not what these tests are about; the call
  // log starts at the reader's first action.
  dispatch.mockClear();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.resetAllMocks();
});

describe("maintenance dialog", () => {
  it("explains the choices and waits for explicit start even in StrictMode", async () => {
    expect(runCalls()).toEqual([]);
    expect(container.textContent).toContain("Standard (recommended)");
    expect(container.textContent).toContain("no guaranteed size reduction");
    dispatch.mockResolvedValue({ ok: true, value: summary([]) });
    await click("Run garbage collection");
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(
      "maintenance:run",
      expect.objectContaining({
        profileId: "one",
        allProfiles: false,
        // Collection counts finished branches with the saved rules, so its
        // receipt can offer the review.
        action: {
          kind: "gc",
          mode: "standard",
          branchOptions: { prProof: true, keepDays: 7 }
        }
      })
    );
    expect(container.textContent).toContain("Finished");
  });

  it("filters progress by operation and profile, preserves the dialog during cancellation", async () => {
    let finish!: (value: unknown) => void;
    dispatch.mockImplementation((name: string) =>
      name === "maintenance:run"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve({ ok: true, value: { cancelled: true } })
    );
    await click("Run garbage collection");
    const request = dispatch.mock.calls[0]![1];
    await act(async () => {
      listener?.({
        operationId: "unrelated",
        profileId: "one",
        phase: "starting",
        repos: [{ ...repo, name: "wrong" }]
      });
      listener?.({
        operationId: request.operationId,
        profileId: "two",
        phase: "starting",
        repos: [{ ...repo, name: "wrong profile" }]
      });
    });
    expect(container.textContent).not.toContain("wrong");
    await act(async () => {
      listener?.({
        operationId: request.operationId,
        profileId: "one",
        phase: "starting",
        repos: [repo]
      });
      listener?.({
        operationId: request.operationId,
        profileId: "one",
        phase: "repo_started",
        repo
      });
    });
    expect(container.textContent).toContain("Collecting example");
    await act(async () =>
      listener?.({
        operationId: request.operationId,
        profileId: "one",
        phase: "repo_progress",
        repo,
        detail: "Repacking objects…"
      })
    );
    expect(container.textContent).toContain("Repacking objects…");
    await act(async () =>
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      )
    );
    expect(onClose).not.toHaveBeenCalled();
    await click("Cancel");
    expect(dispatch).toHaveBeenLastCalledWith("maintenance:cancel", {
      operationId: request.operationId
    });
    expect(container.textContent).toContain(
      "Stopping after active repository operations"
    );
    await act(async () =>
      finish({
        ok: true,
        value: {
          ...summary([
            {
              repo,
              outcome: "success",
              message: "Collected",
              beforeBytes: 2048,
              afterBytes: 1024
            }
          ]),
          cancelled: true
        }
      })
    );
    expect(container.textContent).toContain("2.0 KiB → 1.0 KiB");
    await click("Close");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps other repositories running when one parallel worker completes", async () => {
    let finish!: (value: unknown) => void;
    dispatch.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    await click("Run garbage collection");
    const { operationId } = dispatch.mock.calls[0]![1];
    const second = { ...repo, id: "second", name: "second" };
    const queued = { ...repo, id: "queued", name: "queued" };
    const emit = (
      event: Omit<MaintenanceProgress, "operationId" | "profileId">
    ) => listener?.({ ...event, operationId, profileId: "one" });
    await act(async () => {
      emit({ phase: "starting", repos: [repo, second, queued] });
      emit({ phase: "repo_started", repo });
      emit({ phase: "repo_started", repo: second });
    });
    expect(container.textContent).toContain("Collecting 2 repositories");
    expect(container.textContent).toContain("2 in flight · 1 queued");
    expect(container.querySelectorAll("article.is-running")).toHaveLength(2);
    await act(async () =>
      emit({
        phase: "repo_completed",
        repo: second,
        result: { repo: second, outcome: "success", message: "Collected" }
      })
    );
    expect(container.textContent).toContain("Collecting example");
    expect(container.textContent).toContain("1 in flight · 1 queued");
    expect(container.querySelectorAll("article.is-running")).toHaveLength(1);
    await act(async () => finish({ ok: true, value: summary([]) }));
  });

  it("requires review and branch selection before sending a deletion", async () => {
    dispatch.mockResolvedValue({
      ok: true,
      value: summary([
        {
          repo,
          outcome: "success",
          message: "1 eligible",
          candidates: [candidate]
        }
      ])
    });
    await click("Local branches");
    expect(container.textContent).toContain("Never offered");
    expect(runCalls()).toEqual([]);
    await click("Review local branches");
    // Finished is checked by default: every row carries its proof.
    expect(container.textContent).toContain("Already in HEAD");
    const checkbox = container.querySelector<HTMLInputElement>(
      ".maintenance__branch input"
    )!;
    expect(checkbox.checked).toBe(true);
    await act(async () => checkbox.click());
    expect(button("Delete 0 selected local branches").disabled).toBe(true);
    await act(async () => checkbox.click());
    dispatch.mockResolvedValue({
      ok: true,
      value: summary([
        {
          repo,
          outcome: "success",
          message: "Deleted",
          branches: [
            {
              branch: "finished",
              head: "abc123",
              deleted: true,
              message: "Deleted local branch."
            }
          ]
        }
      ])
    });
    await click("Delete 1 selected local branch");
    expect(dispatch).toHaveBeenLastCalledWith(
      "maintenance:run",
      expect.objectContaining({
        action: {
          kind: "delete-branches",
          branches: [candidate],
          options: { prProof: true, keepDays: 7 }
        }
      })
    );
    expect(container.querySelector(".maintenance__branch")).toBeNull();
    expect(container.textContent).toContain("Deleted local branch.");
    // The receipt is the undo: a deleted branch's reflog goes with it.
    dispatch.mockResolvedValue({ ok: true, value: null });
    await click("Restore");
    expect(dispatch).toHaveBeenLastCalledWith("maintenance:restoreBranch", {
      repoId: "repo",
      branch: "finished",
      head: "abc123"
    });
    expect(button("Restored").disabled).toBe(true);
    // The restored branch is offered and deleted again: the new receipt is
    // its own undo, not the last one's "Restored".
    dispatch.mockResolvedValue({
      ok: true,
      value: summary([
        { repo, outcome: "success", message: "Reviewed", candidates: [candidate] }
      ])
    });
    await click("Review again");
    dispatch.mockResolvedValue({
      ok: true,
      value: summary([
        {
          repo,
          outcome: "success",
          message: "Deleted",
          branches: [
            {
              branch: "finished",
              head: "abc123",
              deleted: true,
              message: "Deleted local branch."
            }
          ]
        }
      ])
    });
    await click("Delete 1 selected local branch");
    expect(button("Restore").disabled).toBe(false);
  });

  it("shows each finished branch's evidence and counts kept ones by reason", async () => {
    dispatch.mockResolvedValue({
      ok: true,
      value: summary([
        {
          repo,
          outcome: "success",
          message: "1 finished",
          candidates: [squashed],
          kept
        }
      ])
    });
    await click("Local branches");
    await click("Review local branches");
    expect(container.textContent).toContain("#412 merged · tip is its head");
    const reasons = [
      ...container.querySelectorAll(".maintenance__kept-reasons span")
    ].map((node) => node.textContent);
    expect(reasons).toEqual([
      "2 closed without merging",
      "1 touched in the last 7 days"
    ]);
    expect(container.textContent).not.toContain("#377 closed without merging");
    await click("Show");
    expect(container.textContent).toContain("#377 closed without merging");
  });

  it("remembers the rules and drops a review they no longer describe", async () => {
    dispatch.mockImplementation(async (name: string) =>
      name === "maintenance:run"
        ? {
            ok: true,
            value: summary([
              { repo, outcome: "success", message: "1", candidates: [candidate] }
            ])
          }
        : { ok: true, value: null }
    );
    await click("Local branches");
    await click("Review local branches");
    const select = container.querySelector<HTMLSelectElement>(
      "select[aria-label='Age guard']"
    )!;
    expect(select.value).toBe("7");
    await act(async () => {
      select.value = "30";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(dispatch).toHaveBeenCalledWith("settings:update", {
      patch: {
        general: { branchCleanupPrProof: true, branchCleanupKeepDays: 30 }
      }
    });
    expect(container.querySelector(".maintenance__branch")).toBeNull();
    await click("Review local branches");
    expect(runCalls().at(-1)![1]).toMatchObject({
      action: { kind: "scan-branches", options: { prProof: true, keepDays: 30 } }
    });
  });

  it("offers the branch review from a collection's receipt without scanning again", async () => {
    dispatch.mockResolvedValue({
      ok: true,
      value: summary([
        {
          repo,
          outcome: "success",
          message: "Garbage collection completed.",
          beforeBytes: 2048,
          afterBytes: 1024,
          candidates: [candidate, squashed],
          kept
        }
      ])
    });
    await click("Run garbage collection");
    expect(container.textContent).toContain(
      "2 finished local branches across 1 repository"
    );
    await click("Review…");
    expect(runCalls()).toHaveLength(1);
    expect(
      button("Local branches").getAttribute("aria-pressed")
    ).toBe("true");
    expect(button("Delete 2 selected local branches").disabled).toBe(false);
  });
});

describe("maintenance dialog opened from a repository's branch list", () => {
  it("reviews that repository on open, with the saved rules", async () => {
    await act(async () => root.unmount());
    root = createRoot(container);
    dispatch.mockImplementation(async (name: string) =>
      name === "settings:read"
        ? settings(false, null)
        : { ok: true, value: summary([]) }
    );
    await act(async () =>
      root.render(
        <MaintenanceDialog
          profileId="one"
          platform="linux"
          onClose={onClose}
          repoScope={{ id: "repo", name: "example" }}
          initialTab="branches"
          autoReview
        />
      )
    );
    expect(runCalls()).toHaveLength(1);
    expect(runCalls()[0]![1]).toMatchObject({
      repoIds: ["repo"],
      action: {
        kind: "scan-branches",
        options: { prProof: false, keepDays: null }
      }
    });
    expect(container.textContent).toContain("Only example");
    expect(container.textContent).not.toContain("Include all profiles");
  });

  it("invalidates a branch review when the profile scope changes", async () => {
    dispatch.mockResolvedValue({
      ok: true,
      value: summary([
        {
          repo,
          outcome: "success",
          message: "1 eligible",
          candidates: [candidate]
        }
      ])
    });
    await click("Local branches");
    await click("Review local branches");
    await act(async () =>
      container
        .querySelector<HTMLInputElement>(".maintenance__scope input")!
        .click()
    );
    expect(container.querySelector(".maintenance__branch")).toBeNull();
    await click("Review local branches");
    expect(dispatch).toHaveBeenLastCalledWith(
      "maintenance:run",
      expect.objectContaining({ allProfiles: true })
    );
  });
});
