import {
  err,
  ok,
  type AgentRequestPhase,
  type PwrGitError
} from "@pwrgit/shared";
import type { CommandBus, CommandContext } from "../command-bus";
import type { DB } from "../persistence/db";
import { emitEvent } from "../ipc";
import { execGit, type GitExec } from "../git/dugite";
import { planRebase, validateSelection } from "../git/rebase-assistant";
import { LocalAgentSession, type AgentSession } from "./agent-session";

const AGENT_REQUEST_TIMEOUT_MS = 70_000;
const REQUEST_ID_PATTERN = /^[a-zA-Z0-9._:-]{1,120}$/;

type AgentWorktreeRow = {
  path: string;
  profile_id: string;
};

type ActiveRequest = {
  controller: AbortController;
  profileId: string;
  worktreeId: string;
  webContentsId?: number;
  timedOut: boolean;
};

export type AgentHandlerDependencies = {
  session: AgentSession;
  git: GitExec;
  validate: typeof validateSelection;
  requestTimeoutMs: number;
};

export type AgentHandlerLifecycle = {
  releaseWebContents: (webContentsId: number) => void;
  dispose: () => Promise<void>;
};

const DEFAULT_DEPENDENCIES: Omit<AgentHandlerDependencies, "session"> = {
  git: execGit,
  validate: validateSelection,
  requestTimeoutMs: AGENT_REQUEST_TIMEOUT_MS
};

function error(code: string, message: string, cause?: unknown): PwrGitError {
  return cause === undefined
    ? { kind: "agent", code, message }
    : { kind: "agent", code, message, cause };
}

function emitState(
  requestId: string,
  request: ActiveRequest,
  phase: AgentRequestPhase,
  message?: string
): void {
  emitEvent("agent:requestState", {
    requestId,
    profileId: request.profileId,
    worktreeId: request.worktreeId,
    phase,
    ...(message !== undefined ? { message } : {})
  });
}

function sameOwner(request: ActiveRequest, context: CommandContext): boolean {
  return (
    request.webContentsId === undefined ||
    context.webContentsId === undefined ||
    request.webContentsId === context.webContentsId
  );
}

/**
 * Agent handlers deliberately own no rebase apply primitive. Their only Git
 * dependency is validateSelection (log/rev-parse reads); mutation remains in
 * rebase-handlers behind the isolated-check approval token.
 */
export function registerAgentHandlers(
  bus: CommandBus,
  db: DB,
  overrides: Partial<AgentHandlerDependencies> = {}
): AgentHandlerLifecycle {
  const dependencies: AgentHandlerDependencies = {
    ...DEFAULT_DEPENDENCIES,
    ...overrides,
    session: overrides.session ?? new LocalAgentSession()
  };
  const active = new Map<string, ActiveRequest>();

  const worktreeRow = (worktreeId: string): AgentWorktreeRow | undefined =>
    db
      .prepare(
        `SELECT w.path AS path, r.profile_id AS profile_id
         FROM worktrees w
         JOIN repos r ON r.id = w.repo_id
         WHERE w.id = ?`
      )
      .get(worktreeId) as AgentWorktreeRow | undefined;

  bus.register("agent:availability", async (req, context) => {
    const profile = db
      .prepare("SELECT id FROM profiles WHERE id = ?")
      .get(req.profileId) as { id: string } | undefined;
    if (profile === undefined) {
      return err({
        kind: "profile",
        code: "not_found",
        message: `No profile "${req.profileId}"`
      });
    }
    try {
      return ok(
        await dependencies.session.availability({
          profileId: req.profileId,
          ...(req.refresh !== undefined ? { refresh: req.refresh } : {}),
          ...(context.signal !== undefined ? { signal: context.signal } : {})
        })
      );
    } catch (cause) {
      if (context.signal?.aborted === true) {
        return err(error("cancelled", "Agent discovery was cancelled."));
      }
      return err(
        error(
          "discovery_failed",
          "Local agent discovery could not finish. The deterministic rebase workflow remains available.",
          cause
        )
      );
    }
  });

  bus.register("agent:rebaseDraft", async (req, context) => {
    if (!REQUEST_ID_PATTERN.test(req.requestId)) {
      return err(
        error("invalid_request_id", "The agent request id is not valid.")
      );
    }
    if (active.has(req.requestId)) {
      return err(
        error("request_in_progress", "That agent request is already running.")
      );
    }
    const row = worktreeRow(req.worktreeId);
    if (row === undefined) {
      return err({
        kind: "repo",
        code: "not_found",
        message: "Worktree not found."
      });
    }
    if (req.commits.length > 100) {
      return err(
        error(
          "selection_too_large",
          "Codex can review at most 100 selected commits at a time. The deterministic workflow remains available."
        )
      );
    }
    const plan = planRebase(req.commits, req.op);
    if (!plan.valid) {
      return err(
        error(
          "invalid_selection",
          plan.reason ?? "This commit selection cannot be reviewed."
        )
      );
    }
    const selection = await dependencies.validate(
      dependencies.git,
      row.path,
      req.commits
    );
    if (!selection.ok) return selection;

    const controller = new AbortController();
    const request: ActiveRequest = {
      controller,
      profileId: row.profile_id,
      worktreeId: req.worktreeId,
      ...(context.webContentsId !== undefined
        ? { webContentsId: context.webContentsId }
        : {}),
      timedOut: false
    };
    active.set(req.requestId, request);
    const onContextAbort = (): void => controller.abort();
    context.signal?.addEventListener("abort", onContextAbort, { once: true });
    const timeout = setTimeout(() => {
      request.timedOut = true;
      controller.abort();
    }, dependencies.requestTimeoutMs);
    timeout.unref?.();
    emitState(req.requestId, request, "running");

    try {
      let result = await dependencies.session.proposeRebase({
        requestId: req.requestId,
        profileId: row.profile_id,
        commits: req.commits,
        op: req.op,
        signal: controller.signal
      });
      if (request.timedOut) {
        result = err(
          error(
            "timeout",
            "The agent proposal timed out. Nothing changed; retry or continue with the deterministic plan."
          )
        );
      }
      if (result.ok) {
        emitState(req.requestId, request, "completed");
      } else {
        const phase: AgentRequestPhase =
          result.error.code === "cancelled"
            ? "cancelled"
            : result.error.code === "timeout"
              ? "timed_out"
              : "failed";
        emitState(req.requestId, request, phase, result.error.message);
      }
      return result;
    } finally {
      clearTimeout(timeout);
      context.signal?.removeEventListener("abort", onContextAbort);
      if (active.get(req.requestId) === request) active.delete(req.requestId);
    }
  });

  bus.register("agent:cancel", (req, context) => {
    const request = active.get(req.requestId);
    if (request === undefined || !sameOwner(request, context)) {
      return ok({ cancelled: false });
    }
    request.controller.abort();
    return ok({ cancelled: true });
  });

  const releaseWebContents = (webContentsId: number): void => {
    for (const request of active.values()) {
      if (request.webContentsId === webContentsId) request.controller.abort();
    }
  };

  const dispose = async (): Promise<void> => {
    for (const request of active.values()) request.controller.abort();
    active.clear();
    await dependencies.session.close();
  };

  return { releaseWebContents, dispose };
}
