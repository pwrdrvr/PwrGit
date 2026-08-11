import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const childProcess = vi.hoisted(() => ({
  spawn: vi.fn()
}));

vi.mock("node:child_process", () => childProcess);

import { ghEnvironment, runGh } from "./gh-cli";

function streamingChild(): EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
} {
  return Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn()
  });
}

describe("runGh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("forces a non-interactive base environment", () => {
    expect(ghEnvironment()).toMatchObject({
      GH_PROMPT_DISABLED: "1",
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never"
    });
    expect(ghEnvironment()).not.toHaveProperty("GIT_SSH_COMMAND");
  });

  it("streams with ignored stdin and protected prompt guards", async () => {
    const child = streamingChild();
    childProcess.spawn.mockReturnValue(child);
    const received: string[] = [];

    const result = runGh(["repo", "clone", "owner/repo"], {
      timeoutMs: 1_000,
      onStderr: (chunk) => received.push(chunk),
      env: {
        LC_ALL: "C",
        GH_PROMPT_DISABLED: "0",
        GIT_TERMINAL_PROMPT: "1",
        GCM_INTERACTIVE: "Always"
      }
    });
    const progress = "x".repeat(600 * 1024);
    child.stderr.emit("data", `${progress}\r`);
    child.stderr.emit("data", `${progress}\r`);
    child.stdout.emit("data", "done\n");
    child.emit("close", 0, null);

    await expect(result).resolves.toBe("done");
    expect(received.join("")).toBe(`${progress}\r${progress}\r`);
    expect(childProcess.spawn).toHaveBeenCalledWith(
      "gh",
      ["repo", "clone", "owner/repo"],
      expect.objectContaining({
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        env: expect.objectContaining({
          LC_ALL: "C",
          GH_PROMPT_DISABLED: "1",
          GIT_TERMINAL_PROMPT: "0",
          GCM_INTERACTIVE: "Never"
        })
      })
    );
  });

  it("runs buffered calls detached with ignored stdin and protected guards", async () => {
    const child = streamingChild();
    childProcess.spawn.mockReturnValue(child);

    const result = runGh(["repo", "view", "owner/repo"], {
      env: { GH_PROMPT_DISABLED: "0" }
    });
    child.stdout.emit("data", "ready\n");
    child.emit("close", 0, null);

    await expect(result).resolves.toBe("ready");
    expect(childProcess.spawn).toHaveBeenCalledWith(
      "gh",
      ["repo", "view", "owner/repo"],
      expect.objectContaining({
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        env: expect.objectContaining({
          GH_PROMPT_DISABLED: "1",
          GIT_TERMINAL_PROMPT: "0",
          GCM_INTERACTIVE: "Never"
        })
      })
    );
  });

  it("preserves successful token stdout for the in-process token client", async () => {
    const child = streamingChild();
    childProcess.spawn.mockReturnValue(child);
    const token = "gho_successfulCredential123";

    const result = runGh(["auth", "token"]);
    child.stdout.emit("data", `${token}\n`);
    child.emit("close", 0, null);

    await expect(result).resolves.toBe(token);
  });

  it("maps authentication failures without exposing credentials", async () => {
    const child = streamingChild();
    childProcess.spawn.mockReturnValue(child);
    const secret = "gho_superSecretCredential123";

    const result = runGh(["api", "user"], {
      env: { GH_TOKEN: secret }
    });
    child.stdout.emit("data", `debug token=${secret}`);
    child.stderr.emit(
      "data",
      `HTTP 401: Bad credentials (${secret})\nrun gh auth login`
    );
    child.emit("close", 1, null);
    const failure = await result.catch((cause: unknown) => cause);

    expect(failure).toMatchObject({
      name: "GhCliError",
      code: "authentication_required",
      message:
        "GitHub authentication is required. Run gh auth login and verify your Git/SSH credentials, then try again."
    });
    expect(JSON.stringify(failure)).not.toContain(secret);
    const diagnostics = failure as { stdout: string; stderr: string };
    expect(diagnostics.stdout).toContain("[REDACTED]");
    expect(diagnostics.stderr).toContain("[REDACTED]");
  });

  it("sanitizes streamed diagnostics before callbacks or errors", async () => {
    const child = streamingChild();
    childProcess.spawn.mockReturnValue(child);
    const received: string[] = [];
    const secret = "github_pat_superSecretCredential123";

    const result = runGh(["repo", "clone", "owner/private"], {
      onStderr: (chunk) => received.push(chunk),
      env: { GITHUB_TOKEN: secret }
    });
    child.stderr.emit(
      "data",
      `fatal: Authentication failed for https://user:${secret}@github.com/owner/private\n`
    );
    child.emit("close", 1, null);
    const failure = await result.catch((cause: unknown) => cause);

    expect(received.join("")).not.toContain(secret);
    expect(received.join("")).toContain("[REDACTED]");
    expect(JSON.stringify(failure)).not.toContain(secret);
    expect(failure).toMatchObject({ code: "authentication_required" });
  });

  it("redacts a streamed credential split across chunks", async () => {
    const child = streamingChild();
    childProcess.spawn.mockReturnValue(child);
    const received: string[] = [];
    const secret = "gho_splitCredential123";

    const result = runGh(["repo", "clone", "owner/private"], {
      onStderr: (chunk) => received.push(chunk),
      env: { GH_TOKEN: secret }
    });
    child.stderr.emit("data", `fatal: token ${secret.slice(0, 9)}`);
    expect(received).toEqual([]);
    child.stderr.emit("data", `${secret.slice(9)} is invalid\n`);
    child.emit("close", 1, null);
    await result.catch(() => undefined);

    expect(received.join("")).not.toContain(secret);
    expect(received.join("")).toContain("[REDACTED]");
  });

  it("terminates a timed-out streaming process and settles on close", async () => {
    vi.useFakeTimers();
    const child = streamingChild();
    childProcess.spawn.mockReturnValue(child);

    const result = runGh(["repo", "clone", "owner/repo"], {
      timeoutMs: 100,
      onStderr: () => undefined
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.emit("close", null, "SIGTERM");

    await expect(result).rejects.toMatchObject({
      code: "timed_out",
      message: "gh timed out after 100ms"
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("types buffered timeouts and force-kills a process that does not close", async () => {
    vi.useFakeTimers();
    const child = streamingChild();
    Object.assign(child, { pid: 4_242 });
    childProcess.spawn.mockReturnValue(child);
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);

    const result = runGh(["api", "user"], { timeoutMs: 100 });
    const rejection = expect(result).rejects.toMatchObject({
      code: "timed_out",
      message: "gh timed out after 100ms"
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(kill).toHaveBeenCalledWith(-4_242, "SIGTERM");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(kill).toHaveBeenLastCalledWith(-4_242, "SIGKILL");
    expect(child.kill).not.toHaveBeenCalled();

    await rejection;
    kill.mockRestore();
  });
});
