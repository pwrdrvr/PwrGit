import { describe, expect, it } from "vitest";
import type { PwrGitError } from "@pwrgit/shared";
import {
  execGit,
  gitExecutionEnvironment,
  sanitizeGitLogDetail
} from "./dugite";

describe("gitExecutionEnvironment", () => {
  it("disables terminal credentials while preserving caller overlays", () => {
    expect(
      gitExecutionEnvironment({
        GIT_OPTIONAL_LOCKS: "0",
        CUSTOM_SETTING: "kept"
      })
    ).toEqual({
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never",
      GIT_OPTIONAL_LOCKS: "0",
      CUSTOM_SETTING: "kept"
    });
  });

  it("does not let caller overrides re-enable credential prompts", () => {
    expect(
      gitExecutionEnvironment({
        GIT_TERMINAL_PROMPT: "1",
        GCM_INTERACTIVE: "Auto"
      })
    ).toMatchObject({
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never"
    });
  });
});

describe("execGit aborts", () => {
  it("preserves the typed abort reason instead of reporting spawn_failed", async () => {
    const timeout: PwrGitError = {
      kind: "remote",
      code: "pull_stalled",
      message: "Pull stopped during fetching after 15m 0s."
    };
    const controller = new AbortController();
    controller.abort(timeout);

    await expect(
      execGit(["status"], "/unused", { signal: controller.signal })
    ).resolves.toEqual({ ok: false, error: timeout });
  });
});

describe("sanitizeGitLogDetail", () => {
  it("redacts common URL, header, query, and GitHub token credentials", () => {
    const detail = sanitizeGitLogDetail(
      "fatal: https://harold:secret@example.com/repo?token=abc123\n" +
        "Authorization: Bearer secret\n" +
        "ghp_1234567890abcdef"
    );

    expect(detail).toContain("https://[redacted]@example.com/repo");
    expect(detail).toContain("token=[redacted]");
    expect(detail).toContain("Authorization: [redacted]");
    expect(detail).toContain("[redacted credential]");
    expect(detail).not.toContain("secret");
    expect(detail).not.toContain("1234567890abcdef");
  });
});
