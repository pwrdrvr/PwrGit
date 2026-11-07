// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GitReflinkStatus,
  MaintenanceCurrent,
  MaintenanceProgress,
  MaintenanceRunRecord,
  MaintenanceRunView,
  MaintenanceRepo,
  MaintenanceRepoResult,
  MaintenanceSummary
} from "@pwrgit/shared";
const { dispatch, subscribe } = vi.hoisted(() => ({ dispatch: vi.fn(), subscribe: vi.fn() }));
vi.mock("../../lib/pwrgit", () => ({ dispatch, subscribe }));
import { ClonesPanel, clonesBytes, clonesHeadline, repeatedRepoNames } from "./ClonesPanel";

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

describe("repositories that share a name", () => {
  it("are told apart by path, and only they are", () => {
    const other = { ...repo("gpui-kit"), id: "gpui-kit-2", path: "/elsewhere/gpui-kit" };
    expect([...repeatedRepoNames([repo("gpui-kit"), other, repo("solo")])]).toEqual(["gpui-kit"]);
  });
});

describe("ClonesPanel", () => {
  it("names the fix when the Git in use cannot re-share", async () => {
    await render({ ...capable, version: "git version 2.56.0", support: { checkout: false, reshare: false } });
    expect(container.textContent).toContain("Refreshing clones needs PwrGit’s Git");
    expect(container.textContent).toContain("The Git in use (2.56.0) has no git worktree reflink.");
    expect(button("Refresh clones").disabled).toBe(true);
    await act(async () => button("Open Git settings").click());
    expect(dispatch).toHaveBeenCalledWith("settings:open", { page: "git", sub: "runtime" });
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
      progress?.({ operationId, profileId: "one", phase: "starting", repos: [repo("a"), repo("b")], noWorktrees: [repo("z")] });
      progress?.({ operationId, profileId: "one", phase: "repo_started", repo: repo("a") });
      progress?.({ operationId, profileId: "one", phase: "repo_progress", repo: repo("a"), detail: "Worktree 1 of 1 · feature" });
    });
    expect(container.textContent).toContain("Refreshing clones in 1 repository");
    expect(container.textContent).toContain("Worktree 1 of 1 · feature");
    // Repositories without worktrees are their own line, not skips.
    expect(container.textContent).toContain("1 repository has no linked worktrees, so nothing to share");
    // No per-repository ETA: one repository can hold hundreds of worktrees.
    expect(container.textContent).not.toMatch(/left$|· about/);
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
    expect(container.textContent).toContain("took 1m 05s");
    // Largest share first.
    expect(
      Array.from(container.querySelectorAll(".maintenance__clones-name strong"), (node) => node.textContent)
    ).toEqual(["b", "a"]);
    expect(container.textContent).toContain("9 files re-shared · 2 left as they are (2 changed).");
    expect(button("Run again").disabled).toBe(false);
    // The run is over: Close is the primary, last, in the CTA colour, and focused.
    const footer = [...container.querySelectorAll<HTMLButtonElement>(".modal__actions button")];
    expect(footer.map((node) => node.textContent?.trim())).toEqual(["Run again", "Close"]);
    expect(footer.at(-1)?.classList.contains("modal__create")).toBe(true);
    expect(document.activeElement).toBe(footer.at(-1));
  });
});

describe("ClonesPanel after a window reload", () => {
  const run: MaintenanceRunRecord = {
    operationId: "op-live",
    profileId: "one",
    allProfiles: true,
    action: { kind: "reshare", updateMain: false },
    startedAt: "2026-11-04T12:00:00Z",
    ownWindow: true
  };
  /** Main's snapshot: `a` finished, `b` running, `c` queued. */
  const snapshot: MaintenanceRunView = {
    repos: [repo("a"), repo("b"), repo("c")],
    noWorktrees: [],
    running: ["b"],
    details: { b: "Worktree 3 of 408 · feature" },
    results: [reshared("a", 1024 * 1024, 3)],
    seq: 6
  };
  async function renderWith(current: MaintenanceCurrent): Promise<void> {
    dispatch.mockImplementation(async (name: string) =>
      name === "git:reflinkSupport"
        ? { ok: true, value: capable }
        : name === "maintenance:current"
          ? { ok: true, value: current }
          : name === "maintenance:run"
            ? new Promise(() => undefined)
            : { ok: true, value: name === "maintenance:cancel" ? { cancelled: true } : null }
    );
    await act(async () => {
      root.render(<ClonesPanel profileId="one" platform="darwin" onClose={() => undefined} onBusyChange={() => undefined} />);
    });
  }
  const send = (event: Omit<MaintenanceProgress, "operationId" | "profileId">): void =>
    progress?.({ operationId: "op-live", profileId: "one", ...event });

  it("picks the live run up where main's snapshot left it, and can still cancel it", async () => {
    await renderWith({ state: "running", run, view: snapshot, cancelling: false });
    expect(dispatch).toHaveBeenCalledWith("maintenance:current", { profileId: "one" });
    expect(dispatch.mock.calls.some(([name]) => name === "maintenance:run")).toBe(false);
    expect(container.textContent).toContain("Refreshing clones in 1 repository");
    expect(container.textContent).toContain("Worktree 3 of 408 · feature");
    expect(container.textContent).toContain("3 files re-shared");

    await act(async () => {
      // Already in the snapshot: must not move the line back.
      send({ phase: "repo_progress", seq: 5, repo: repo("b"), detail: "Worktree 2 of 408 · old" });
      send({ phase: "repo_progress", seq: 7, repo: repo("b"), detail: "Worktree 4 of 408 · next" });
    });
    expect(container.textContent).toContain("Worktree 4 of 408 · next");
    expect(container.textContent).not.toContain("Worktree 2 of 408 · old");

    await act(async () => button("Cancel").click());
    expect(dispatch).toHaveBeenCalledWith("maintenance:cancel", { operationId: "op-live" });

    const summary: MaintenanceSummary = {
      operationId: "op-live",
      startedAt: run.startedAt,
      finishedAt: "2026-11-04T12:16:40Z",
      cancelled: false,
      results: [reshared("a", 1024 * 1024, 3), reshared("b", 2 * 1024 * 1024, 5), reshared("c", 0, 0)]
    };
    await act(async () => send({ phase: "finished", seq: 8, summary }));
    expect(container.querySelector(".maintenance__done-status")?.textContent).toContain(
      "3.0 MiB of file data now shared with main checkouts"
    );
    expect(container.textContent).toContain("took 16m 40s");
    expect(dispatch).toHaveBeenCalledWith("maintenance:seen", { profileId: "one", operationId: "op-live" });
    // Run again repeats the reattached run's options, not this panel's defaults.
    await act(async () => button("Run again").click());
    expect(dispatch.mock.calls.find(([name]) => name === "maintenance:run")?.[1]).toMatchObject({
      allProfiles: true,
      action: { kind: "reshare", updateMain: false }
    });
  });

  it("shows the receipt of a run that finished while no dialog was open, once", async () => {
    const summary: MaintenanceSummary = {
      operationId: "op-live",
      startedAt: run.startedAt,
      finishedAt: "2026-11-04T12:00:30Z",
      cancelled: false,
      results: [reshared("a", 1024 * 1024, 3)]
    };
    await renderWith({ state: "finished", run, summary, seen: false });
    expect(container.querySelector(".maintenance__done-status")?.textContent).toContain(
      "1.0 MiB of file data now shared with main checkouts"
    );
    expect(dispatch).toHaveBeenCalledWith("maintenance:seen", { profileId: "one", operationId: "op-live" });
  });

  it("opens on its setup when the last receipt was already seen", async () => {
    await renderWith({
      state: "finished",
      run,
      summary: { operationId: "op-live", startedAt: run.startedAt, finishedAt: run.startedAt, cancelled: false, results: [] },
      seen: true
    });
    expect(container.querySelector(".maintenance__done-status")).toBeNull();
    expect(button("Refresh clones").disabled).toBe(false);
  });

  it("draws a run that was already stopping as stopping, not live", async () => {
    await renderWith({ state: "running", run, view: snapshot, cancelling: true });
    expect(container.textContent).toContain("Stopping after the worktrees already running…");
    expect(button("Cancelling…").disabled).toBe(true);
  });

  it("does not offer Cancel on a run another window started", async () => {
    await renderWith({ state: "running", run: { ...run, ownWindow: false }, view: snapshot, cancelling: false });
    expect(container.textContent).toContain("Refreshing clones in 1 repository");
    expect(button("Cancel").disabled).toBe(true);
    expect(container.textContent).toContain("Started in another window, which alone can cancel it.");
  });

  it("leaves another kind of run to the dialog", async () => {
    await renderWith({ state: "running", run: { ...run, action: { kind: "gc", mode: "standard" } }, view: snapshot, cancelling: false });
    expect(container.textContent).not.toContain("Refreshing clones in");
    expect(button("Refresh clones")).toBeDefined();
  });
});
