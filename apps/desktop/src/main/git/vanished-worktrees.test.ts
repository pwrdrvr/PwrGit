import { ok } from "@pwrgit/shared";
import { describe, expect, it, vi } from "vitest";
import type { GitExec } from "./dugite";
import type { WorktreeInfo } from "./git-service";
import {
  createVanishedWorktreeRefresh,
  forgetVanishedWorktrees,
  onDetachedVolume,
  VANISHED_WORKTREE_REFRESH_COOLDOWN_MS,
  type VolumeFs
} from "./vanished-worktrees";

vi.mock("../logs", () => ({ logMain: vi.fn() }));

/** A filesystem of existing paths, each on a device. */
function fakeFs(devices: Record<string, number>): VolumeFs {
  return {
    exists: async (path) => path in devices,
    device: async (path) => devices[path] ?? null
  };
}

describe("onDetachedVolume", () => {
  it("reads a path on a fixed disk as attached", async () => {
    const fs = fakeFs({ "/": 1, "/Users": 1, "/Users/me": 1 });
    expect(await onDetachedVolume("/Users/me/.codex/worktrees/a1/repo", "darwin", fs)).toBe(false);
  });

  it("reads an unplugged macOS volume as detached", async () => {
    const fs = fakeFs({ "/": 1, "/Volumes": 1 });
    expect(await onDetachedVolume("/Volumes/Thumb/repo-wt", "darwin", fs)).toBe(true);
  });

  it("reads a plugged-in volume whose worktree was deleted as attached", async () => {
    const fs = fakeFs({ "/": 1, "/Volumes": 1, "/Volumes/Thumb": 7 });
    expect(await onDetachedVolume("/Volumes/Thumb/work/repo-wt", "darwin", fs)).toBe(false);
  });

  it("reads an empty mount-point directory as detached", async () => {
    // Left behind by an unmount: it exists, but on its parent's device.
    const fs = fakeFs({ "/": 1, "/mnt": 1, "/mnt/usb": 1 });
    expect(await onDetachedVolume("/mnt/usb/repo-wt", "linux", fs)).toBe(true);
  });

  it("finds a mount a level below the container (/run/media/<user>/<label>)", async () => {
    const fs = fakeFs({
      "/": 1,
      "/run": 1,
      "/run/media": 1,
      "/run/media/me": 1,
      "/run/media/me/USB": 9
    });
    expect(await onDetachedVolume("/run/media/me/USB/repo-wt", "linux", fs)).toBe(false);
    const unplugged = fakeFs({ "/": 1, "/run": 1, "/run/media": 1, "/run/media/me": 1 });
    expect(await onDetachedVolume("/run/media/me/USB/repo-wt", "linux", unplugged)).toBe(true);
  });

  it("reads a missing Windows drive as detached", async () => {
    expect(await onDetachedVolume("E:\\work\\repo-wt", "win32", fakeFs({ "C:\\": 1 }))).toBe(true);
    expect(await onDetachedVolume("C:\\work\\repo-wt", "win32", fakeFs({ "C:\\": 1 }))).toBe(false);
  });
});

const entry = (path: string, extra: Partial<WorktreeInfo> = {}): WorktreeInfo => ({
  path,
  branch: path.split("/").pop() ?? "",
  head: "abc1234",
  detached: false,
  bare: false,
  prunable: false,
  locked: false,
  ...extra
});

describe("forgetVanishedWorktrees", () => {
  const fs = fakeFs({ "/": 1, "/r": 1, "/r/main": 1, "/r/stub": 1, "/Volumes": 1 });

  it("removes only deleted, unlocked linked worktrees on an attached disk", async () => {
    const git = vi.fn<GitExec>(async () => ok({ stdout: "", stderr: "", exitCode: 0 }));
    const listed = [
      entry("/r/main", { prunable: true }), // the primary is never touched
      entry("/r/live"),
      entry("/r/gone", { prunable: true }),
      entry("/r/held", { prunable: true, locked: true }),
      entry("/r/stub", { prunable: true }), // folder left, .git link gone
      entry("/Volumes/Thumb/wt", { prunable: true })
    ];

    const kept = await forgetVanishedWorktrees(git, "/r/main", listed, fs, "darwin");

    expect(git).toHaveBeenCalledExactlyOnceWith(
      ["worktree", "remove", "--force", "/r/gone"],
      "/r/main"
    );
    expect(kept.map((w) => w.path)).toEqual([
      "/r/main",
      "/r/live",
      "/r/held",
      "/r/stub",
      "/Volumes/Thumb/wt"
    ]);
  });

  it("keeps a detached worktree whose commits only its record reaches", async () => {
    const git = vi.fn<GitExec>(async (args) =>
      ok({
        stdout: args[0] === "for-each-ref" && args.includes("aaa1111") ? "refs/heads/main\n" : "",
        stderr: "",
        exitCode: 0
      })
    );
    const listed = [
      entry("/r/main"),
      entry("/r/on-main", { prunable: true, detached: true, head: "aaa1111" }),
      entry("/r/orphan", { prunable: true, detached: true, head: "bbb2222" })
    ];
    const kept = await forgetVanishedWorktrees(git, "/r/main", listed, fs, "darwin");
    expect(kept.map((w) => w.path)).toEqual(["/r/main", "/r/orphan"]);
    expect(git).toHaveBeenCalledWith(["worktree", "remove", "--force", "/r/on-main"], "/r/main");
  });

  it("keeps an entry git declined to remove", async () => {
    const git = vi.fn<GitExec>(async () =>
      ok({ stdout: "", stderr: "fatal: nope", exitCode: 128 })
    );
    const listed = [entry("/r/main"), entry("/r/gone", { prunable: true })];
    const kept = await forgetVanishedWorktrees(git, "/r/main", listed, fs, "darwin");
    expect(kept.map((w) => w.path)).toEqual(["/r/main", "/r/gone"]);
  });
});

describe("createVanishedWorktreeRefresh", () => {
  it("re-indexes once per worktree per cooldown", () => {
    let clock = 0;
    const refresh = vi.fn();
    const onMissing = createVanishedWorktreeRefresh({ refresh, now: () => clock });
    onMissing("wt1", "repo");
    onMissing("wt2", "repo");
    expect(refresh).toHaveBeenCalledTimes(2);
    // A kept row (detached volume, lock) is found missing on every poll.
    clock += 15_000;
    onMissing("wt1", "repo");
    expect(refresh).toHaveBeenCalledTimes(2);
    clock += VANISHED_WORKTREE_REFRESH_COOLDOWN_MS;
    onMissing("wt1", "repo");
    expect(refresh).toHaveBeenCalledTimes(3);
  });
});
