import { qwenStrategy, type DiscoveredAcpAgentGroup } from "@pwrdrvr/agent-acp";
import type {
  CodexAuthStatusResponse,
  CodexDiscoveryCandidate,
  CodexDiscoverySnapshot
} from "@pwrdrvr/codex-discovery";
import { describe, expect, it } from "vitest";
import {
  selectedCodexCandidate,
  toAcpDiscovery,
  toAcpInstances,
  toCodexAuthState,
  toCodexCandidates
} from "./ai-provider-discovery";

function candidate(
  command: string,
  extra: Partial<CodexDiscoveryCandidate> = {}
): CodexDiscoveryCandidate {
  return { command, source: "path", executable: true, selected: false, ...extra };
}

function snapshot(...candidates: CodexDiscoveryCandidate[]): CodexDiscoverySnapshot {
  return { candidates };
}

function group(
  strategyId: string,
  instances: DiscoveredAcpAgentGroup["instances"]
): DiscoveredAcpAgentGroup {
  return {
    strategyId,
    backendId: `acp:${strategyId}`,
    name: strategyId,
    args: ["--acp"],
    env: {},
    instances,
    discoveredAt: 0
  };
}

describe("toCodexCandidates", () => {
  it("lists every candidate the kit reported, in its order", () => {
    const candidates = toCodexCandidates(
      snapshot(
        candidate("/pinned/codex", { source: "config", version: "0.130.0", selected: true }),
        candidate("/opt/homebrew/bin/codex", { version: "0.128.0" }),
        candidate("/Applications/Codex.app/codex", { source: "application" })
      )
    );
    expect(candidates).toEqual([
      { path: "/pinned/codex", source: "config", version: "0.130.0", available: true },
      { path: "/opt/homebrew/bin/codex", source: "path", version: "0.128.0", available: true },
      { path: "/Applications/Codex.app/codex", source: "application", version: null, available: true }
    ]);
  });

  it("says why an unusable candidate is unusable, preferring the launch failure", () => {
    const [launch, version, silent] = toCodexCandidates(
      snapshot(
        candidate("/a/codex", {
          executable: false,
          failureReason: "not executable",
          versionFailureReason: "no version"
        }),
        candidate("/b/codex", { executable: false, versionFailureReason: "older than 0.125.0" }),
        candidate("/c/codex", { executable: false })
      )
    );
    expect(launch?.failureReason).toBe("not executable");
    expect(version?.failureReason).toBe("older than 0.125.0");
    expect(silent?.available).toBe(false);
    expect(silent).not.toHaveProperty("failureReason");
  });

  it("carries no failure reason on a candidate that runs", () => {
    const [usable] = toCodexCandidates(
      snapshot(candidate("/a/codex", { versionFailureReason: "version probe timed out" }))
    );
    expect(usable).not.toHaveProperty("failureReason");
  });
});

describe("selectedCodexCandidate", () => {
  it("answers the binary the kit selected, with its version", () => {
    expect(
      selectedCodexCandidate(
        snapshot(
          candidate("/a/codex", { version: "0.131.0" }),
          candidate("/b/codex", { version: "0.129.0", selected: true })
        )
      )
    ).toEqual({ command: "/b/codex", version: "0.129.0" });
  });

  it("omits an unknown version rather than reporting it as undefined", () => {
    expect(selectedCodexCandidate(snapshot(candidate("/a/codex", { selected: true })))).toStrictEqual({
      command: "/a/codex"
    });
  });

  it("answers null when nothing is usable", () => {
    expect(selectedCodexCandidate(snapshot(candidate("/a/codex", { executable: false })))).toBeNull();
    expect(selectedCodexCandidate(snapshot())).toBeNull();
  });
});

describe("toCodexAuthState", () => {
  function response(extra: Partial<CodexAuthStatusResponse> = {}): CodexAuthStatusResponse {
    return {
      profile: "work",
      codexHome: "/home/me/.codex/profiles/work",
      authenticated: false,
      status: "unauthenticated",
      outcome: "answered",
      ...extra
    };
  }

  it("takes an answered check at its word", () => {
    expect(toCodexAuthState(response(), "work")).toEqual({
      status: "unauthenticated",
      profile: "work",
      profileLabel: "work",
      codexHome: "/home/me/.codex/profiles/work"
    });
    expect(
      toCodexAuthState(
        response({
          authenticated: true,
          status: "authenticated",
          email: "me@example.com",
          planType: "pro",
          detail: "  Logged in using ChatGPT  "
        }),
        "work"
      )
    ).toEqual({
      status: "authenticated",
      profile: "work",
      profileLabel: "work",
      codexHome: "/home/me/.codex/profiles/work",
      email: "me@example.com",
      planType: "pro",
      detail: "Logged in using ChatGPT"
    });
  });

  it("reads a check from a kit that reports no outcome as answered", () => {
    // Older kits predate `outcome`; their status was always a verdict.
    const legacy = response();
    delete legacy.outcome;
    expect(toCodexAuthState(legacy, "work").status).toBe("unauthenticated");
  });

  it("never reads an unanswered check as signed out", () => {
    // Sending the operator to re-login an account that may be fine is the
    // failure this guards against.
    for (const outcome of ["timed_out", "aborted", "spawn_failed"] as const) {
      const state = toCodexAuthState(response({ outcome }), "work");
      expect(state.status).toBe("failed");
      expect(state.detail).toBeTruthy();
    }
  });

  it("says a timed-out check did not answer, when the CLI said nothing itself", () => {
    expect(toCodexAuthState(response({ outcome: "timed_out" }), "work").detail).toBe(
      "Codex did not answer the sign-in check in time."
    );
  });

  it("says why the other unanswered checks have no verdict, not that they timed out", () => {
    expect(toCodexAuthState(response({ outcome: "spawn_failed" }), "work").detail).toBe(
      "Codex could not be started to check sign-in."
    );
    expect(toCodexAuthState(response({ outcome: "aborted" }), "work").detail).toBe(
      "The sign-in check was cancelled."
    );
  });

  it("keeps the CLI's own words for an unanswered check when it had some", () => {
    expect(
      toCodexAuthState(response({ outcome: "spawn_failed", detail: "spawn codex EACCES" }), "work")
        .detail
    ).toBe("spawn codex EACCES");
  });

  it("drops a blank detail on an answered check, and bounds a long one", () => {
    expect(toCodexAuthState(response({ detail: "   " }), "work")).not.toHaveProperty("detail");
    expect(toCodexAuthState(response({ detail: "d".repeat(1_000) }), "work").detail).toHaveLength(240);
  });

  it("labels the account with the caller's label", () => {
    expect(
      toCodexAuthState(response({ profile: "", codexHome: "/home/me/.codex" }), "System default")
        .profileLabel
    ).toBe("System default");
  });
});

describe("toAcpInstances", () => {
  it("keeps every install in the kit's order, with versions only where known", () => {
    expect(
      toAcpInstances(
        group("kimi", [
          { command: "/custom/kimi", source: "override", version: "1.2.0" },
          { command: "/usr/local/bin/kimi", source: "path" }
        ])
      )
    ).toStrictEqual([
      { command: "/custom/kimi", source: "override", version: "1.2.0" },
      { command: "/usr/local/bin/kimi", source: "path" }
    ]);
  });
});

describe("toAcpDiscovery", () => {
  it("lists every PwrGit agent, installed or not, and nothing else", () => {
    const discovery = toAcpDiscovery(
      [group("gemini", [{ command: "/usr/local/bin/gemini", source: "path" }])],
      {}
    );
    expect(discovery.agents.map((agent) => agent.id)).toEqual(["grok", "kimi", "qwen"]);
    expect(discovery.agents.map((agent) => agent.displayName)).toEqual([
      "Grok",
      "Kimi Code CLI",
      "Qwen Code"
    ]);
  });

  it("gives an agent that is not installed an install hint", () => {
    const discovery = toAcpDiscovery([], {});
    for (const agent of discovery.agents) {
      expect(agent).toMatchObject({ installed: false, instances: [] });
      expect(agent.detail).toMatch(/^Not installed/);
      expect(agent).not.toHaveProperty("activeCommand");
    }
  });

  it("points the hint at the agent's home when the kit knows one", () => {
    const qwen = toAcpDiscovery([], {}).agents.find((agent) => agent.id === "qwen");
    expect(qwenStrategy.repositoryUrl).toBeTruthy();
    expect(qwen?.detail).toContain(qwenStrategy.repositoryUrl);
  });

  it("treats a group with no passing install as not installed", () => {
    const kimi = toAcpDiscovery([group("kimi", [])], {}).agents.find((agent) => agent.id === "kimi");
    expect(kimi?.installed).toBe(false);
  });

  it("marks the install spawns will use, honoring the operator's pin", () => {
    const discovery = toAcpDiscovery(
      [
        group("grok", [
          { command: "/usr/local/bin/grok", source: "path", version: "1.0.0" },
          { command: "/opt/grok/bin/grok", source: "path", version: "1.1.0" }
        ])
      ],
      { grok: { selectedPath: "/opt/grok/bin/grok" } }
    );
    expect(discovery.agents[0]).toEqual({
      id: "grok",
      displayName: "Grok",
      installed: true,
      instances: [
        { command: "/usr/local/bin/grok", source: "path", version: "1.0.0" },
        { command: "/opt/grok/bin/grok", source: "path", version: "1.1.0" }
      ],
      activeCommand: "/opt/grok/bin/grok",
      detail: "/opt/grok/bin/grok",
      version: "1.1.0"
    });
  });

  it("uses the first install when nothing is pinned, without inventing a version", () => {
    const qwen = toAcpDiscovery(
      [
        group("qwen", [
          { command: "/usr/local/bin/qwen", source: "path" },
          { command: "/home/me/.local/bin/qwen", source: "fallback", version: "0.9.0" }
        ])
      ],
      {}
    ).agents.find((agent) => agent.id === "qwen");
    expect(qwen?.activeCommand).toBe("/usr/local/bin/qwen");
    expect(qwen).not.toHaveProperty("version");
  });
});
