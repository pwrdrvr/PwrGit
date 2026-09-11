import { afterEach, describe, expect, it, vi } from "vitest";
import type { RemoteActivity } from "@pwrgit/shared";
import {
  gitCommandLabel,
  parseTransferProgress,
  RemoteActivityRegistry,
  REMOTE_ACTIVITY_COMMAND_CHARS,
  REMOTE_ACTIVITY_LOG_LINES,
  REMOTE_ACTIVITY_TAIL_LINES
} from "./remote-activity";

const input = {
  kind: "fetch" as const,
  profileId: "profile-1",
  repoId: "repo-1",
  repoName: "PwrAgnt",
  worktreeId: "worktree-1",
  branch: "main"
};

function registry(emitIntervalMs = 10) {
  const emit = vi.fn<(activities: RemoteActivity[]) => void>();
  const log = vi.fn();
  return {
    emit,
    log,
    registry: new RemoteActivityRegistry({ emit, log, emitIntervalMs }),
    /** The most recently emitted record for the single live operation. */
    latest: (): RemoteActivity => {
      const last = emit.mock.calls.at(-1);
      if (last === undefined) throw new Error("nothing emitted");
      const activity = last[0][0];
      if (activity === undefined) throw new Error("no live activity emitted");
      return activity;
    }
  };
}

describe("parseTransferProgress", () => {
  it("reads the meter Git prints for any labelled phase", () => {
    expect(
      parseTransferProgress(
        "Receiving objects:  43% (860/2000), 12.4 MiB | 3.1 MiB/s"
      )
    ).toEqual({
      label: "Receiving objects",
      percent: 43,
      completed: 860,
      total: 2000,
      bytes: "12.4 MiB",
      rate: "3.1 MiB/s"
    });
  });

  it("reads push's own meter and a remote-prefixed one", () => {
    // Push prints `Writing objects`; a label list built for clone would draw
    // no meter at all for the entire upload.
    expect(parseTransferProgress("Writing objects:  70% (7/10)")).toMatchObject({
      label: "Writing objects",
      percent: 70
    });
    expect(
      parseTransferProgress("remote: Compressing objects:  12% (3/25)")
    ).toMatchObject({ label: "Compressing objects", percent: 12 });
  });

  it("is not fooled by ordinary Git prose", () => {
    expect(parseTransferProgress("From github.com:pwrdrvr/PwrAgnt")).toBeNull();
    expect(parseTransferProgress("fatal: could not read Username")).toBeNull();
  });
});

describe("RemoteActivityRegistry", () => {
  afterEach(() => vi.useRealTimers());

  it("reports the wait for a repository lock as queued, not as work", () => {
    const { registry: activities, emit, latest } = registry();
    const handle = activities.begin(input);

    // Queued is the state the old spinner could not express: the reason a
    // pull can sit for a minute having run no Git at all.
    expect(latest()).toMatchObject({ phase: "queued", silent: true });

    handle.setPhase("fetch");
    expect(latest()).toMatchObject({ phase: "fetch" });
    expect(emit).toHaveBeenCalledTimes(2);

    handle.finish();
    expect(emit.mock.calls.at(-1)?.[0]).toEqual([]);
    expect(activities.list()).toEqual([]);
  });

  it("splits Git output on CR as well as LF and keeps the partial line", () => {
    vi.useFakeTimers();
    const { registry: activities, latest } = registry();
    const handle = activities.begin(input);
    handle.setPhase("fetch");

    handle.onStderr("remote: Enumerating objects: 25\nremote: Total 4 (delta");
    vi.advanceTimersByTime(20);
    expect(latest().tail).toEqual(["remote: Enumerating objects: 25"]);

    handle.onStderr(" 1)\r");
    vi.advanceTimersByTime(20);
    expect(latest().tail).toEqual([
      "remote: Enumerating objects: 25",
      "remote: Total 4 (delta 1)"
    ]);
  });

  it("collapses a repeating meter into one row and tracks its progress", () => {
    vi.useFakeTimers();
    const { registry: activities, latest } = registry();
    const handle = activities.begin(input);
    handle.setPhase("fetch");

    handle.onStderr("From github.com:pwrdrvr/PwrAgnt\n");
    for (const percent of [10, 40, 90]) {
      handle.onStderr(`Receiving objects: ${percent}% (${percent}/100)\r`);
    }
    vi.advanceTimersByTime(20);

    // Left to accumulate, one fetch buries every actionable `remote:` line
    // under a hundred repaints of the same meter.
    expect(latest().tail).toEqual([
      "From github.com:pwrdrvr/PwrAgnt",
      "Receiving objects: 90% (90/100)"
    ]);
    expect(latest().progress).toMatchObject({
      label: "Receiving objects",
      percent: 90
    });
    expect(activities.logFor(handle.id)).toEqual(latest().tail);
  });

  it("starts a new row when the meter's label changes", () => {
    vi.useFakeTimers();
    const { registry: activities, latest } = registry();
    const handle = activities.begin(input);
    handle.onStderr("Receiving objects: 100% (100/100)\r");
    handle.onStderr("Resolving deltas: 50% (5/10)\r");
    vi.advanceTimersByTime(20);

    expect(latest().tail).toEqual([
      "Receiving objects: 100% (100/100)",
      "Resolving deltas: 50% (5/10)"
    ]);
  });

  it("drops the meter when the phase moves on", () => {
    vi.useFakeTimers();
    const { registry: activities, latest } = registry();
    const handle = activities.begin(input);
    handle.setPhase("fetch");
    handle.onStderr("Receiving objects: 100% (100/100)\r");
    vi.advanceTimersByTime(20);
    expect(latest().progress).not.toBeNull();

    // A meter left standing across a phase change describes finished work as
    // if it were the work now running.
    handle.setPhase("fast_forward");
    expect(latest().progress).toBeNull();
  });

  it("records liveness, so silence is distinguishable from a slow transfer", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { registry: activities, latest } = registry();
    const handle = activities.begin(input);
    expect(latest()).toMatchObject({ silent: true, lastOutputAt: 1_000 });

    vi.setSystemTime(61_000);
    handle.onStderr("remote: Counting objects: 1\n");
    vi.advanceTimersByTime(20);
    expect(latest()).toMatchObject({ silent: false, lastOutputAt: 61_000 });
  });

  it("restarts the silence clock for each command, not once per operation", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { registry: activities, latest } = registry();
    const handle = activities.begin(input);

    // A pull runs `rev-parse` before it fetches. That one line of stdout must
    // not be taken as evidence that the fetch after it is alive — which is
    // exactly how a remote that never answered read as a healthy slow one.
    handle.setCommand(["rev-parse", "--verify", "HEAD"]);
    handle.onStderr("");
    handle.onActivity();
    vi.advanceTimersByTime(20);
    expect(latest().silent).toBe(false);

    vi.setSystemTime(2_000);
    handle.setCommand(["fetch", "--prune", "--progress"]);
    vi.advanceTimersByTime(20);
    expect(latest()).toMatchObject({ silent: true, lastOutputAt: 2_000 });
  });

  it("bounds both buffers and redacts credentials out of Git's output", () => {
    vi.useFakeTimers();
    const { registry: activities, latest } = registry();
    const handle = activities.begin(input);
    for (let i = 0; i < REMOTE_ACTIVITY_LOG_LINES + 20; i += 1) {
      handle.onStderr(`line ${i}\n`);
    }
    handle.onStderr("fatal: https://alice:hunter2@example.com/x.git failed\n");
    vi.advanceTimersByTime(20);

    expect(latest().tail).toHaveLength(REMOTE_ACTIVITY_TAIL_LINES);
    expect(activities.logFor(handle.id)).toHaveLength(
      REMOTE_ACTIVITY_LOG_LINES
    );
    expect(latest().tail.at(-1)).toBe(
      "fatal: https://[redacted]@example.com/x.git failed"
    );
  });

  it("keeps a command line short enough to read", () => {
    // Pull's rollback passes a runBatched pathspec list that reaches ~32KB.
    // The head names the command; the tail is unreadable mid-path text nobody
    // wants broadcast to every window.
    const label = gitCommandLabel([
      "checkout",
      "--",
      ...Array.from({ length: 400 }, (_, i) => `src/very/long/path/file-${i}.ts`)
    ]);
    expect(label.length).toBeLessThan(REMOTE_ACTIVITY_COMMAND_CHARS + 24);
    expect(label).toMatch(/^git checkout -- /);
    expect(label).toMatch(/… \(\+\d+ more\)$/);
    expect(gitCommandLabel(["fetch", "--prune", "--progress"])).toBe(
      "git fetch --prune --progress"
    );
  });

  it("names the Git command now running", () => {
    vi.useFakeTimers();
    const { registry: activities, latest } = registry();
    const handle = activities.begin(input);
    handle.setCommand(["fetch", "--prune", "--progress"]);
    vi.advanceTimersByTime(20);

    // Five silent minutes are far easier to act on when the status says which
    // command produced no output.
    expect(latest().command).toBe("git fetch --prune --progress");
    expect(handle.command()).toBe("git fetch --prune --progress");
    handle.setCommand(null);
    vi.advanceTimersByTime(20);
    expect(latest().command).toBeNull();
  });

  it("flushes Git's last line when it arrived without a newline", () => {
    vi.useFakeTimers();
    const { registry: activities, log } = registry();
    const handle = activities.begin(input);
    // Git's final message is routinely the most useful one and routinely
    // unterminated — a `fatal:` as the process dies, or a stream cut mid-line.
    handle.onStderr("fatal: could not read from remote repository");
    vi.advanceTimersByTime(20);
    expect(log).not.toHaveBeenCalledWith("info", expect.stringContaining("fatal"));

    handle.finish();
    expect(log).toHaveBeenCalledWith(
      "info",
      "PwrAgnt: fatal: could not read from remote repository"
    );
  });

  it("ignores output that arrives after the operation is retired", () => {
    vi.useFakeTimers();
    const { registry: activities, emit } = registry();
    const handle = activities.begin(input);
    handle.finish();
    const emitted = emit.mock.calls.length;

    // A killed Git child can still flush after the handler has returned.
    handle.onStderr("remote: too late\n");
    handle.onActivity();
    vi.advanceTimersByTime(20);

    expect(emit).toHaveBeenCalledTimes(emitted);
    expect(activities.logFor(handle.id)).toBeNull();
  });

  it("cancels with a typed reason and keeps the record until Git exits", () => {
    const { registry: activities, latest } = registry();
    const handle = activities.begin(input);
    const aborted = vi.fn();
    handle.signal.addEventListener("abort", aborted);

    expect(activities.cancel(handle.id, "Stopped at your request.")).toBe(true);

    expect(aborted).toHaveBeenCalledOnce();
    expect(handle.signal.reason).toEqual({
      kind: "remote",
      code: "canceled",
      message: "Stopped at your request."
    });
    // Pull still has a rollback to run. Dropping the row here would take the
    // status away at the moment it matters most.
    expect(latest()).toMatchObject({ canceling: true });
    expect(activities.cancel(handle.id, "again")).toBe(true);
    expect(aborted).toHaveBeenCalledOnce();
  });

  it("refuses to cancel an operation it no longer has", () => {
    const { registry: activities } = registry();
    const handle = activities.begin(input);
    handle.finish();

    expect(activities.cancel(handle.id, "gone")).toBe(false);
    expect(activities.logFor(handle.id)).toBeNull();
  });

  it("logs Git's messages but throttles its meter", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { registry: activities, log } = registry();
    const handle = activities.begin(input);

    handle.onStderr("remote: Support for password authentication removed\n");
    for (let i = 0; i < 40; i += 1) {
      handle.onStderr(`Receiving objects: ${i}% (${i}/100)\r`);
    }

    expect(log).toHaveBeenCalledWith(
      "info",
      "PwrAgnt: remote: Support for password authentication removed"
    );
    // A meter repaints faster than any log is worth writing; one sample stands
    // in for the burst.
    expect(log.mock.calls.filter(([level]) => level === "debug")).toHaveLength(
      1
    );
  });
});
