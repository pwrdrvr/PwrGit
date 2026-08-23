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
    const previousSshCommand = process.env.GIT_SSH_COMMAND;
    process.env.GIT_SSH_COMMAND = "user-configured-ssh-command";
    try {
      expect(ghEnvironment()).toMatchObject({
        GH_PROMPT_DISABLED: "1",
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "Never",
        GIT_SSH_COMMAND: "user-configured-ssh-command"
      });
    } finally {
      if (previousSshCommand === undefined) {
        delete process.env.GIT_SSH_COMMAND;
      } else {
        process.env.GIT_SSH_COMMAND = previousSshCommand;
      }
    }
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

  it.each(["stdout", "stderr"] as const)(
    "rejects buffered %s overflow instead of returning truncated data",
    async (stream) => {
      const child = streamingChild();
      childProcess.spawn.mockReturnValue(child);
      const secret = "opaque-overflow-credential-123";
      const retainedFragment = secret.slice(0, 9);

      const result = runGh(["api", "user"], { env: { GH_TOKEN: secret } });
      child[stream].emit(
        "data",
        "x".repeat(1024 * 1024 - retainedFragment.length) + secret
      );
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      child.emit("close", null, "SIGTERM");
      const failure = await result.catch((cause: unknown) => cause);

      expect(failure).toMatchObject({
        code: "output_too_large",
        message: `GitHub CLI ${stream} exceeded the 1048576-byte limit.`
      });
      expect(JSON.stringify(failure)).not.toContain(secret);
      const diagnostics = failure as { stdout: string; stderr: string };
      expect(diagnostics[stream]).not.toContain(retainedFragment);
    }
  );

  it("removes a token prefix split by the buffered output limit", async () => {
    const child = streamingChild();
    childProcess.spawn.mockReturnValue(child);
    const token = "github_pat_bufferBoundaryCredential123";
    const retainedFragment = token.slice(0, 5);

    const result = runGh(["api", "user"]);
    child.stdout.emit(
      "data",
      "x".repeat(1024 * 1024 - retainedFragment.length) + token
    );
    child.emit("close", null, "SIGTERM");
    const failure = (await result.catch((cause: unknown) => cause)) as {
      code: string;
      stdout: string;
    };

    expect(failure.code).toBe("output_too_large");
    expect(failure.stdout).not.toContain(retainedFragment);
    expect(failure.stdout).not.toContain(token);
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

  it("bounds no-newline streamed stderr while retaining a redaction overlap", async () => {
    const child = streamingChild();
    childProcess.spawn.mockReturnValue(child);
    const received: string[] = [];
    const secret = "gho_longStreamCredential123";

    const result = runGh(["repo", "clone", "owner/private"], {
      onStderr: (chunk) => received.push(chunk),
      env: { GH_TOKEN: secret }
    });
    child.stderr.emit("data", `first line\n${"x".repeat(128 * 1024)}`);
    expect(received.join("").length).toBeGreaterThan(64 * 1024);
    child.stderr.emit("data", secret.slice(0, 10));
    child.stderr.emit("data", `${secret.slice(10)} failed\n`);
    child.emit("close", 1, null);
    await result.catch(() => undefined);

    expect(received.join("")).not.toContain(secret);
    expect(received.join("")).toContain("[REDACTED]");
  });

  it("does not reconstruct a non-env token pattern across a forced boundary", async () => {
    const child = streamingChild();
    childProcess.spawn.mockReturnValue(child);
    const received: string[] = [];
    const token = "github_pat_boundaryCredential123456789";
    const splitInsidePrefix = 5;
    const trailingLength = 4 * 1024 + splitInsidePrefix - token.length;

    const result = runGh(["repo", "clone", "owner/private"], {
      onStderr: (chunk) => received.push(chunk)
    });
    child.stderr.emit(
      "data",
      `${"x".repeat(70 * 1024)}${token}${"y".repeat(trailingLength)}`
    );
    child.stderr.emit("data", "\n");
    child.emit("close", 1, null);
    await result.catch(() => undefined);

    expect(received.length).toBeGreaterThan(1);
    expect(received.join("")).not.toContain(token);
    expect(received.join("")).toContain("[REDACTED]");
  });

  it("bounds stderr even when a configured secret exceeds the carry window", async () => {
    const child = streamingChild();
    childProcess.spawn.mockReturnValue(child);
    const received: string[] = [];
    const secret = `opaque-${"s".repeat(70 * 1024)}`;

    const result = runGh(["repo", "clone", "owner/private"], {
      onStderr: (chunk) => received.push(chunk),
      env: { GH_TOKEN: secret }
    });
    child.stderr.emit("data", secret);
    expect(received).toContain("[REDACTED]");
    child.stderr.emit("data", "\n");
    child.emit("close", 1, null);
    await result.catch(() => undefined);

    expect(received.join("")).not.toContain(secret);
    expect(received.join("")).not.toContain(secret.slice(-1024));
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

  it("terminates an explicitly canceled CLI process", async () => {
    const child = streamingChild();
    childProcess.spawn.mockReturnValue(child);
    const controller = new AbortController();

    const result = runGh(["repo", "clone", "owner/repo"], {
      onStderr: () => undefined,
      signal: controller.signal
    });
    controller.abort();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.emit("close", null, "SIGTERM");

    await expect(result).rejects.toMatchObject({
      code: "aborted",
      message: "GitHub CLI command was canceled."
    });
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
    if (process.platform === "win32") {
      expect(childProcess.spawn).toHaveBeenNthCalledWith(
        2,
        expect.stringMatching(/[\\/]taskkill\.exe$/i),
        ["/pid", "4242", "/T", "/F"],
        { stdio: "ignore", windowsHide: true }
      );
      expect(child.kill).not.toHaveBeenCalled();
      expect(kill).not.toHaveBeenCalled();
    } else {
      expect(kill).toHaveBeenCalledWith(-4_242, "SIGTERM");
      expect(child.kill).not.toHaveBeenCalled();
    }
    await vi.advanceTimersByTimeAsync(1_000);
    if (process.platform === "win32") {
      expect(childProcess.spawn).toHaveBeenNthCalledWith(
        3,
        expect.stringMatching(/[\\/]taskkill\.exe$/i),
        ["/pid", "4242", "/T", "/F"],
        { stdio: "ignore", windowsHide: true }
      );
    } else {
      expect(kill).toHaveBeenLastCalledWith(-4_242, "SIGKILL");
    }

    await rejection;
    kill.mockRestore();
  });

  it("terminates the entire CLI subprocess tree on Windows", async () => {
    const child = streamingChild();
    Object.assign(child, { pid: 4_242 });
    const taskkill = streamingChild();
    childProcess.spawn.mockReturnValueOnce(child).mockReturnValue(taskkill);
    const actualPlatform = process.platform;
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "win32"
    });

    try {
      const controller = new AbortController();
      const result = runGh(["repo", "clone", "owner/repo"], {
        onStderr: () => undefined,
        signal: controller.signal
      });
      controller.abort();

      expect(childProcess.spawn).toHaveBeenNthCalledWith(
        2,
        expect.stringMatching(/[\\/]taskkill\.exe$/i),
        ["/pid", "4242", "/T", "/F"],
        { stdio: "ignore", windowsHide: true }
      );
      expect(child.kill).not.toHaveBeenCalled();
      child.emit("close", null, "SIGTERM");
      await expect(result).rejects.toMatchObject({ code: "aborted" });
    } finally {
      Object.defineProperty(process, "platform", {
        configurable: true,
        value: actualPlatform
      });
    }
  });
});
