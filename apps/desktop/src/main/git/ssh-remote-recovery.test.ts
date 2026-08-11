import { describe, expect, it, vi } from "vitest";
import {
  err,
  ok,
  type PwrGitError,
  type SshRemoteRecovery
} from "@pwrgit/shared";
import type { GitExec, GitOutput } from "./dugite";
import {
  applySshRemoteRecovery,
  githubHttpsToSsh,
  inspectSshRemoteRecovery,
  SSH_RECOVERY_COMMAND,
  testSshRemoteRecovery
} from "./ssh-remote-recovery";

function output(
  stdout = "",
  exitCode = 0,
  stderr = ""
): ReturnType<GitExec> {
  return Promise.resolve(ok({ stdout, stderr, exitCode } satisfies GitOutput));
}

const recovery: SshRemoteRecovery = {
  remote: "origin",
  httpsUrl: "https://github.com/pwrdrvr/PwrAgent.git",
  sshUrl: "git@github.com:pwrdrvr/PwrAgent.git",
  pushUrlWillAlsoChange: true
};

function configuredGit(options: { explicitPushUrl?: string } = {}): GitExec {
  return vi.fn((args) => {
    const command = args.join(" ");
    if (command === "branch --show-current") return output("main\n");
    if (command === "config --get branch.main.remote") return output("origin\n");
    if (command === "remote get-url origin") return output(`${recovery.httpsUrl}\n`);
    if (command === "config --get-all remote.origin.pushurl") {
      return options.explicitPushUrl === undefined
        ? output("", 1)
        : output(`${options.explicitPushUrl}\n`);
    }
    if (command === `ls-remote --symref ${recovery.sshUrl} HEAD`) {
      return output("ref: refs/heads/main\tHEAD\n");
    }
    if (command === `remote set-url origin ${recovery.sshUrl}`) return output();
    throw new Error(`unexpected git command: ${command}`);
  });
}

describe("GitHub SSH remote recovery", () => {
  it("converts only credential-free github.com HTTPS repository URLs", () => {
    expect(githubHttpsToSsh("https://github.com/pwrdrvr/PwrAgent.git")).toBe(
      "git@github.com:pwrdrvr/PwrAgent.git"
    );
    expect(githubHttpsToSsh("https://github.com/pwrdrvr/PwrAgent/")).toBe(
      "git@github.com:pwrdrvr/PwrAgent.git"
    );
    expect(githubHttpsToSsh("http://github.com/pwrdrvr/PwrAgent.git")).toBeNull();
    expect(githubHttpsToSsh("https://token@github.com/pwrdrvr/PwrAgent.git")).toBeNull();
    expect(githubHttpsToSsh("https://example.com/pwrdrvr/PwrAgent.git")).toBeNull();
  });

  it("inspects the checked-out branch without contacting a remote", async () => {
    const git = configuredGit();

    await expect(inspectSshRemoteRecovery(git, "/repo")).resolves.toEqual(
      ok(recovery)
    );
    expect(vi.mocked(git).mock.calls.flatMap(([args]) => args)).not.toContain(
      "ls-remote"
    );
  });

  it("tests SSH with ignored prompts without fetching or changing refs", async () => {
    const git = configuredGit();

    await expect(
      testSshRemoteRecovery(git, "/repo", recovery)
    ).resolves.toEqual(ok(undefined));
    const testCall = vi
      .mocked(git)
      .mock.calls.find(([args]) => args[0] === "ls-remote");
    expect(testCall).toEqual([
      ["ls-remote", "--symref", recovery.sshUrl, "HEAD"],
      "/repo",
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        killSignal: "SIGKILL",
        env: { GIT_SSH_COMMAND: SSH_RECOVERY_COMMAND }
      })
    ]);
    expect(vi.mocked(git).mock.calls.some(([args]) => args[0] === "fetch")).toBe(
      false
    );
  });

  it("rejects a stale or renderer-modified candidate before network access", async () => {
    const git = configuredGit();

    const result = await testSshRemoteRecovery(git, "/repo", {
      ...recovery,
      sshUrl: "git@example.com:someone/else.git"
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "remote_changed" }
    });
    expect(vi.mocked(git).mock.calls.some(([args]) => args[0] === "ls-remote")).toBe(
      false
    );
  });

  it("bounds a silent SSH probe", async () => {
    vi.useFakeTimers();
    const base = configuredGit();
    const git: GitExec = vi.fn((args, cwd, options) => {
      if (args[0] !== "ls-remote") return base(args, cwd, options);
      return new Promise<Awaited<ReturnType<GitExec>>>((resolve) => {
        options?.signal?.addEventListener(
          "abort",
          () => resolve(err(options.signal?.reason as PwrGitError)),
          { once: true }
        );
      });
    });

    const pending = testSshRemoteRecovery(git, "/repo", recovery, 250);
    await vi.advanceTimersByTimeAsync(250);
    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: "ssh_test_timed_out" }
    });
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("changes only the fetch URL and preserves an explicit push URL", async () => {
    const git = configuredGit({
      explicitPushUrl: "git@github.com:pwrdrvr/PwrAgent-write.git"
    });
    const reviewed = { ...recovery, pushUrlWillAlsoChange: false };

    await expect(
      applySshRemoteRecovery(git, "/repo", reviewed)
    ).resolves.toEqual(ok(undefined));
    expect(git).toHaveBeenCalledWith(
      ["remote", "set-url", "origin", recovery.sshUrl],
      "/repo"
    );
    expect(
      vi.mocked(git).mock.calls.some(
        ([args]) =>
          args.includes("--push") ||
          (args.includes("pushurl") && args.includes("--replace-all"))
      )
    ).toBe(false);
  });
});
