import { describe, expect, it, vi } from "vitest";
import { err, ok, type PwrGitError } from "@pwrgit/shared";
import type { GitExec, GitOutput } from "./dugite";
import { pullFastForward } from "./git-service";

const output = (stdout = ""): ReturnType<typeof ok<GitOutput>> =>
  ok({ stdout, stderr: "", exitCode: 0 });

describe("pullFastForward timeout recovery", () => {
  it("uses a fresh bounded signal after primary merge timeout", async () => {
    const primaryTimeout: PwrGitError = {
      kind: "remote",
      code: "pull_stalled",
      message: "primary merge stalled"
    };
    const recoveryTimeout: PwrGitError = {
      kind: "remote",
      code: "pull_stalled",
      message: "rollback/recovery stalled"
    };
    const primary = new AbortController();
    const recovery = new AbortController();
    const finishRecovery = vi.fn();
    const seenSignals: Array<AbortSignal | undefined> = [];
    const git: GitExec = vi.fn(async (args, _cwd, options) => {
      if (args[0] === "rev-parse") return output("a".repeat(40));
      if (args[0] === "fetch") return output();
      if (args[0] === "diff") return output();
      if (args[0] === "status") return output();
      seenSignals.push(options?.signal);
      if (args[0] === "merge") {
        expect(options?.killSignal).toBe("SIGKILL");
        primary.abort(primaryTimeout);
        return err(primaryTimeout);
      }
      if (args[0] === "reset") {
        expect(options?.killSignal).toBe("SIGKILL");
        recovery.abort(recoveryTimeout);
        return err(recoveryTimeout);
      }
      throw new Error(`unexpected git command: ${args.join(" ")}`);
    });

    const result = await pullFastForward(git, "/repos/project", undefined, {
      signal: primary.signal,
      startRecovery: () => ({
        signal: recovery.signal,
        finish: finishRecovery
      })
    });

    expect(result).toEqual(err(recoveryTimeout));
    expect(seenSignals).toEqual([primary.signal, recovery.signal]);
    expect(finishRecovery).toHaveBeenCalledExactlyOnceWith(false);
  });
});
