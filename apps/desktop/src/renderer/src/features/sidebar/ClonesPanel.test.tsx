// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GitReflinkStatus,
  MaintenanceProgress,
  MaintenanceRepo,
  MaintenanceRepoResult,
  MaintenanceSummary
} from "@pwrgit/shared";
const { dispatch, subscribe } = vi.hoisted(() => ({ dispatch: vi.fn(), subscribe: vi.fn() }));
vi.mock("../../lib/pwrgit", () => ({ dispatch, subscribe }));
import { ClonesPanel, clonesBytes, clonesHeadline } from "./ClonesPanel";

const repo = (id: string): MaintenanceRepo => ({
  id,
  name: id,
  path: `/fixtures/${id}`,
  profileId: "one",
  profileName: "One"
});

const reshared = (id: string, bytes: number, files: number): MaintenanceRepoResult => ({
  repo: repo(id),
  outcome: "success",
  message: `main up to date · 1 worktree · ${files} files re-shared.`,
  reshare: {
    main: { outcome: "up_to_date", branch: "main", defaultBranch: "main", message: "main up to date." },
    worktrees: [
      {
        worktreeId: `${id}-wt`,
        path: `/fixtures/${id}-wt`,
        branch: "feature",
        outcome: "reshared",
        message: `${files} files re-shared · 2 left as they are (2 changed).`,
        reshared: files,
        alreadyShared: 0,
        skipped: 2,
        failed: 0,
        sharedBytes: bytes
      }
    ]
  }
});

const capable: GitReflinkStatus = {
  path: "/fixture/git",
  version: "git version 2.56.0-dev-pwrgit.2",
  support: { checkout: true, reshare: true },
  enabled: true,
  active: true
};

let root: Root;
let container: HTMLDivElement;
let progress: ((event: MaintenanceProgress) => void) | null;

beforeEach(() => {
  vi.clearAllMocks();
  progress = null;
  subscribe.mockImplementation((_name: string, listener: (event: MaintenanceProgress) => void) => {
    progress = listener;
    return () => {
      progress = null;
    };
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const button = (name: string): HTMLButtonElement => {
  const match = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
    (candidate) => candidate.textContent === name
  );
  if (match === undefined) throw new Error(`Button not found: ${name}`);
  return match;
};

async function render(support: GitReflinkStatus): Promise<void> {
  dispatch.mockImplementation(async (name: string) =>
    name === "git:reflinkSupport" ? { ok: true, value: support } : { ok: true, value: null }
  );
  await act(async () => {
    root.render(<ClonesPanel profileId="one" platform="darwin" onClose={() => undefined} onBusyChange={() => undefined} />);
  });
}

describe("clones receipt wording", () => {
  it("counts Git's shared bytes and never says freed", () => {
    expect(clonesHeadline([reshared("a", 3 * 1024 * 1024, 10), reshared("b", 1024 * 1024, 4)])).toEqual({
      title: "4.0 MiB of file data now shared with main checkouts",
      detail: "2 worktrees · 14 files re-shared · 4 left as they are"
    });
    expect(clonesHeadline([reshared("a", 0, 0)]).title).toBe("Nothing new to share");
    expect(clonesBytes(512)).toBe("512 B");
  });
});

describe("ClonesPanel", () => {
  it("names the fix when the Git in use cannot re-share", async () => {
    await render({ ...capable, version: "git version 2.56.0", support: { checkout: false, reshare: false } });
    expect(container.textContent).toContain("Refreshing clones needs PwrGit’s Git");
    expect(container.textContent).toContain("The Git in use (2.56.0) has no git worktree reflink.");
    expect(button("Refresh clones").disabled).toBe(true);
    await act(async () => button("Open Git runtime settings").click());
    expect(dispatch).toHaveBeenCalledWith("settings:open", { page: "general" });
  });

  it("says runtime .1 clones but cannot re-share", async () => {
    await render({ ...capable, version: "git version 2.56.0-dev-pwrgit.1", support: { checkout: true, reshare: false } });
    expect(container.textContent).toContain("needs PwrGit’s Git 2.56.0-dev-pwrgit.2 or newer");
  });

  it("runs every repository with the reshare action and shows the receipt", async () => {
    await render(capable);
    let finish!: (value: { ok: true; value: MaintenanceSummary }) => void;
    dispatch.mockImplementation(async (name: string) => {
      if (name === "maintenance:run") return new Promise((resolve) => (finish = resolve));
      return { ok: true, value: name === "git:reflinkSupport" ? capable : null };
    });
    // Untick "Update main checkouts first".
    await act(async () => container.querySelector<HTMLInputElement>("input[type=checkbox]")!.click());
    await act(async () => button("Refresh clones").click());
    const run = dispatch.mock.calls.find(([name]) => name === "maintenance:run");
    expect(run?.[1]).toMatchObject({ profileId: "one", allProfiles: false, action: { kind: "reshare", updateMain: false } });
    const { operationId } = (run?.[1] ?? {}) as { operationId: string };

    await act(async () => {
      progress?.({ operationId, profileId: "one", phase: "starting", repos: [repo("a"), repo("b")] });
      progress?.({ operationId, profileId: "one", phase: "repo_started", repo: repo("a") });
      progress?.({ operationId, profileId: "one", phase: "repo_progress", repo: repo("a"), detail: "Worktree 1 of 1 · feature" });
    });
    expect(container.textContent).toContain("Refreshing clones in 1 repository");
    expect(container.textContent).toContain("Worktree 1 of 1 · feature");
    expect(button("Cancel")).toBeDefined();

    const results = [reshared("a", 1024 * 1024, 3), reshared("b", 4 * 1024 * 1024, 9)];
    await act(async () => {
      finish({
        ok: true,
        value: {
          operationId,
          startedAt: "2026-11-04T12:00:00Z",
          finishedAt: "2026-11-04T12:01:05Z",
          cancelled: false,
          results
        }
      });
    });
    expect(container.querySelector(".maintenance__done-status")?.textContent).toContain(
      "5.0 MiB of file data now shared with main checkouts"
    );
    expect(container.textContent).toContain("took 1m 5s");
    // Largest share first.
    expect(
      Array.from(container.querySelectorAll(".maintenance__clones-name strong"), (node) => node.textContent)
    ).toEqual(["b", "a"]);
    expect(container.textContent).toContain("9 files re-shared · 2 left as they are (2 changed).");
    expect(button("Run again").disabled).toBe(false);
  });
});
