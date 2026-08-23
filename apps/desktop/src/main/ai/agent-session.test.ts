import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  shell: { openExternal: vi.fn(async () => undefined) }
}));

import type {
  CodexOneShotClientOptions,
  CodexOneShotRequest,
  CodexOneShotResponse
} from "@pwrdrvr/agent-client";
import type { CodexDiscoverySnapshot } from "@pwrdrvr/codex-discovery";
import type { RebaseCommitRef } from "@pwrgit/shared";
import {
  LocalAgentSession,
  parseAgentRebaseProposal,
  type StructuredAgentClient
} from "./agent-session";

const commits: RebaseCommitRef[] = [
  { hash: "bbbbbbbb", subject: "top" },
  { hash: "aaaaaaaa", subject: "older" }
];

function codexReady(): CodexDiscoverySnapshot {
  return {
    selectedCommand: "/tools/codex",
    selectedSource: "path",
    candidates: [
      {
        command: "/tools/codex",
        source: "path",
        executable: true,
        selected: true,
        version: "0.146.0",
        versionProbeOutcome: "ok"
      }
    ]
  };
}

function response(rawText: string): CodexOneShotResponse {
  return {
    rawText,
    threadId: "thread-1",
    turnId: "turn-1",
    userAgent: "codex/0.146.0",
    model: "gpt-5",
    modelProvider: "openai",
    serviceTier: null,
    tokenUsage: null
  };
}

function validRaw(): string {
  return JSON.stringify({
    title: "Combine the focused work",
    summary: "The two commits form one focused change.",
    rationale: ["Both subjects describe the same unit of work."],
    risks: ["The resulting commit message combines both subjects."],
    confidence: "high",
    verdict: "proceed",
    operation: "squash",
    steps: [
      { action: "pick", hash: "aaaaaaaa" },
      { action: "squash", hash: "bbbbbbbb" }
    ]
  });
}

describe("LocalAgentSession", () => {
  it("discovers Codex and reports detected ACP agents as unsupported for this safety boundary", async () => {
    const session = new LocalAgentSession({
      discoverCodex: vi.fn(async () => codexReady()),
      discoverAcp: vi.fn(async () => [
        {
          strategyId: "gemini",
          backendId: "acp:gemini",
          name: "Gemini",
          args: ["--acp"],
          env: {},
          instances: [
            {
              command: "/tools/gemini",
              source: "path" as const,
              version: "1.2.3"
            }
          ],
          discoveredAt: 1
        }
      ]),
      envForProfile: () => ({ CODEX_HOME: "/auth/work" })
    });

    const availability = await session.availability({ profileId: "work" });

    expect(availability.status).toBe("ready");
    expect(availability.selectedProviderId).toBe("codex");
    expect(availability.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "codex", status: "ready" }),
        expect.objectContaining({ id: "acp:gemini", status: "unsupported" })
      ])
    );
    await session.close();
  });

  it("runs from a profile-scoped scratch directory and only returns a locally verified canonical plan", async () => {
    let clientOptions: CodexOneShotClientOptions | undefined;
    let request: CodexOneShotRequest | undefined;
    const client: StructuredAgentClient = {
      run: vi.fn(async (input) => {
        request = input;
        return response(validRaw());
      }),
      close: vi.fn(async () => undefined)
    };
    const session = new LocalAgentSession({
      discoverCodex: vi.fn(async () => codexReady()),
      discoverAcp: vi.fn(async () => []),
      envForProfile: (profileId) => ({
        CODEX_HOME: `/auth/${profileId}`,
        PWRGIT_PROFILE_ID: profileId
      }),
      createCodexClient: (options) => {
        clientOptions = options;
        return client;
      },
      tempRoot: "/safe/pwrgit-agent",
      now: () => Date.parse("2026-08-23T12:00:00.000Z")
    });

    const result = await session.proposeRebase({
      requestId: "proposal-1",
      profileId: "work",
      commits,
      op: "squash"
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.plan.steps.map((step) => step.action)).toEqual([
        "pick",
        "squash"
      ]);
      expect(result.value.generatedAt).toBe("2026-08-23T12:00:00.000Z");
    }
    expect(clientOptions).toEqual(
      expect.objectContaining({
        command: "/tools/codex",
        workspaceDir: join("/safe/pwrgit-agent", "work"),
        env: expect.objectContaining({
          CODEX_HOME: "/auth/work",
          PWRGIT_PROFILE_ID: "work"
        })
      })
    );
    expect(clientOptions?.workspaceDir).not.toContain("repo");
    expect(request).toEqual(
      expect.objectContaining({
        outputSchema: expect.any(Object),
        baseInstructions: expect.stringContaining("Do not ask to run commands")
      })
    );
    expect(request?.prompt).not.toContain("/repo");
    await session.close();
  });

  it("rejects an agent-authored step change instead of turning it into executable input", async () => {
    const changed = JSON.parse(validRaw()) as Record<string, unknown>;
    changed["steps"] = [
      { action: "pick", hash: "bbbbbbbb" },
      { action: "squash", hash: "aaaaaaaa" }
    ];

    expect(
      parseAgentRebaseProposal(JSON.stringify(changed), commits, "squash")
    ).toBeNull();

    const session = new LocalAgentSession({
      discoverCodex: vi.fn(async () => codexReady()),
      discoverAcp: vi.fn(async () => []),
      envForProfile: () => ({ CODEX_HOME: "/auth" }),
      createCodexClient: () => ({
        run: vi.fn(async () => response(JSON.stringify(changed))),
        close: vi.fn(async () => undefined)
      })
    });
    const result = await session.proposeRebase({
      requestId: "proposal-2",
      profileId: "work",
      commits,
      op: "squash"
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_response");
    await session.close();
  });

  it("leaves the deterministic workflow available when discovery is disabled", async () => {
    const session = new LocalAgentSession({ discoveryDisabled: true });
    const availability = await session.availability({ profileId: "personal" });

    expect(availability.status).toBe("unavailable");
    expect(availability.message).toContain("deterministic plan");
    expect(availability.providers.every((provider) => provider.status === "unavailable")).toBe(
      true
    );
    await session.close();
  });
});
