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
  upstream: "refs/remotes/origin/finished"
};
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
  await act(async () =>
    root.render(
      <StrictMode>
        <MaintenanceDialog profileId="one" platform="linux" onClose={onClose} />
      </StrictMode>
    )
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.resetAllMocks();
});

describe("maintenance dialog", () => {
  it("explains the choices and waits for explicit start even in StrictMode", async () => {
    expect(dispatch).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Standard (recommended)");
    expect(container.textContent).toContain("no guaranteed size reduction");
    dispatch.mockResolvedValue({ ok: true, value: summary([]) });
    await click("Run garbage collection");
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(
      "maintenance:run",
      expect.objectContaining({
        profileId: "one",
        allProfiles: false,
        action: { kind: "gc", mode: "standard" }
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
      "Stopping after the current repository operation"
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
    expect(container.textContent).toContain("Fetch all repos first");
    expect(dispatch).not.toHaveBeenCalled();
    await click("Review local branches");
    expect(button("Delete 0 selected local branches").disabled).toBe(true);
    expect(container.textContent).toContain("origin/finished");
    const checkbox = container.querySelector<HTMLInputElement>(
      ".maintenance__branch input"
    )!;
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
        action: { kind: "delete-branches", branches: [candidate] }
      })
    );
    expect(container.querySelector(".maintenance__branch")).toBeNull();
    expect(container.textContent).toContain("Deleted local branch.");
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
