import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  shell: { openExternal: vi.fn(async () => undefined) }
}));

import {
  agentEnvForPwrGitProfile,
  codexEnvForProfile,
  PWRGIT_AGENT_PROFILE_ENV
} from "./agent-kit-bindings";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("profile-scoped agent environment", () => {
  it("uses a matching authenticated Codex profile", () => {
    const home = mkdtempSync(join(tmpdir(), "pwrgit-agent-env-"));
    roots.push(home);
    const authHome = join(home, ".codex", "profiles", "acme");
    mkdirSync(authHome, { recursive: true });
    writeFileSync(join(authHome, "auth.json"), "{}\n");

    const env = agentEnvForPwrGitProfile("acme", {}, home);

    expect(env["CODEX_HOME"]).toBe(authHome);
    expect(env[PWRGIT_AGENT_PROFILE_ENV]).toBe("acme");
  });

  it("falls back to the default account without losing PwrGit profile scope", () => {
    const home = mkdtempSync(join(tmpdir(), "pwrgit-agent-env-"));
    roots.push(home);

    const env = agentEnvForPwrGitProfile("work", {}, home);

    expect(env["CODEX_HOME"]).toBe(join(home, ".codex"));
    expect(env[PWRGIT_AGENT_PROFILE_ENV]).toBe("work");
  });

  it("preserves the caller environment while resolving an explicit auth profile", () => {
    const home = mkdtempSync(join(tmpdir(), "pwrgit-agent-env-"));
    roots.push(home);
    const env = codexEnvForProfile("personal", { KEEP_ME: "yes" }, home);

    expect(env["KEEP_ME"]).toBe("yes");
    expect(env["CODEX_HOME"]).toBe(
      join(home, ".codex", "profiles", "personal")
    );
  });
});
