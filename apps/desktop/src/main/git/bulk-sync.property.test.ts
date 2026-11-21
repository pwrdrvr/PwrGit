import fc from "fast-check";
import { err, ok, type BulkSyncMode, type BulkSyncProgress } from "@pwrgit/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bulkSyncRepositories, type BulkSyncRepoInput } from "./bulk-sync";
import type { GitExec, GitExecOptions } from "./dugite";
import { PULL_OPERATION_TIMEOUT_MS, PULL_STALL_TIMEOUT_MS } from "./pull-watchdog";
import { logMain } from "../logs";

vi.mock("../logs", () => ({ logMain: vi.fn() }));

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function repository(index: number): BulkSyncRepoInput {
  return { id: `${index}`, name: `repo-${index}`, path: `/repos/${index}`, worktrees: [] };
}

/** A live Git child that settles only when its cancellation signal reaches it. */
function wedged(options: GitExecOptions | undefined): ReturnType<GitExec> {
  return new Promise((resolve) => {
    const abort = (): void => resolve(err({ kind: "git", code: "aborted", message: "stopped" }));
    if (options?.signal?.aborted) abort();
    else options?.signal?.addEventListener("abort", abort, { once: true });
  });
}

async function assertBatchTerminates(stalls: boolean[], concurrency: number, mode: BulkSyncMode): Promise<void> {
  const controller = new AbortController();
  const fetches: Array<{ cwd: string; remote: string; args: string[]; options?: GitExecOptions }> = [];
  const git: GitExec = async (args, cwd, options) => {
    if (args[0] === "remote") return ok({ stdout: "origin\nbackup\n", stderr: "", exitCode: 0 });
    if (args[0] === "config") return ok({ stdout: "", stderr: "", exitCode: 1 });
    if (args[0] !== "fetch") throw new Error(`Unexpected command: ${args[0]}`);
    const remote = args.at(-1)!;
    fetches.push({ cwd, remote, args, ...(options === undefined ? {} : { options }) });
    const index = Number(cwd.split("/").at(-1));
    if (stalls[index] && remote === "origin") return wedged(options);
    return ok({ stdout: "", stderr: "", exitCode: 0 });
  };
  let settled = false;
  const operation = bulkSyncRepositories(git, stalls.map((_, i) => repository(i)), {
    operationId: "stalled-batch", mode, concurrency, signal: controller.signal
  }).then((summary) => { settled = true; return summary; });
  try {
    // Even with one worker, every silent remote must fail and release its slot.
    await vi.advanceTimersByTimeAsync(PULL_STALL_TIMEOUT_MS * stalls.length + 1);
    expect(settled, "a silent remote must not keep the batch in flight indefinitely").toBe(true);
    const summary = await operation;
    expect(summary.cancelled).toBe(false);
    // Fetch counts fetched remotes as success; Try pull with no checkouts has
    // nothing to update, so it is skipped unless a remote failed.
    expect(summary.results.map((repo) => repo.outcome)).toEqual(stalls.map((stall) =>
      mode === "fetch" ? (stall ? "partial" : "success") : (stall ? "failed" : "skipped")
    ));
    for (const [index, repo] of summary.results.entries()) {
      expect(repo.remotes[0]).toMatchObject(stalls[index]
        ? { remote: "origin", outcome: "failed", reason: "fetch_failed", message: expect.stringContaining("no output") }
        : { remote: "origin", outcome: "fetched" });
      expect(repo.remotes[1]).toEqual({ remote: "backup", outcome: "fetched" });
    }
    expect(fetches).toHaveLength(stalls.length * 2);
    expect(fetches.every((fetch) => fetch.args.includes("--progress"))).toBe(true);
    expect(fetches.every((fetch) => fetch.options?.killSignal === "SIGKILL")).toBe(true);
  } finally {
    controller.abort();
    await operation;
  }
  expect(vi.getTimerCount()).toBe(0);
}

describe("bulk sync termination property", () => {
  // Rule: every silent Git command has a deadline, regardless of worker count,
  // mode or how many other repositories finish. Timeout is failure, not cancel;
  // subsequent remotes and repositories still get a turn.
  it("finishes any batch containing silent remotes and continues unrelated work", async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.boolean(), { minLength: 1, maxLength: 6 }).filter((stalls) => stalls.some(Boolean)),
      fc.integer({ min: 1, max: 3 }),
      fc.constantFrom<BulkSyncMode>("fetch", "soft-pull"),
      assertBatchTerminates
    ));
  });

  it("retires the last two stuck SSH fetches after other repositories finish", async () => {
    await assertBatchTerminates([false, true, true], 3, "soft-pull");
  });

  it("releases a single worker for the next repository when its first remote hangs", async () => {
    await assertBatchTerminates([true, false], 1, "fetch");
  });

  it("bounds a continuously noisy fetch too", async () => {
    const controller = new AbortController();
    let tick: ReturnType<typeof setInterval> | undefined;
    let settled = false;
    const git: GitExec = async (args, _cwd, options) => {
      if (args[0] === "remote") return ok({ stdout: "origin\n", stderr: "", exitCode: 0 });
      if (args[0] === "config") return ok({ stdout: "", stderr: "", exitCode: 1 });
      tick = setInterval(() => options?.onActivity?.(), PULL_STALL_TIMEOUT_MS / 2);
      return wedged(options);
    };
    const operation = bulkSyncRepositories(git, [repository(0)], {
      operationId: "noisy-fetch", mode: "fetch", signal: controller.signal
    }).then((summary) => { settled = true; return summary; });
    try {
      await vi.advanceTimersByTimeAsync(PULL_OPERATION_TIMEOUT_MS + 1);
      expect(settled).toBe(true);
      const summary = await operation;
      expect(summary.results[0]?.remotes[0]).toMatchObject({
        outcome: "failed", reason: "fetch_failed", message: expect.stringContaining("operation limit")
      });
    } finally {
      clearInterval(tick);
      controller.abort();
      await operation;
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not let output from a healthy concurrent fetch extend a silent fetch's deadline", async () => {
    const controller = new AbortController();
    const progress: BulkSyncProgress[] = [];
    let tick: ReturnType<typeof setInterval> | undefined;
    let finishHealthy!: () => void;
    const git: GitExec = async (args, cwd, options) => {
      if (args[0] === "remote") return ok({ stdout: "origin\n", stderr: "", exitCode: 0 });
      if (args[0] === "config") return ok({ stdout: "", stderr: "", exitCode: 1 });
      if (cwd === "/repos/1") return wedged(options);
      tick = setInterval(() => options?.onActivity?.(), PULL_STALL_TIMEOUT_MS / 3);
      await new Promise<void>((resolve) => { finishHealthy = resolve; });
      return ok({ stdout: "", stderr: "", exitCode: 0 });
    };
    const operation = bulkSyncRepositories(git, [repository(0), repository(1)], {
      operationId: "independent-clocks", mode: "fetch", signal: controller.signal,
      onProgress: (event) => progress.push(event)
    });
    try {
      await vi.advanceTimersByTimeAsync(PULL_STALL_TIMEOUT_MS + 1);
      expect(progress.filter((event) => event.phase === "repo_completed").map((event) => event.repoId)).toEqual(["1"]);
      finishHealthy();
      const summary = await operation;
      expect(summary.cancelled).toBe(false);
      expect(summary.results.map((repo) => repo.outcome)).toEqual(["success", "failed"]);
    } finally {
      clearInterval(tick);
      controller.abort();
      finishHealthy();
      await operation;
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds silent local probes as well as network transfers", async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom("remote", "config"), async (stalledCommand) => {
      let release: (() => void) | undefined;
      let settled = false;
      const git: GitExec = async (args, _cwd, options) => {
        if (args[0] === stalledCommand) {
          const result = wedged(options);
          // Test cleanup must also work against implementations that omitted
          // the signal on read-only probes.
          return Promise.race([result, new Promise<Awaited<ReturnType<GitExec>>>((resolve) => {
            release = () => resolve(err({ kind: "git", code: "aborted", message: "cleanup" }));
          })]);
        }
        return ok({ stdout: "origin\n", stderr: "", exitCode: 0 });
      };
      const operation = bulkSyncRepositories(git, [repository(0)], {
        operationId: "local-probe", mode: "fetch"
      }).then((summary) => { settled = true; return summary; });
      try {
        await vi.advanceTimersByTimeAsync(PULL_STALL_TIMEOUT_MS + 1);
        expect(settled).toBe(true);
        expect((await operation).counts.repos.failed).toBe(1);
      } finally {
        release?.();
        await operation;
      }
      expect(vi.getTimerCount()).toBe(0);
    }));
  });

  it("records whether Git exited or stayed alive, with credential-safe stderr evidence", async () => {
    await fc.assert(fc.asyncProperty(fc.boolean(), fc.stringMatching(/^[a-z]{8,15}$/), fc.nat(), fc.boolean(), async (exited, secret, split, complete) => {
      vi.mocked(logMain).mockClear();
      const controller = new AbortController();
      const git: GitExec = async (args, _cwd, options) => {
        if (args[0] === "remote") return ok({ stdout: "origin\n", stderr: "", exitCode: 0 });
        if (args[0] === "config") return ok({ stdout: "", stderr: "", exitCode: 1 });
        options?.onProcess?.({ event: "spawn", pid: 123, exitCode: null, signalCode: null });
        const output = complete ? `remote: https://operator:${secret}@example.test/repo.git\n` : `remote: https://operator:${secret}`;
        const boundary = split % output.length;
        options?.onStderr?.(output.slice(0, boundary));
        options?.onStderr?.(output.slice(boundary));
        if (exited) options?.onProcess?.({ event: "exit", pid: 123, exitCode: 0, signalCode: null });
        return wedged(options);
      };
      const operation = bulkSyncRepositories(git, [repository(0)], {
        operationId: "diagnostics", mode: "fetch", signal: controller.signal
      });
      try {
        await vi.advanceTimersByTimeAsync(PULL_STALL_TIMEOUT_MS + 1);
        const logs = vi.mocked(logMain).mock.calls.map((call) => call[2]).join("\n");
        expect(logs).toContain(`pid=123 event=${exited ? "exit" : "spawn"} exit=${exited ? "0" : "none"}`);
        expect(logs).toContain(complete ? "https://[redacted]@example.test/repo.git" : "unfinished stderr withheld");
        expect(logs).not.toContain(secret);
      } finally {
        controller.abort();
        await operation;
      }
      expect(vi.getTimerCount()).toBe(0);
    }));
  });
});

describe("bulk sync start order property", () => {
  // Rule: a pull starts every repository already known to have a pending
  // fast-forward before any other repository, whatever the worker count; each
  // group keeps its input order, and results stay in input order. A fetch has
  // no known work to favour and starts in input order.
  it("starts known pulls first and reports in input order", async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.boolean(), { minLength: 1, maxLength: 8 }),
      fc.integer({ min: 1, max: 3 }),
      fc.constantFrom<BulkSyncMode>("fetch", "soft-pull"),
      async (pending, concurrency, mode) => {
        const repos = pending.map((flag, index) => ({
          ...repository(index),
          ...(flag ? { pullPending: true } : {})
        }));
        const started: string[] = [];
        const git: GitExec = async (args) => {
          if (args[0] === "remote") return ok({ stdout: "origin\n", stderr: "", exitCode: 0 });
          if (args[0] === "config") return ok({ stdout: "", stderr: "", exitCode: 1 });
          return ok({ stdout: "", stderr: "", exitCode: 0 });
        };
        const summary = await bulkSyncRepositories(git, repos, {
          operationId: "start-order", mode, concurrency,
          onProgress: (event) => {
            if (event.phase === "repo_started") started.push(event.repoId!);
          }
        });
        const ids = repos.map((repo) => repo.id);
        // Oracle: a stable partition of the input, computed independently.
        const expected = mode === "fetch"
          ? ids
          : [...ids.filter((_, i) => pending[i]), ...ids.filter((_, i) => !pending[i])];
        expect(started).toEqual(expected);
        expect(summary.results.map((result) => result.repoId)).toEqual(ids);
      }
    ));
  });
});
