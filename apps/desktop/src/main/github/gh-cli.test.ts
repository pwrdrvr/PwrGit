import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const childProcess = vi.hoisted(() => ({
  execFile: vi.fn(),
  spawn: vi.fn()
}));

vi.mock("node:child_process", () => childProcess);

import { runGh } from "./gh-cli";

describe("runGh", () => {
  beforeEach(() => vi.clearAllMocks());

  it("streams progress without using execFile's bounded stderr buffer", async () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child = Object.assign(new EventEmitter(), {
      stdout,
      stderr,
      kill: vi.fn()
    });
    childProcess.spawn.mockReturnValue(child);
    const received: string[] = [];

    const result = runGh(["repo", "clone", "owner/repo"], {
      timeoutMs: 1_000,
      onStderr: (chunk) => received.push(chunk),
      env: { LC_ALL: "C" }
    });
    const progress = "x".repeat(600 * 1024);
    stderr.emit("data", progress);
    stderr.emit("data", progress);
    stdout.emit("data", "done\n");
    child.emit("close", 0, null);

    await expect(result).resolves.toBe("done");
    expect(received.join("")).toHaveLength(1_200 * 1024);
    expect(childProcess.spawn).toHaveBeenCalledWith(
      "gh",
      ["repo", "clone", "owner/repo"],
      expect.objectContaining({
        env: expect.objectContaining({ LC_ALL: "C" })
      })
    );
    expect(childProcess.execFile).not.toHaveBeenCalled();
  });
});
