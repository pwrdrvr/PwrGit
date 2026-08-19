import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const childProcess = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => childProcess);

import {
  clearGitLabTokenCache,
  getGitLabToken,
  glabEnvironment,
  isGlabAuthenticationError,
  runGlab,
  sanitizeGlabDiagnostic
} from "./glab-cli";

function fakeChild(): EventEmitter & {
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

/**
 * Queue one spawned call's outcome. The events must be emitted only once spawn
 * is actually called, or a queued response lands on the previous child.
 */
function settle(stdout: string, exitCode = 0, stderr = ""): void {
  childProcess.spawn.mockImplementationOnce(() => {
    const child = fakeChild();
    queueMicrotask(() => {
      if (stdout !== "") child.stdout.emit("data", stdout);
      if (stderr !== "") child.stderr.emit("data", stderr);
      child.emit("close", exitCode, null);
    });
    return child;
  });
}

const previousToken = process.env.GITLAB_TOKEN;

beforeEach(() => {
  vi.clearAllMocks();
  clearGitLabTokenCache();
  delete process.env.GITLAB_TOKEN;
});

afterEach(() => {
  if (previousToken === undefined) delete process.env.GITLAB_TOKEN;
  else process.env.GITLAB_TOKEN = previousToken;
});

describe("glabEnvironment", () => {
  it("closes prompts and the per-invocation update check", () => {
    expect(glabEnvironment()).toMatchObject({
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never",
      GLAB_CHECK_UPDATE: "0"
    });
  });
});

describe("runGlab", () => {
  it("spawns glab detached with stdin ignored and guards forced on", async () => {
    settle("out\n");

    await expect(
      runGlab(["api", "user"], { env: { GIT_TERMINAL_PROMPT: "1" } })
    ).resolves.toBe("out");
    expect(childProcess.spawn).toHaveBeenCalledWith(
      "glab",
      ["api", "user"],
      expect.objectContaining({
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        // A caller override must not be able to reopen a prompt.
        env: expect.objectContaining({ GIT_TERMINAL_PROMPT: "0" })
      })
    );
  });

  it("classifies a login failure as an authentication error", async () => {
    settle("", 1, "error: run glab auth login to authenticate\n");

    const failure = await runGlab(["api", "user"]).catch((error: unknown) => error);

    expect(isGlabAuthenticationError(failure)).toBe(true);
    expect((failure as Error).message).toContain("glab auth login");
    expect((failure as Error).name).toBe("GlabCliError");
  });
});

describe("sanitizeGlabDiagnostic", () => {
  it("redacts routable GitLab token prefixes", () => {
    expect(sanitizeGlabDiagnostic("failed with glpat-AbCdEf123456 here")).toBe(
      "failed with [REDACTED] here"
    );
    expect(sanitizeGlabDiagnostic("gloas-0123456789abcdef")).toBe("[REDACTED]");
  });

  it("redacts token env assignments and auth headers", () => {
    expect(sanitizeGlabDiagnostic("GITLAB_TOKEN=supersecretvalue")).toBe(
      "GITLAB_TOKEN=[REDACTED]"
    );
    expect(sanitizeGlabDiagnostic("PRIVATE-TOKEN: supersecretvalue")).toBe(
      "PRIVATE-TOKEN: [REDACTED]"
    );
    // The scheme is kept and only the value redacted, as on the GitHub side.
    expect(sanitizeGlabDiagnostic("authorization: Bearer supersecretvalue")).toBe(
      "authorization: Bearer [REDACTED]"
    );
  });

  it("redacts credentials embedded in a clone URL", () => {
    expect(
      sanitizeGlabDiagnostic("https://user:pass@gitlab.com/g/p.git")
    ).toBe("https://[REDACTED]@gitlab.com/g/p.git");
  });

  it("redacts the literal value of a configured token env var", () => {
    process.env.GITLAB_TOKEN = "a-very-distinctive-value";
    expect(
      sanitizeGlabDiagnostic("boom a-very-distinctive-value boom")
    ).toContain("[REDACTED]");
  });
});

describe("getGitLabToken", () => {
  it("prefers GITLAB_TOKEN without spawning anything", async () => {
    process.env.GITLAB_TOKEN = "env-token";

    await expect(getGitLabToken("gitlab.com")).resolves.toBe("env-token");
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  it("falls back to the token glab already holds for that host", async () => {
    settle("keyring-token\n");

    await expect(getGitLabToken("gitlab.com")).resolves.toBe("keyring-token");
    expect(childProcess.spawn).toHaveBeenCalledWith(
      "glab",
      ["config", "get", "token", "--host", "gitlab.com"],
      expect.anything()
    );
  });

  it("caches per host, so two hosts are two different credentials", async () => {
    settle("token-a\n");
    settle("token-b\n");

    await expect(getGitLabToken("gitlab.com")).resolves.toBe("token-a");
    await expect(getGitLabToken("gitlab.example.com")).resolves.toBe("token-b");
    // A repeat for a known host must not spawn again.
    await expect(getGitLabToken("GitLab.com")).resolves.toBe("token-a");
    expect(childProcess.spawn).toHaveBeenCalledTimes(2);
  });

  it("returns null when glab is missing or logged out", async () => {
    settle("", 1, "not logged in\n");
    await expect(getGitLabToken("gitlab.com")).resolves.toBeNull();

    // `config get` prints an empty line rather than failing for an unset key.
    clearGitLabTokenCache();
    settle("\n");
    await expect(getGitLabToken("gitlab.com")).resolves.toBeNull();
  });
});
