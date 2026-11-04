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
vi.mock("../shell/dialogs", () => ({ confirmDialog: async () => true }));
vi.mock("../../lib/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/platform")>()),
  currentPlatform: () => "linux"
}));
import type { RemoveWorktreesOutcome } from "../../state/useRepoTree";
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
        <MaintenanceDialog initialTab="gc" onRemoveWorktrees={async () => ({ removed: [], keptDirty: [], failed: [] })} profileId="one" platform="linux" onClose={onClose} />
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
  it("hosts worktree review in one modal and blocks leaving while the sweep runs", async () => {
    let resolveScan!: (value: unknown) => void;
    const scan = new Promise((resolve) => { resolveScan = resolve; });
    dispatch.mockImplementation((name: string) => name === "prune:scan"
      ? scan : Promise.resolve({ ok: true, value: null }));
    await click("Worktrees");
    expect(dispatch.mock.calls.filter(([name]) => name === "prune:scan")).toHaveLength(0);
    await click("Find finished worktrees");
    expect(container.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(container.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("Repository maintenance");
    expect(container.textContent).toContain("Reading Git state across every repository");
    expect(button("Garbage collection").disabled).toBe(true);
    expect(button("Local branches").disabled).toBe(true);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => resolveScan({ ok: true, value: {
      operationId: "scan", cancelled: false,
      startedAt: "2026-09-28T00:00:00Z", finishedAt: "2026-09-28T00:00:01Z",
      counts: { repos: { scanned: 0, cached: 0, skipped: 0, failed: 0, cancelled: 0 },
        worktreesConsidered: 0, candidates: 0, sizeBytes: 0 }, results: []
    } }));
    expect(button("Garbage collection").disabled).toBe(false);
    await click("Worktrees");
    expect(dispatch.mock.calls.filter(([name]) => name === "prune:scan")).toHaveLength(1);
    await click("Garbage collection");
    expect(container.querySelector(".prune__panel")).toBeNull();
    expect(button("Run garbage collection")).toBeTruthy();
    await click("Close");
    expect(onClose).toHaveBeenCalledOnce();
  });

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
    // A 1 KiB saving is below the fold; the quiet line still reaches it.
    expect(container.textContent).toContain("1 repository with less than 1 MiB to reclaim");
    await click("Show");
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
    // Finished is checked by default: every row carries its proof, drawn
    // apart from the facts after it.
    expect(container.querySelector(".maintenance__branch small i")?.textContent).toBe("Already in HEAD");
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
    // One line per deleted branch: name, reviewed tip, Restore. The success
    // message is implied by the tip; only a failure spells itself out.
    expect(container.querySelector(".maintenance__receipt li")?.textContent).toBe("finishedabc123Restore");
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

  it("shows proposing repositories first and collapses the quiet results", async () => {
    const two = { ...repo, id: "two", name: "beta-two" };
    const one = { ...repo, id: "one", name: "gamma-one" };
    const quiet = { ...repo, id: "quiet", name: "alpha-quiet" };
    const quietKept = { ...repo, id: "kept", name: "delta-kept" };
    dispatch.mockResolvedValue({ ok: true, value: summary([
      { repo: quiet, outcome: "success", message: "No branches", candidates: [], kept: [] },
      { repo: one, outcome: "success", message: "One", candidates: [{ ...candidate, repoId: one.id }] },
      { repo: quietKept, outcome: "success", message: "Kept", candidates: [], kept },
      { repo: two, outcome: "success", message: "Two", candidates: [
        { ...candidate, repoId: two.id, branch: "first" },
        { ...candidate, repoId: two.id, branch: "second" }
      ] }
    ]) });
    await click("Local branches");
    await click("Review local branches");
    expect([...container.querySelectorAll(".maintenance__results article .bulk-sync__repo-head strong")].map((node) => node.textContent)).toEqual(["beta-two", "gamma-one"]);
    expect(container.textContent).toContain("3 finished branches in 2 of 4 repositories");
    expect(container.querySelector(".maintenance__quiet")?.textContent).toContain("2 repositories with nothing to delete · 1 of them keep branches");
    await click("Show");
    expect(container.querySelectorAll(".maintenance__results article")).toHaveLength(4);
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
    await click("Change");
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

  it("shows collections that reclaimed space, largest first, and folds the rest", async () => {
    const small = { ...repo, id: "small", name: "small" };
    const big = { ...repo, id: "big", name: "big" };
    const bigger = { ...repo, id: "bigger", name: "bigger" };
    const MiB = 1024 * 1024;
    dispatch.mockResolvedValue({
      ok: true,
      value: summary([
        { repo: small, outcome: "success", message: "Collected", beforeBytes: 11 * 1024, afterBytes: 11 * 1024 },
        { repo: big, outcome: "success", message: "Collected", beforeBytes: 3 * MiB, afterBytes: MiB },
        { repo: bigger, outcome: "success", message: "Collected", beforeBytes: 9 * MiB, afterBytes: MiB }
      ])
    });
    await click("Run garbage collection");
    const names = () => [...container.querySelectorAll(".bulk-sync__repo strong")].map((node) => node.textContent);
    expect(names()).toEqual(["bigger", "big"]);
    expect(container.textContent).toContain("1 repository with less than 1 MiB to reclaim");
    await click("Show");
    expect(names()).toEqual(["bigger", "big", "small"]);
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
          onRemoveWorktrees={async () => ({ removed: [], keptDirty: [], failed: [] })}
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


describe("combined maintenance workflow", () => {
  const events = new Map<string, (event: unknown) => void>();
  const scannedWorktrees = {
    operationId: "scan", cancelled: false,
    startedAt: "2026-09-28T00:00:00Z", finishedAt: "2026-09-28T00:00:01Z",
    counts: { repos: { scanned: 1, cached: 0, skipped: 0, failed: 0, cancelled: 0 },
      worktreesConsidered: 1, candidates: 1, sizeBytes: 1024 },
    results: [{ repoId: "repo", name: "example", path: "/fixtures/example", outcome: "scanned", computed: 1,
      candidates: [{ worktreeId: "finished-wt", repoId: "repo", repoName: "example", branch: "finished",
        path: "/fixtures/finished", reason: { kind: "merged_pr", prNumber: 42 }, sizeBytes: 1024,
        activityComplete: true, lastActivityAt: "2026-08-01T00:00:00Z", lastTouchedAt: "2026-08-01T00:00:00Z" }] }]
  };
  const actions = () => runCalls().map(([, req]) => req.action.kind);
  let remove: ReturnType<typeof vi.fn<(ids: string[]) => Promise<RemoveWorktreesOutcome>>>;
  async function open(savedMode: "review" | "auto" = "review", savedGeneral: Record<string, unknown> = {}) {
    events.clear();
    remove = vi.fn(async (ids: string[]) => {
      ids.forEach((worktreeId) => events.get("worktree:removed")?.({ worktreeId }));
      return { removed: ids, keptDirty: [], failed: [] };
    });
    subscribe.mockImplementation((name: string, handler: (event: unknown) => void) => {
      events.set(name, handler);
      return () => events.delete(name);
    });
    dispatch.mockImplementation(async (name: string, req: { action?: { kind: string } }) => {
      if (name === "settings:read") return { ok: true, value: { general: {
        branchCleanupPrProof: true, branchCleanupKeepDays: null, maintenanceBranchMode: savedMode,
        ...savedGeneral
      } } };
      if (name === "prune:scan") return { ok: true, value: scannedWorktrees };
      if (name === "maintenance:run") return { ok: true, value: summary([{
        repo, outcome: "success", message: "Finished",
        ...(req.action?.kind === "scan-branches" ? { candidates: [candidate], kept: [] } : {}),
        ...(req.action?.kind === "delete-branches" ? { branches: [{ branch: "finished", head: "abc123", deleted: true, message: "Deleted." }] } : {})
      }]) };
      return { ok: true, value: null };
    });
    await act(async () => root.render(<MaintenanceDialog key="workflow" profileId="one" platform="linux"
      onClose={onClose} onRemoveWorktrees={remove} />));
    dispatch.mockClear();
  }
  async function task(index: number) {
    const input = container.querySelectorAll<HTMLInputElement>(".maintenance__plan-step > input[type=checkbox]")[index]!;
    await act(async () => input.click());
  }
  it("defaults to a checked three-step plan and does no work before Analyze", async () => {
    await open();
    expect(button("Combined").getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelectorAll(".maintenance__plan-step > input:checked")).toHaveLength(3);
    expect(runCalls()).toHaveLength(0);
    expect(dispatch.mock.calls.some(([name]) => name === "prune:scan")).toBe(false);
    await task(0); await task(1); await task(2);
    expect(button("Start").disabled).toBe(true);
  });
  it("restores the saved worktree rules, saves a change, and sweeps with them", async () => {
    await open("review", { worktreeCleanupKeepDays: null, worktreeFinishedAfterDays: 0 });
    const guard = container.querySelector<HTMLSelectElement>("select[aria-label='Combined worktree age guard']")!;
    const finished = container.querySelector<HTMLSelectElement>("select[aria-label='Combined worktree finished after']")!;
    expect(guard.disabled).toBe(true);
    expect(finished.value).toBe("0");
    expect(finished.selectedOptions[0]?.textContent).toBe("right away");
    expect(container.textContent).toContain("or whose branch is merged into the default branch.");
    await act(async () => {
      finished.value = "7";
      finished.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(dispatch).toHaveBeenCalledWith("settings:update", {
      patch: { general: { worktreeFinishedAfterDays: 7 } }
    });
    expect(container.textContent).toContain("has had no commits for 7 days.");
    await click("Start");
    expect(dispatch.mock.calls.find(([name]) => name === "prune:scan")?.[1]).toMatchObject({ finishedAfterDays: 7 });
    expect(container.textContent).toContain("Recent protection off");
    expect(container.textContent).toContain("merged, no commits for 7 days");
  });
  it("saves the Worktrees tab's rules and sweeps with them", async () => {
    await open("review", { worktreeCleanupKeepDays: null, worktreeFinishedAfterDays: 0 });
    await click("Worktrees");
    const guard = container.querySelector<HTMLInputElement>(".prune__protection input[type=checkbox]")!;
    const finished = container.querySelector<HTMLSelectElement>("select[aria-label='Finished after']")!;
    expect(guard.checked).toBe(false);
    expect(finished.value).toBe("0");
    await act(async () => {
      finished.value = "3";
      finished.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(dispatch).toHaveBeenCalledWith("settings:update", { patch: { general: { worktreeFinishedAfterDays: 3 } } });
    await act(async () => guard.click());
    expect(dispatch).toHaveBeenCalledWith("settings:update", { patch: { general: { worktreeCleanupKeepDays: 7 } } });
    await click("Find finished worktrees");
    expect(dispatch.mock.calls.find(([name]) => name === "prune:scan")?.[1]).toMatchObject({ finishedAfterDays: 3 });
  });
  it("pauses at both reviews and runs GC only after an explicit continuation", async () => {
    await open();
    await click("Start");
    expect(container.querySelectorAll(".maintenance__step")).toHaveLength(3);
    expect(container.querySelector(".maintenance__step.is-on")?.textContent).toContain("Worktrees");
    expect(container.querySelectorAll(".prune__row")).toHaveLength(1);
    expect(actions()).toEqual([]);
    await click("Skip worktrees");
    expect(container.querySelector(".maintenance__step.is-on")?.textContent).toContain("Local branches");
    expect(actions()).toEqual(["scan-branches"]);
    expect(button("Delete 1 branch and continue")).toBeTruthy();
    await click("Skip branches");
    expect(actions()).toEqual(["scan-branches", "gc"]);
    expect(container.querySelectorAll(".maintenance__receipt-step")).toHaveLength(3);
    expect(remove).not.toHaveBeenCalled();
  });
  it("waits for successful pruning before branch analysis, and preserves branch receipts after GC", async () => {
    await open();
    let finish!: () => void;
    remove.mockImplementation(async (ids) => {
      await new Promise<void>((resolve) => { finish = resolve; });
      ids.forEach((worktreeId) => events.get("worktree:removed")?.({ worktreeId }));
      return { removed: ids, keptDirty: [], failed: [] };
    });
    await click("Start");
    await act(async () => container.querySelector<HTMLInputElement>(".prune__row input")!.click());
    await click("Remove 1 worktree and continue");
    expect(actions()).toEqual([]);
    expect(button("Combined").disabled).toBe(true);
    await act(async () => {
      events.get("worktree:removed")?.({ worktreeId: "other-profile-worktree" });
      finish();
    });
    expect(actions()).toEqual(["scan-branches"]);
    await click("Delete 1 branch and continue");
    expect(actions()).toEqual(["scan-branches", "delete-branches", "gc"]);
    expect(container.textContent).toContain("1 removed");
    expect(container.textContent).toContain("1 deleted");
    expect(button("Restore")).toBeTruthy();
  });
  it("names deletion, not review, in the rail while branches are deleted", async () => {
    await open();
    const previous = dispatch.getMockImplementation()!;
    dispatch.mockImplementation((name, req) => name === "maintenance:run" && req.action.kind === "delete-branches"
      ? new Promise(() => undefined)
      : previous(name, req));
    await click("Start");
    await click("Skip worktrees");
    expect(container.querySelector(".maintenance__step.is-on small")?.textContent).toMatch(/^review · 1 in 1 repos$/);
    await click("Delete 1 branch and continue");
    expect(container.querySelector(".maintenance__step.is-on small")?.textContent).toMatch(/^deleting /);
  });
  it("stays on worktree review, naming what failed, if a requested removal did not succeed", async () => {
    await open();
    remove.mockResolvedValue({ removed: [], keptDirty: [], failed: [{
      id: "finished-wt",
      message: "Could not delete cache: permission denied (EACCES). 3 items were deleted before it stopped; the rest of /fixtures/finished is still on disk and still a worktree."
    }] });
    await click("Start");
    await act(async () => container.querySelector<HTMLInputElement>(".prune__row input")!.click());
    await click("Remove 1 worktree and continue");
    expect(actions()).toEqual([]);
    const card = container.querySelector<HTMLElement>("[role='alert']");
    expect(card?.textContent).toContain("example · finished");
    expect(card?.textContent).toContain("permission denied");
    expect(card?.textContent).toContain("/fixtures/finished");
    expect(container.textContent).not.toContain("Some worktrees were not removed");
    // Continuing is still the user's call.
    expect(button("Skip worktrees").disabled).toBe(false);
  });
  it("restores Auto, enforces an age guard, and sequences scan → removal → GC", async () => {
    await open("auto");
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Branch removal"]')!.value).toBe("auto");
    await act(async () => container.querySelector<HTMLInputElement>('.maintenance__plan-step:nth-child(2) .maintenance__plan-rule:nth-child(2) input')!.click());
    await task(0);
    await click("Start");
    expect(actions()).toEqual(["scan-branches", "delete-branches", "gc"]);
    for (const [, req] of runCalls().slice(0, 2)) {
      expect(req.action.options.keepDays).toBe(7);
      expect(req.allProfiles).toBe(false);
    }
    expect(dispatch.mock.calls.some(([name]) => name === "prune:scan")).toBe(false);
  });
  it("honors task opt-outs and saves the branch-review preference", async () => {
    await open();
    const mode = container.querySelector<HTMLSelectElement>('[aria-label="Branch removal"]')!;
    await act(async () => { mode.value = "auto"; mode.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(dispatch).toHaveBeenCalledWith("settings:update", { patch: { general: { maintenanceBranchMode: "auto" } } });
    await task(0); await task(1);
    await click("Start");
    expect(actions()).toEqual(["gc"]);
  });
  it("does not advance after a cancelled branch scan", async () => {
    await open("auto");
    const previous = dispatch.getMockImplementation()!;
    dispatch.mockImplementation(async (name, req) => name === "maintenance:run"
      ? { ok: true, value: { ...summary([{ repo, outcome: "cancelled", message: "Stopped" }]), cancelled: true } }
      : previous(name, req));
    await task(0);
    await click("Start");
    expect(actions()).toEqual(["scan-branches"]);
    expect(container.textContent).toContain("Not started");
    expect(container.querySelector(".maintenance__receipt-step.is-failed")?.textContent).toContain("Local branches");
  });

  /** The step's outcome card, found as a reader would: an alert named by its
   *  headline. */
  const card = (name: string): HTMLElement | undefined =>
    [...container.querySelectorAll<HTMLElement>("section[role='alert']")].find((node) =>
      document.getElementById(node.getAttribute("aria-labelledby") ?? "")?.textContent === name);
  const cards = () => [...container.querySelectorAll<HTMLElement>("section[role='alert']")]
    .map((node) => document.getElementById(node.getAttribute("aria-labelledby") ?? "")?.textContent);
  const rows = (node: HTMLElement | undefined) =>
    [...node?.querySelectorAll(".maintenance__problem-row") ?? []].map((row) => row.textContent);
  const stepLine = (index: number) =>
    container.querySelectorAll(".maintenance__receipt-step")[index]?.querySelector(".maintenance__receipt-head > span:not(.maintenance__step-num)")?.textContent;
  const other = { ...repo, id: "other", name: "other-repo", path: "/fixtures/other-repo" };
  /** A review where `example` offers one branch and `other-repo` fails. */
  const reviewWithFailure = (previous: (name: string, req: { action: { kind: string } }) => unknown) =>
    async (name: string, req: { action: { kind: string } }) => name === "maintenance:run" && req.action.kind === "scan-branches"
      ? { ok: true, value: summary([
        { repo, outcome: "success", message: "Finished", candidates: [candidate] },
        { repo: other, outcome: "failed", message: "Reference lock unreadable." }
      ]) }
      : previous(name, req);
  const retained = (count: number, deleted: number, message = "The branch changed or is no longer eligible. Review it again; nothing was deleted.") =>
    Array.from({ length: count }, (_, index) => index < deleted
      ? { branch: `done-${index}`, head: "abc123def456", deleted: true, message: "Deleted local branch." }
      : { branch: `kept-${index}`, head: "fedcba9876543210", deleted: false, message });

  it.each(["failed", "partial"] as const)("continues to GC after a %s review and reports the repository", async (outcome) => {
    await open("auto");
    const previous = dispatch.getMockImplementation()!;
    dispatch.mockImplementation(async (name, req) => name === "maintenance:run" && req.action.kind === "scan-branches"
      ? { ok: true, value: summary([{ repo, outcome, message: "Cannot read branch references." }]) }
      : previous(name, req));
    await task(0);
    await click("Start");
    expect(actions()).toEqual(["scan-branches", "gc"]);
    expect(container.textContent).toContain("Maintenance finished with errors");
    expect(container.textContent).not.toContain("Needs attention");
    const found = card("Local branches couldn’t be reviewed in 1 repository");
    expect(found?.textContent).toContain("Nothing in it was deleted. Garbage collection still ran.");
    // A repository-level row: the repository and its path, no branch.
    expect(rows(found)).toEqual(["exampleCouldn’t review its branches. Cannot read branch references./fixtures/example"]);
    expect(found?.querySelector(".maintenance__problem-row b")?.textContent).toBe("Couldn’t review its branches.");
    expect(stepLine(1)).toBe("No branches deleted · 1 not reviewed");
    expect(stepLine(2)).toContain("1 collected");
  });
  it.each(["auto", "review"] as const)("keeps failed reviews when %s deletes branches from successful ones", async (mode) => {
    await open(mode);
    dispatch.mockImplementation(reviewWithFailure(dispatch.getMockImplementation()!));
    await task(0);
    await click("Start");
    if (mode === "review") await click("Delete 1 branch and continue");
    expect(actions()).toEqual(["scan-branches", "delete-branches", "gc"]);
    const found = card("Local branches couldn’t be reviewed in 1 repository");
    expect(found?.textContent).toContain("Nothing in it was deleted. The other branch was deleted, and garbage collection still ran.");
    expect(rows(found)).toEqual(["other-repoCouldn’t review its branches. Reference lock unreadable./fixtures/other-repo"]);
    expect(stepLine(1)).toBe("1 deleted in 1 repository · 1 not reviewed");
    expect(button("Restore")).toBeTruthy();
  });
  it("shows the live step's progress, not a stopped mark, while deleting after a failed review", async () => {
    await open("auto");
    const reviewed = reviewWithFailure(dispatch.getMockImplementation()!);
    dispatch.mockImplementation((name, req) => name === "maintenance:run" && req.action.kind === "delete-branches"
      ? new Promise(() => undefined)
      : reviewed(name, req));
    await task(0);
    await click("Start");
    expect(container.querySelector(".maintenance__step.is-on strong")?.textContent).toBe("Local branches");
    expect(container.querySelector(".maintenance__step.is-on small")?.textContent).toMatch(/^deleting /);
    expect(container.querySelector(".maintenance__step.is-stop")).toBeNull();
  });
  it.each(["failed", "partial"] as const)("runs GC after %s branch removal and puts the card above the receipt", async (outcome) => {
    await open("auto");
    const previous = dispatch.getMockImplementation()!;
    dispatch.mockImplementation(async (name, req) => name === "maintenance:run" && req.action.kind === "delete-branches"
      ? { ok: true, value: summary([{ repo, outcome, message: "25 local branches deleted; 1 retained.", branches: retained(26, 25) }]) }
      : previous(name, req));
    await task(0);
    await click("Start");
    expect(actions()).toEqual(["scan-branches", "delete-branches", "gc"]);
    expect(container.textContent).toContain("Maintenance finished with errors");
    expect(container.textContent).toContain("2 of 2 steps");
    const found = card("1 branch wasn’t deleted")!;
    expect(found.textContent).toContain("It’s unchanged. The other 25 were deleted, and garbage collection still ran.");
    // The row names the branch as its receipt row would, with the reviewed
    // tip; the repository's count sentence is not a row.
    expect(rows(found)).toEqual(["example · kept-25fedcba98The branch changed or is no longer eligible. Review it again; nothing was deleted."]);
    expect(found.querySelector(".maintenance__problem-row b")?.textContent).toBe("The branch changed or is no longer eligible.");
    expect(found.textContent).not.toContain("25 local branches deleted");
    expect(stepLine(1)).toBe("25 deleted in 1 repository · 1 not deleted");
    expect(found.compareDocumentPosition(container.querySelector(".maintenance__receipt-steps")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelector(".maintenance__done-status")!.compareDocumentPosition(found) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const partial = container.querySelector<HTMLElement>(".maintenance__receipt-step.is-partial")!;
    expect(partial.textContent).toContain("Local branches");
    expect(container.querySelectorAll(".maintenance__receipt-row")).toHaveLength(20);
    await click("Show all 25");
    expect(container.querySelectorAll(".maintenance__restore")).toHaveLength(25);
    await act(async () => [...partial.querySelectorAll("button")].find((node) => node.textContent === "Hide")!.click());
    expect(partial.querySelectorAll(".maintenance__receipt-row")).toHaveLength(0);
  });
  it("scrolls a whole batch of retained branches inside the card, under a fixed head", async () => {
    await open("auto");
    const previous = dispatch.getMockImplementation()!;
    dispatch.mockImplementation(async (name, req) => name === "maintenance:run" && req.action.kind === "delete-branches"
      ? { ok: true, value: summary([{ repo, outcome: "failed", message: "0 local branches deleted; 27 retained.", branches: retained(27, 0) }]) }
      : previous(name, req));
    await task(0);
    await click("Start");
    const found = card("27 branches weren’t deleted")!;
    expect(found.textContent).toContain("They’re unchanged. Garbage collection still ran.");
    const list = found.querySelector<HTMLElement>("ul[aria-label='Branches not deleted']")!;
    expect(list.tabIndex).toBe(0);
    expect(list.querySelectorAll(".maintenance__problem-row")).toHaveLength(27);
    expect(found.querySelector(".maintenance__problem-head")!.contains(list)).toBe(false);
    expect(stepLine(1)).toBe("0 deleted · 27 not deleted");
    // Nothing was deleted, so there is no receipt to show.
    expect(container.querySelectorAll(".maintenance__receipt-step")[1]?.querySelector("button")).toBeNull();
  });
  it("puts Git's own words behind Details", async () => {
    await open("auto");
    const raw = "error: cannot delete branch 'finished' used by worktree at '/old/example/.git/worktrees/finished'";
    const previous = dispatch.getMockImplementation()!;
    dispatch.mockImplementation(async (name, req) => name === "maintenance:run" && req.action.kind === "delete-branches"
      ? { ok: true, value: summary([{ repo, outcome: "failed", message: "0 local branches deleted; 1 retained.", branches: [
        { branch: "finished", head: "abc123", deleted: false, message: raw }
      ] }]) }
      : previous(name, req));
    await task(0);
    await click("Start");
    const found = card("1 branch wasn’t deleted")!;
    expect(found.querySelector(".maintenance__problem-row > p")?.textContent).toBe("Git refused to delete it.");
    expect(found.textContent).not.toContain(raw);
    const toggle = found.querySelector<HTMLButtonElement>(".maintenance__problem-toggle")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await act(async () => toggle.click());
    expect(found.querySelector(".maintenance__problem-raw")?.textContent).toBe(raw);
  });
  it("reports a refresh failure even when every deletion succeeded", async () => {
    await open("auto");
    const previous = dispatch.getMockImplementation()!;
    dispatch.mockImplementation(async (name, req) => {
      const response = await previous(name, req);
      if (name === "maintenance:run" && req.action.kind === "delete-branches") {
        response.value.results[0].outcome = "partial";
        response.value.results[0].message = "1 local branch deleted; 0 retained. Refresh failed: unavailable.";
      }
      return response;
    });
    await task(0);
    await click("Start");
    expect(actions()).toEqual(["scan-branches", "delete-branches", "gc"]);
    expect(rows(card("Local branches: 1 problem in 1 repository"))).toEqual(["exampleRefresh failed: unavailable./fixtures/example"]);
    expect(stepLine(1)).toBe("1 deleted in 1 repository · 1 problem");
    expect(button("Restore")).toBeTruthy();
  });
  it("stops on a cancelled deletion and keeps each retained branch's reason", async () => {
    await open("auto");
    const previous = dispatch.getMockImplementation()!;
    dispatch.mockImplementation(async (name, req) => name === "maintenance:run" && req.action.kind === "delete-branches"
      ? { ok: true, value: { ...summary([{ repo, outcome: "cancelled", message: "0 local branches deleted; 1 retained.", branches: [
        { branch: "finished", head: "abc123", deleted: false, message: "Cancelled; retained." }
      ] }]), cancelled: true } }
      : previous(name, req));
    await task(0);
    await click("Start");
    expect(actions()).toEqual(["scan-branches", "delete-branches"]);
    expect(container.textContent).toContain("Maintenance stopped");
    const found = card("1 branch wasn’t deleted");
    // Collection never ran, so the sub-line does not claim it did.
    expect(found?.querySelector(".maintenance__problem-head span:not(.maintenance__problem-mark)")?.textContent).toBe("It’s unchanged.");
    expect(rows(found)).toEqual(["example · finishedabc123Cancelled; retained."]);
  });
  it.each([
    ["cancelled", { ok: true, value: { ...summary([{ repo, outcome: "cancelled", message: "0 local branches deleted; 1 retained.", branches: [
      { branch: "finished", head: "abc123", deleted: false, message: "Cancelled; retained." }
    ] }]), cancelled: true } }, "Local branches: 2 problems in 2 repositories"],
    ["refused", { ok: false, error: { message: "Another maintenance run is active." } }, "Local branches couldn’t be reviewed in 1 repository"]
  ])("keeps a failed review when a %s deletion stops the run", async (_kind, response, headline) => {
    await open("auto");
    const reviewed = reviewWithFailure(dispatch.getMockImplementation()!);
    dispatch.mockImplementation(async (name, req) => name === "maintenance:run" && req.action.kind === "delete-branches"
      ? response
      : reviewed(name, req));
    await task(0);
    await click("Start");
    expect(actions()).toEqual(["scan-branches", "delete-branches"]);
    expect(container.textContent).toContain("Maintenance stopped");
    const found = card(headline);
    expect(found?.textContent).toContain("Reference lock unreadable.");
    expect(found?.textContent).toContain(_kind === "cancelled" ? "Cancelled; retained." : "Another maintenance run is active.");
    // A command error is not a repository's problem, and says the run stopped.
    if (_kind === "refused") expect(found?.textContent).toContain("Nothing in it was deleted. Maintenance stopped here.");
  });
  it.each([false, true])("counts a skipped deletion as skipped whether or not a review failed (failed: %s)", async (failed) => {
    await open("review");
    if (failed) dispatch.mockImplementation(reviewWithFailure(dispatch.getMockImplementation()!));
    await task(0);
    await click("Start");
    await click("Skip branches");
    expect(actions()).toEqual(["scan-branches", "gc"]);
    expect(container.textContent).toContain("1 of 2 steps");
    expect(container.textContent).toContain(failed ? "Maintenance finished with errors" : "Maintenance finished");
    expect(stepLine(1)).toBe(failed ? "Skipped deletion · 1 not reviewed" : "Skipped deletion");
    expect(cards()).toEqual(failed ? ["Local branches couldn’t be reviewed in 1 repository"] : []);
    if (failed) expect(card("Local branches couldn’t be reviewed in 1 repository")?.textContent).toContain("Reference lock unreadable.");
  });
  it("names the command error when no repository results are returned", async () => {
    await open("auto");
    const previous = dispatch.getMockImplementation()!;
    dispatch.mockImplementation(async (name, req) => name === "maintenance:run"
      ? { ok: false, error: { message: "Another maintenance run is active." } }
      : previous(name, req));
    await task(0);
    await click("Start");
    expect(actions()).toEqual(["scan-branches"]);
    expect(rows(card("Local branches couldn’t run"))).toEqual(["Another maintenance run is active."]);
  });
  it("reports GC failures in their own card, after the branch card", async () => {
    await open("auto");
    const previous = dispatch.getMockImplementation()!;
    dispatch.mockImplementation(async (name, req) => name === "maintenance:run" && req.action.kind !== "scan-branches"
      ? { ok: true, value: summary([{ repo, outcome: "failed", message: req.action.kind === "gc" ? "Repack failed. Disk full." : "Branch reference locked." }]) }
      : previous(name, req));
    await task(0);
    await click("Start");
    expect(actions()).toEqual(["scan-branches", "delete-branches", "gc"]);
    expect(cards()).toEqual(["Local branches: 1 problem in 1 repository", "Garbage collection failed in 1 repository"]);
    const gc = card("Garbage collection failed in 1 repository")!;
    expect(gc.textContent).toContain("Its objects are unchanged.");
    expect(gc.querySelector("ul")?.getAttribute("aria-label")).toBe("Repositories not collected");
    expect(rows(gc)).toEqual(["exampleRepack failed. Disk full./fixtures/example"]);
    expect(gc.querySelector(".maintenance__problem-row b")?.textContent).toBe("Repack failed.");
    expect(stepLine(2)).toBe("0 collected · 1 failed");
    expect(container.textContent).toContain("Maintenance finished with errors");
  });
  it("keeps branch failures on screen while garbage collection runs", async () => {
    await open("auto");
    const previous = dispatch.getMockImplementation()!;
    let finish!: () => void;
    dispatch.mockImplementation(async (name, req) => {
      if (name === "maintenance:run" && req.action.kind === "delete-branches")
        return { ok: true, value: summary([{ repo, outcome: "partial", message: "2 local branches deleted; 1 retained.", branches: retained(3, 2) }]) };
      if (name === "maintenance:run" && req.action.kind === "gc")
        await new Promise<void>((resolve) => { finish = resolve; });
      return previous(name, req);
    });
    await task(0);
    await click("Start");
    expect(container.querySelector(".maintenance__step.is-on")?.textContent).toContain("Garbage collection");
    expect(container.querySelector(".maintenance__step.is-stop")?.textContent).toContain("Local branches");
    expect(card("1 branch wasn’t deleted")?.textContent).toContain("It’s unchanged. The other 2 were deleted; collection is still running.");
    await act(async () => finish());
    expect(container.textContent).toContain("Maintenance finished with errors");
    expect(card("1 branch wasn’t deleted")?.textContent).toContain("The other 2 were deleted, and garbage collection still ran.");
  });
});
