import { afterEach, describe, expect, it, vi } from "vitest";
import { CommitAssociationMonitor } from "./commit-association-monitor";

let monitor: CommitAssociationMonitor | undefined;

afterEach(() => monitor?.stop());

describe("CommitAssociationMonitor", () => {
  it("polls the union of visible unassociated commits", async () => {
    const refresh = vi.fn(async (_repoId: string, _hashes: string[]) => {});
    monitor = new CommitAssociationMonitor({ refresh });
    monitor.replace("view-a", "repo", ["one", "shared"]);
    monitor.replace("view-b", "repo", ["shared", "two"]);

    await monitor.pollNow();
    expect(refresh).toHaveBeenCalledOnce();
    expect(new Set(refresh.mock.calls[0]?.[1])).toEqual(
      new Set(["one", "shared", "two"])
    );
  });
});
