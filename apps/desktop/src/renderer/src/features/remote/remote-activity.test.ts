import { describe, expect, it } from "vitest";
import type { RemoteActivity } from "@pwrgit/shared";
import {
  activitySteps,
  formatElapsed,
  liveActivityView,
  remoteActivityMeter,
  remoteActivityReport,
  remoteActivityStatus,
  remoteActivityTitle,
  settledActivityView,
  REMOTE_ACTIVITY_QUIET_MS,
  type RemoteActivityOutcome
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
        liveActivityView(
          at({ silent: true, command: "git fetch --prune --progress" }),
          300_000
        ),
        []
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

describe("liveActivityView", () => {
  it("carries the live operation, and the cancel that addresses it", () => {
    expect(
      liveActivityView(
        at({
          command: "git fetch --prune --progress",
          tail: ["remote: Counting objects: 100% (12/12), done."],
          // Recent enough that the quiet warning is not what is under test.
          lastOutputAt: 40_000,
          progress: {
            label: "Receiving objects",
            percent: 43,
            completed: 860,
            total: 2000
          }
        }),
        41_000
      )
    ).toEqual({
      operationId: "op-1",
      title: "Pull · PwrAgnt · main",
      elapsed: "41s",
      statusLabel: "Fetching updates",
      // No history handed in, so nothing to list — the toast's case, and the
      // card falls back to the status line above.
      steps: [],
      statusTone: "muted",
      meter: "Receiving objects 43%",
      percent: 43,
      command: "git fetch --prune --progress",
      output: ["remote: Counting objects: 100% (12/12), done."],
      canceling: false,
      settled: null
    });
  });
});

describe("activitySteps", () => {
  // `queued` is waiting on another operation's lock, `prepare` is a
  // `git status` main emits whether or not there is anything to stash, and
  // `refresh` is PwrGit's own bookkeeping. None is an outcome, and a receipt
  // reading "Checked for local changes" between two real steps is noise in
  // the one place a user reads carefully.
  it("gives a row to work and nothing to bookkeeping", () => {
    const steps = activitySteps(
      ["queued", "fetch", "prepare", "fast_forward", "reapply", "refresh"],
      null
    );
    expect(steps.map((step) => step.label)).toEqual([
      "Fetched",
      "Fast-forwarded",
      "Reapplied your changes"
    ]);
  });

  // The row under the eye is the one that must not move: only the marker
  // turns, and the transfer readout it carried goes with it.
  it("names only the current step in the present tense", () => {
    const steps = activitySteps(["fetch", "fast_forward"], "fast_forward", {
      detail: "Resolving deltas 62%",
      percent: 62
    });
    expect(steps).toEqual([
      {
        phase: "fetch",
        label: "Fetched",
        detail: null,
        percent: null,
        state: "done"
      },
      {
        phase: "fast_forward",
        label: "Fast-forwarding",
        detail: "Resolving deltas 62%",
        percent: 62,
        state: "running"
      }
    ]);
  });

  it("has nothing to say about an operation with no phases yet", () => {
    expect(activitySteps([], null)).toEqual([]);
  });
});

describe("settledActivityView", () => {
  const ended: RemoteActivityOutcome = {
    kind: "pull",
    status: "ok",
    repoName: "PwrAgnt",
    branch: "main",
    startedAt: 1_000,
    endedAt: 3_400,
    summary: "Fast-forwarded",
    command: "git merge --ff-only origin/main",
    output: ["Fast-forward"],
    steps: activitySteps(["fetch", "prepare", "fast_forward"], "fast_forward")
  };

  it("reads the elapsed off the operation, not off a clock that moved on", () => {
    expect(settledActivityView(ended).elapsed).toBe("2s");
  });

  // The receipt IS the running card, with every marker turned — which is what
  // makes it readable without re-reading: the rows have not moved.
  it("turns the step that was still running when it ended", () => {
    expect(
      settledActivityView(ended).steps.map((step) => [step.label, step.state])
    ).toEqual([
      ["Fetched", "done"],
      ["Fast-forwarded", "done"]
    ]);
  });

  it("drops the meter and the cancel — there is nothing left to do to it", () => {
    const view = settledActivityView(ended);
    expect(view.meter).toBeNull();
    expect(view.percent).toBeNull();
    expect(view.canceling).toBeNull();
    expect(view.operationId).toBeNull();
  });

  it("gives success and failure tones the card can tell apart", () => {
    expect(settledActivityView(ended).statusTone).toBe("ok");
    expect(settledActivityView({ ...ended, status: "error" }).statusTone).toBe(
      "bad"
    );
  });

  // The user stopped it themselves a second ago and is looking at the button
  // they pressed. Dressing their own decision in the failure color is the same
  // mistake `flashError` already avoids for the toast.
  it("keeps a cancel muted rather than dressing it as a failure", () => {
    expect(
      settledActivityView({ ...ended, status: "canceled" }).statusTone
    ).toBe("muted");
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
