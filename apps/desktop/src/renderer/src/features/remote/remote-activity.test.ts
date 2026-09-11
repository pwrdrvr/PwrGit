import { describe, expect, it } from "vitest";
import type { RemoteActivity } from "@pwrgit/shared";
import {
  formatElapsed,
  remoteActivityMeter,
  remoteActivityReport,
  remoteActivityStatus,
  remoteActivityTitle,
  REMOTE_ACTIVITY_QUIET_MS
} from "./remote-activity";
import {
  elsewhereActivities,
  REMOTE_ACTIVITY_TOAST_AFTER_MS
} from "./RemoteActivityToast";

const base: RemoteActivity = {
  id: "op-1",
  kind: "pull",
  phase: "fetch",
  profileId: "profile-1",
  repoId: "repo-1",
  repoName: "PwrAgnt",
  worktreeId: "worktree-1",
  branch: "main",
  startedAt: 0,
  phaseSince: 0,
  lastOutputAt: 0,
  silent: false,
  progress: null,
  command: null,
  tail: [],
  canceling: false
};

const at = (overrides: Partial<RemoteActivity>): RemoteActivity => ({
  ...base,
  ...overrides
});

describe("remoteActivityTitle", () => {
  it("names the operation, the repository and the branch", () => {
    expect(remoteActivityTitle(base)).toBe("Pull · PwrAgnt · main");
  });

  it("drops the branch on a repo-wide fetch, which owns no checkout", () => {
    expect(
      remoteActivityTitle(at({ kind: "fetch", worktreeId: null, branch: null }))
    ).toBe("Fetch · PwrAgnt");
  });
});

describe("formatElapsed", () => {
  it("counts in seconds, then minutes, then hours", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(41_000)).toBe("41s");
    expect(formatElapsed(125_000)).toBe("2m 05s");
    expect(formatElapsed(3_900_000)).toBe("1h 05m");
  });
});

describe("remoteActivityStatus", () => {
  it("reports the queued wait with its own duration", () => {
    // The wait for another operation's lock is not Git being slow, and saying
    // "Fetching updates" through it is simply untrue.
    expect(remoteActivityStatus(at({ phase: "queued" }), 30_000)).toEqual({
      label: "Waiting for another Git operation — 30s",
      tone: "muted"
    });
  });

  it("stays calm while Git is writing", () => {
    expect(
      remoteActivityStatus(
        at({ lastOutputAt: REMOTE_ACTIVITY_QUIET_MS }),
        REMOTE_ACTIVITY_QUIET_MS + 1_000
      )
    ).toEqual({ label: "Fetching updates", tone: "muted" });
  });

  it("calls out a network phase that has gone quiet", () => {
    expect(remoteActivityStatus(at({ lastOutputAt: 0 }), 124_000)).toEqual({
      label: "Fetching updates — no Git output for 2m 04s",
      tone: "warn"
    });
  });

  it("distinguishes never-answered from went-quiet", () => {
    // The five-minute wedge: Git was started, wrote nothing at all, and the
    // old spinner looked exactly like a healthy large transfer.
    expect(
      remoteActivityStatus(at({ silent: true, lastOutputAt: 0 }), 300_000)
    ).toEqual({
      label: "Contacting the remote — no response for 5m 00s",
      tone: "warn"
    });
  });

  it("does not cry wolf during local phases, which print nothing", () => {
    // `--progress` guarantees output during fetch and push. Checkout and stash
    // make no such promise, so silence there is not evidence of anything.
    expect(
      remoteActivityStatus(at({ phase: "fast_forward", lastOutputAt: 0 }), 600_000)
    ).toEqual({
      label: "Fast-forwarding and checking out files",
      tone: "muted"
    });
  });

  it("outranks everything with the cancel the user just asked for", () => {
    expect(
      remoteActivityStatus(at({ canceling: true, lastOutputAt: 0 }), 300_000)
    ).toMatchObject({ label: "Stopping Git…" });
  });
});

describe("remoteActivityMeter", () => {
  it("renders Git's meter, including whatever label Git used", () => {
    expect(
      remoteActivityMeter(
        at({
          kind: "push",
          progress: {
            label: "Writing objects",
            percent: 62,
            completed: 62,
            total: 100,
            rate: "3.1 MiB/s"
          }
        })
      )
    ).toBe("Writing objects 62% · 3.1 MiB/s");
  });

  it("is null when Git is not metering anything", () => {
    expect(remoteActivityMeter(base)).toBeNull();
  });
});

describe("remoteActivityReport", () => {
  it("carries the diagnosis and the evidence to the clipboard", () => {
    expect(
      remoteActivityReport(
        at({ silent: true, command: "git fetch --prune --progress" }),
        [],
        300_000
      )
    ).toBe(
      [
        "Pull · PwrAgnt · main",
        "Contacting the remote — no response for 5m 00s (5m 00s elapsed)",
        "git fetch --prune --progress",
        "",
        "(Git has produced no output)"
      ].join("\n")
    );
  });
});

describe("elsewhereActivities", () => {
  const other = at({ id: "op-2", worktreeId: "worktree-2" });

  it("leaves the selected checkout to its own toolbar", () => {
    expect(
      elsewhereActivities([base, other], "worktree-1", 60_000)
    ).toEqual([other]);
  });

  it("keeps a repo-wide fetch, which no toolbar reports", () => {
    const repoWide = at({ id: "op-3", kind: "fetch", worktreeId: null });
    expect(
      elsewhereActivities([repoWide], "worktree-1", 60_000)
    ).toEqual([repoWide]);
  });

  it("waits out the short operations, which would only flicker", () => {
    expect(
      elsewhereActivities([other], "worktree-1", REMOTE_ACTIVITY_TOAST_AFTER_MS - 1)
    ).toEqual([]);
    expect(
      elsewhereActivities([other], "worktree-1", REMOTE_ACTIVITY_TOAST_AFTER_MS)
    ).toEqual([other]);
  });
});
