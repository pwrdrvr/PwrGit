import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PR_STATUS_POLL_INTERVAL_MS,
  PrStatusMonitor
} from "./pr-status-monitor";

let monitor: PrStatusMonitor | undefined;

afterEach(() => {
  monitor?.stop();
  monitor = undefined;
  vi.useRealTimers();
});

describe("PrStatusMonitor", () => {
  it("atomically replaces one reason and deduplicates cumulative overlap", async () => {
    const refresh = vi.fn(async (_repoId: string, _numbers: number[]) => {});
    monitor = new PrStatusMonitor({ refresh });
    monitor.replace("commit-list", [
      { repoId: "repo", number: 1 },
      { repoId: "repo", number: 2 }
    ]);
    monitor.replace("worktree", [
      { repoId: "repo", number: 2 },
      { repoId: "repo", number: 3 }
    ]);

    monitor.replace("commit-list", [
      { repoId: "repo", number: 3 },
      { repoId: "repo", number: 4 }
    ]);
    await monitor.pollNow();

    expect(refresh).toHaveBeenCalledOnce();
    expect(new Set(refresh.mock.calls[0]?.[1])).toEqual(new Set([2, 3, 4]));
  });

  it("continues until the final reason for a PR disappears", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn(async (_repoId: string, _numbers: number[]) => {});
    monitor = new PrStatusMonitor({ refresh });
    const target = { repoId: "repo", number: 29 };
    monitor.replace("commit-list", [target]);
    monitor.replace("worktree", [target]);
    monitor.replace("commit-list", []);

    await vi.advanceTimersByTimeAsync(PR_STATUS_POLL_INTERVAL_MS);
    expect(refresh).toHaveBeenCalledOnce();

    monitor.replace("worktree", []);
    refresh.mockClear();
    await vi.advanceTimersByTimeAsync(PR_STATUS_POLL_INTERVAL_MS);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("polls one PR once even when many commit associations request it", async () => {
    const refresh = vi.fn(async (_repoId: string, _numbers: number[]) => {});
    monitor = new PrStatusMonitor({ refresh });
    monitor.replace("visible commits", Array.from({ length: 20 }, () => ({
      repoId: "repo",
      number: 29
    })));

    await monitor.pollNow();
    expect(refresh).toHaveBeenCalledWith("repo", [29]);
  });
});
