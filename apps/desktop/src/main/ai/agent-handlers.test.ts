import { describe, expect, it, vi } from "vitest";

import {
  err,
  ok,
  type AgentAvailability,
  type AgentInputManifest,
  type AgentMessageDraft,
  type AgentTidyProposal,
  type RebaseCommitRef,
  type Result
} from "@pwrgit/shared";
import { CommandBus } from "../command-bus";
import type { DB } from "../persistence/db";
import type { GitExec } from "../git/dugite";
import {
  registerRebaseHandlers,
  type RebaseHandlerDependencies
} from "../git/rebase-handlers";
import { WorktreeOperationQueue } from "../git/worktree-operation-queue";
import type { WorktreeRefresher } from "../git/worktree-handlers";
import type { CommitsInput, StagedInput } from "./agent-input";
import { registerAgentHandlers, type AgentHandlerDependencies } from "./agent-handlers";
import type { AgentSession } from "./agent-session";

const commits: RebaseCommitRef[] = [
  { hash: "bbbbbbbb", subject: "top" },
  { hash: "aaaaaaaa", subject: "older" }
];

const unavailable: AgentAvailability = {
  profileId: "work",
  status: "unavailable",
  selectedProviderId: null,
  message: "No local agent is set up. Squash and Reorder work without one.",
  providers: []
};

const manifest: AgentInputManifest = {
  source: "commits",
  commitCount: 2,
  files: [],
  budget: { used: 0, limit: 2000 },
  styleSubjects: 0
};
const style = { convention: "plain" as const, matched: 0, sampled: 0, ref: null };
const commitsInput: CommitsInput = { commits: [], styleSubjects: [], style, manifest };

function draft(requestId: string): AgentMessageDraft {
  return {
    requestId,
    providerId: "codex",
    providerName: "Codex",
    model: "gpt-5",
    saw: manifest,
    style,
    generatedAt: "2026-08-23T12:00:00.000Z",
    subject: "Combine the work",
    body: ""
  };
}

function tidy(requestId: string): AgentTidyProposal {
  return {
    requestId,
    providerId: "codex",
    providerName: "Codex",
    model: "gpt-5",
    saw: manifest,
    style,
    generatedAt: "2026-08-23T12:00:00.000Z",
    program: { commits: [{ members: ["aaaaaaaa", "bbbbbbbb"], message: "One change" }] },
    note: null
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
    models: vi.fn(async () => ok({ providerId: "codex", models: [] })),
    draftMessage: vi.fn(async (input) => ok(draft(input.requestId))),
    proposeTidy: vi.fn(async (input) => ok(tidy(input.requestId))),
    close: vi.fn(async () => undefined),
    ...overrides
  };
}

function handlerDeps(
  overrides: Partial<AgentHandlerDependencies> = {}
): Partial<AgentHandlerDependencies> {
  return {
    validate: vi.fn(async () => ok({ oldest: "aaaaaaaa", base: "base" })),
    collectCommits: vi.fn(async () => commitsInput),
    collectStaged: vi.fn(
      async (): Promise<StagedInput> => ({
        diff: "+x",
        styleSubjects: [],
        style,
        manifest: {
          ...manifest,
          source: "staged",
          commitCount: 0,
          files: [
            { path: "a.ts", added: 1, removed: 0, treatment: "sent", sentLines: 1, totalLines: 1 }
          ]
        }
      })
    ),
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

const proof = { commitCount: 2, resultCount: 1, steps: 2, tree: "t".repeat(40), durationMs: 5 };

describe("agent command safety", () => {
  it("cannot mutate Git or use a request id to bypass the isolated-check approval", async () => {
    const bus = new CommandBus();
    const deps = handlerDeps();
    const session = fakeSession({
      availability: vi.fn(async () => ({ ...unavailable, status: "ready" as const }))
    });
    const lifecycle = registerAgentHandlers(bus, fakeDb(), { session, ...deps });

    const apply = vi.fn(
      async (..._args: Parameters<RebaseHandlerDependencies["apply"]>): Promise<Result<void>> =>
        ok(undefined)
    );
    const dryRun = vi.fn(async () =>
      ok({ sourceHead: "head", sourceRef: "refs/heads/main", proof })
    );
    registerRebaseHandlers(
      bus,
      fakeDb(),
      { refreshWorktree: vi.fn() } as unknown as WorktreeRefresher,
      new WorktreeOperationQueue(),
      { apply, dryRun, git: readGit, createToken: () => "real-check-token" }
    );

    const planned = await bus.dispatch("agent:tidyPlan", {
      requestId: "agent-tidy-1",
      worktreeId: "wt-1",
      commits
    });
    expect(planned.ok).toBe(true);
    expect(deps.validate).toHaveBeenCalledOnce();
    expect(dryRun).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();

    const bypass = await bus.dispatch("rebase:apply", {
      worktreeId: "wt-1",
      commits,
      op: "tidy",
      approvalToken: "agent-tidy-1",
      ...(planned.ok ? { program: planned.value.program } : {})
    });
    expect(!bypass.ok && bypass.error.code).toBe("dry_run_required");
    expect(apply).not.toHaveBeenCalled();
    await lifecycle.dispose();
  });

  it("reports an unavailable agent without disabling the deterministic draft and check", async () => {
    const bus = new CommandBus();
    const lifecycle = registerAgentHandlers(bus, fakeDb(), {
      session: fakeSession(),
      ...handlerDeps()
    });
    const dryRun = vi.fn(async () =>
      ok({ sourceHead: "head", sourceRef: "refs/heads/main", proof })
    );
    registerRebaseHandlers(
      bus,
      fakeDb(),
      { refreshWorktree: vi.fn() } as unknown as WorktreeRefresher,
      new WorktreeOperationQueue(),
      { dryRun, git: readGit, createToken: () => "check-token" }
    );

    const availability = await bus.dispatch("agent:availability", { profileId: "work" });
    const deterministic = await bus.dispatch("rebase:draft", {
      worktreeId: "wt-1",
      commits,
      op: "reorder"
    });
    const checked = await bus.dispatch("rebase:check", {
      worktreeId: "wt-1",
      commits,
      op: "reorder"
    });

    expect(availability).toEqual(ok(unavailable));
    expect(deterministic.ok && deterministic.value.valid).toBe(true);
    expect(checked.ok && checked.value.status).toBe("clean");
    expect(checked.ok && checked.value.status === "clean" && checked.value.proof).toEqual(proof);
    expect(dryRun).toHaveBeenCalledOnce();
    await lifecycle.dispose();
  });

  it("drafts from staged changes only, and says so when nothing is staged", async () => {
    const bus = new CommandBus();
    const deps = handlerDeps();
    const session = fakeSession();
    const lifecycle = registerAgentHandlers(bus, fakeDb(), { session, ...deps });

    const drafted = await bus.dispatch("agent:draftMessage", {
      requestId: "staged-1",
      worktreeId: "wt-1",
      source: { kind: "staged" }
    });
    expect(drafted.ok).toBe(true);
    expect(deps.collectStaged).toHaveBeenCalledWith(expect.anything(), "/repo");
    expect(deps.collectCommits).not.toHaveBeenCalled();
    expect(session.draftMessage).toHaveBeenCalledWith(
      expect.objectContaining({ source: "staged", profileId: "work" })
    );

    const emptyBus = new CommandBus();
    const emptySession = fakeSession();
    const empty = registerAgentHandlers(emptyBus, fakeDb(), {
      session: emptySession,
      ...handlerDeps({
        collectStaged: vi.fn(async () => ({
          diff: "",
          styleSubjects: [],
          style,
          manifest: { ...manifest, source: "staged" as const, files: [] }
        }))
      })
    });
    const nothing = await emptyBus.dispatch("agent:draftMessage", {
      requestId: "staged-empty",
      worktreeId: "wt-1",
      source: { kind: "staged" }
    });
    expect(!nothing.ok && nothing.error.code).toBe("nothing_staged");
    expect(emptySession.draftMessage).not.toHaveBeenCalled();
    await empty.dispose();
    await lifecycle.dispose();
  });

  it("refuses a revision past the limit or one naming commits outside the selection", async () => {
    const bus = new CommandBus();
    const session = fakeSession();
    const lifecycle = registerAgentHandlers(bus, fakeDb(), { session, ...handlerDeps() });
    const detail = {
      kind: "conflict" as const,
      step: 2,
      total: 2,
      hash: "bbbbbbbb",
      subject: "top",
      files: ["a.ts"]
    };

    const tooMany = await bus.dispatch("agent:tidyPlan", {
      requestId: "rev-3",
      worktreeId: "wt-1",
      commits,
      revision: { attempt: 3, detail, program: tidy("x").program }
    });
    expect(!tooMany.ok && tooMany.error.code).toBe("revision_limit");

    const foreign = await bus.dispatch("agent:tidyPlan", {
      requestId: "rev-foreign",
      worktreeId: "wt-1",
      commits,
      revision: {
        attempt: 1,
        detail,
        program: { commits: [{ members: ["aaaaaaaa", "ffffffff"], message: "x" }] }
      }
    });
    expect(!foreign.ok && foreign.error.code).toBe("invalid_revision");
    expect(session.proposeTidy).not.toHaveBeenCalled();

    const fine = await bus.dispatch("agent:tidyPlan", {
      requestId: "rev-1",
      worktreeId: "wt-1",
      commits,
      revision: { attempt: 1, detail, program: tidy("x").program }
    });
    expect(fine.ok).toBe(true);
    expect(session.proposeTidy).toHaveBeenCalledWith(
      expect.objectContaining({ revision: expect.objectContaining({ attempt: 1 }) })
    );
    await lifecycle.dispose();
  });

  it("cancels an in-flight request through its typed command", async () => {
    const proposeTidy = vi.fn(
      async (input: Parameters<AgentSession["proposeTidy"]>[0]) =>
        new Promise<Awaited<ReturnType<AgentSession["proposeTidy"]>>>((resolve) => {
          input.signal?.addEventListener(
            "abort",
            () =>
              resolve(
                err({ kind: "agent", code: "cancelled", message: "Cancelled. Nothing changed." })
              ),
            { once: true }
          );
        })
    );
    const bus = new CommandBus();
    const lifecycle = registerAgentHandlers(bus, fakeDb(), {
      session: fakeSession({ proposeTidy }),
      ...handlerDeps()
    });

    const pending = bus.dispatch(
      "agent:tidyPlan",
      { requestId: "agent-tidy-cancel", worktreeId: "wt-1", commits },
      { webContentsId: 7 }
    );
    await vi.waitFor(() => expect(proposeTidy).toHaveBeenCalledOnce());
    const cancelled = await bus.dispatch(
      "agent:cancel",
      { requestId: "agent-tidy-cancel" },
      { webContentsId: 7 }
    );
    const result = await pending;

    expect(cancelled).toEqual(ok({ cancelled: true }));
    expect(!result.ok && result.error.code).toBe("cancelled");
    await lifecycle.dispose();
  });

  it("settles at the deadline even when the backend ignores abort", async () => {
    const session = fakeSession({
      draftMessage: vi.fn(async () => new Promise<Result<AgentMessageDraft>>(() => undefined))
    });
    const bus = new CommandBus();
    const lifecycle = registerAgentHandlers(bus, fakeDb(), {
      session,
      ...handlerDeps(),
      requestTimeoutMs: 5
    });

    const result = await Promise.race([
      bus.dispatch("agent:draftMessage", {
        requestId: "agent-draft-timeout",
        worktreeId: "wt-1",
        source: { kind: "commits", commits }
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("deadline did not settle")), 500)
      )
    ]);

    expect(!result.ok && result.error.code).toBe("timeout");
    expect(session.close).toHaveBeenCalledOnce();
    await expect(
      bus.dispatch("agent:cancel", { requestId: "agent-draft-timeout" })
    ).resolves.toEqual(ok({ cancelled: false }));
    await lifecycle.dispose();
  });
});
