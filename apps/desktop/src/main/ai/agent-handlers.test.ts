import { describe, expect, it, vi } from "vitest";

vi.mock("../ipc", () => ({ emitEvent: vi.fn() }));

import {
  err,
  ok,
  type AgentAvailability,
  type AgentRebaseProposal,
  type RebaseCommitRef,
  type Result
} from "@pwrgit/shared";
import { CommandBus } from "../command-bus";
import { emitEvent } from "../ipc";
import type { DB } from "../persistence/db";
import type { GitExec } from "../git/dugite";
import {
  registerRebaseHandlers,
  type RebaseHandlerDependencies
} from "../git/rebase-handlers";
import { WorktreeOperationQueue } from "../git/worktree-operation-queue";
import type { WorktreeRefresher } from "../git/worktree-handlers";
import {
  registerAgentHandlers,
  type AgentHandlerDependencies
} from "./agent-handlers";
import type { AgentSession } from "./agent-session";

const commits: RebaseCommitRef[] = [
  { hash: "bbbbbbbb", subject: "top" },
  { hash: "aaaaaaaa", subject: "older" }
];

const unavailable: AgentAvailability = {
  profileId: "work",
  status: "unavailable",
  selectedProviderId: null,
  message: "No safe local agent. The deterministic plan remains available.",
  providers: []
};

function proposal(requestId: string): AgentRebaseProposal {
  return {
    requestId,
    providerId: "codex",
    providerName: "Codex",
    operation: "squash",
    plan: {
      op: "squash",
      valid: true,
      summary: "one commit",
      steps: [
        { action: "pick", shortHash: "aaaaaaa", subject: "older" },
        { action: "squash", shortHash: "bbbbbbb", subject: "top" }
      ]
    },
    title: "Focused history",
    summary: "Combine the commits.",
    rationale: ["One unit of work."],
    risks: [],
    confidence: "high",
    verdict: "proceed",
    generatedAt: "2026-08-23T12:00:00.000Z"
  };
}

function fakeDb(): DB {
  return {
    prepare: (sql: string) => ({
      get: () => {
        if (sql.includes("SELECT id FROM profiles")) return { id: "work" };
        if (sql.includes("r.profile_id")) {
          return { path: "/repo", profile_id: "work" };
        }
        if (sql.includes("JOIN profiles")) {
          return { path: "/repo", email: "me@example.com", author_name: "Me" };
        }
        return { path: "/repo" };
      }
    })
  } as unknown as DB;
}

function fakeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    availability: vi.fn(async () => unavailable),
    proposeRebase: vi.fn(async (input) => ok(proposal(input.requestId))),
    close: vi.fn(async () => undefined),
    ...overrides
  };
}

const readGit = vi.fn<GitExec>(async (args) =>
  ok({
    exitCode: 0,
    stdout:
      args[0] === "log"
        ? "bbbbbbbb\naaaaaaaa\n"
        : args[0] === "rev-parse"
          ? "base\n"
          : "",
    stderr: ""
  })
);

describe("agent rebase command safety", () => {
  it("cannot mutate Git or use a proposal id to bypass the isolated-check approval", async () => {
    const bus = new CommandBus();
    const validate = vi.fn(async () => ok({ oldest: "aaaaaaaa", base: "base" }));
    const ready: AgentAvailability = {
      ...unavailable,
      status: "ready",
      selectedProviderId: "codex"
    };
    const session = fakeSession({
      availability: vi.fn(async () => ready)
    });
    const lifecycle = registerAgentHandlers(bus, fakeDb(), {
      session,
      validate
    });

    const apply = vi.fn(
      async (
        ..._args: Parameters<RebaseHandlerDependencies["apply"]>
      ): Promise<Result<void>> => ok(undefined)
    );
    const dryRun = vi.fn(
      async (): Promise<
        Result<{ sourceHead: string; sourceRef: string | null }>
      > => ok({ sourceHead: "head", sourceRef: "refs/heads/main" })
    );
    registerRebaseHandlers(
      bus,
      fakeDb(),
      { refreshWorktree: vi.fn() } as unknown as WorktreeRefresher,
      new WorktreeOperationQueue(),
      { apply, dryRun, git: readGit, createToken: () => "real-check-token" }
    );

    const drafted = await bus.dispatch("agent:rebaseDraft", {
      requestId: "agent-proposal-1",
      worktreeId: "wt-1",
      commits,
      op: "squash"
    });
    expect(drafted.ok).toBe(true);
    expect(validate).toHaveBeenCalledOnce();
    expect(dryRun).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();

    const bypass = await bus.dispatch("rebase:apply", {
      worktreeId: "wt-1",
      commits,
      op: "squash",
      approvalToken: "agent-proposal-1"
    });
    expect(bypass.ok).toBe(false);
    if (!bypass.ok) expect(bypass.error.code).toBe("dry_run_required");
    expect(apply).not.toHaveBeenCalled();
    await lifecycle.dispose();
  });

  it("reports unavailable agents without disabling deterministic draft and check", async () => {
    const bus = new CommandBus();
    const lifecycle = registerAgentHandlers(bus, fakeDb(), {
      session: fakeSession(),
      validate: vi.fn(async () => ok({ oldest: "aaaaaaaa", base: "base" }))
    });
    const dryRun = vi.fn(
      async (): Promise<
        Result<{ sourceHead: string; sourceRef: string | null }>
      > => ok({ sourceHead: "head", sourceRef: "refs/heads/main" })
    );
    registerRebaseHandlers(
      bus,
      fakeDb(),
      { refreshWorktree: vi.fn() } as unknown as WorktreeRefresher,
      new WorktreeOperationQueue(),
      { dryRun, git: readGit, createToken: () => "check-token" }
    );

    const availability = await bus.dispatch("agent:availability", {
      profileId: "work"
    });
    const deterministic = await bus.dispatch("rebase:draft", {
      worktreeId: "wt-1",
      commits,
      op: "squash"
    });
    const checked = await bus.dispatch("rebase:check", {
      worktreeId: "wt-1",
      commits,
      op: "squash"
    });

    expect(availability).toEqual(ok(unavailable));
    expect(deterministic.ok && deterministic.value.valid).toBe(true);
    expect(checked.ok && checked.value.status).toBe("clean");
    expect(dryRun).toHaveBeenCalledOnce();
    await lifecycle.dispose();
  });

  it("cancels an in-flight request through its typed command", async () => {
    const proposeRebase = vi.fn(
      async (input: Parameters<AgentSession["proposeRebase"]>[0]) =>
        new Promise<Awaited<ReturnType<AgentSession["proposeRebase"]>>>((resolve) => {
          input.signal?.addEventListener(
            "abort",
            () =>
              resolve(
                err({
                  kind: "agent",
                  code: "cancelled",
                  message: "Cancelled. Nothing changed."
                })
              ),
            { once: true }
          );
        })
    );
    const bus = new CommandBus();
    const lifecycle = registerAgentHandlers(bus, fakeDb(), {
      session: fakeSession({ proposeRebase }),
      validate: vi.fn(async () => ok({ oldest: "aaaaaaaa", base: "base" }))
    });

    const pending = bus.dispatch(
      "agent:rebaseDraft",
      {
        requestId: "agent-proposal-cancel",
        worktreeId: "wt-1",
        commits,
        op: "squash"
      },
      { webContentsId: 7 }
    );
    await vi.waitFor(() => expect(proposeRebase).toHaveBeenCalledOnce());
    const cancelled = await bus.dispatch(
      "agent:cancel",
      { requestId: "agent-proposal-cancel" },
      { webContentsId: 7 }
    );
    const result = await pending;

    expect(cancelled).toEqual(ok({ cancelled: true }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("cancelled");
    await lifecycle.dispose();
  });

  it("settles at the deadline even when the backend ignores abort", async () => {
    const session = fakeSession({
      proposeRebase: vi.fn(
        async () => new Promise<Result<AgentRebaseProposal>>(() => undefined)
      )
    });
    const bus = new CommandBus();
    const lifecycle = registerAgentHandlers(bus, fakeDb(), {
      session,
      validate: vi.fn(async () => ok({ oldest: "aaaaaaaa", base: "base" })),
      requestTimeoutMs: 5
    });

    const result = await Promise.race([
      bus.dispatch("agent:rebaseDraft", {
        requestId: "agent-proposal-timeout",
        worktreeId: "wt-1",
        commits,
        op: "squash"
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("deadline did not settle")), 500)
      )
    ]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("timeout");
    expect(session.close).toHaveBeenCalledOnce();
    expect(emitEvent).toHaveBeenCalledWith(
      "agent:requestState",
      expect.objectContaining({
        requestId: "agent-proposal-timeout",
        phase: "timed_out"
      })
    );
    await expect(
      bus.dispatch("agent:cancel", { requestId: "agent-proposal-timeout" })
    ).resolves.toEqual(ok({ cancelled: false }));
    await lifecycle.dispose();
  });
});
