import {
  AI_JOB_IDS,
  err,
  ok,
  type AgentJobStatus,
  type AiJobId,
  type PwrGitError,
  type RebaseCommitRef,
  type Result
} from "@pwrgit/shared";
import type { CommandBus, CommandContext } from "../command-bus";
import type { DB } from "../persistence/db";
import { execGit, type GitExec } from "../git/dugite";
import {
  validateProgramShape,
  validateSelection
} from "../git/rebase-assistant";
import { missingWorktreeError } from "../git/worktree-liveness";
import {
  collectCommitsInput,
  collectStagedInput
} from "./agent-input";
import {
  MAX_MESSAGE_COMMITS,
  MAX_TIDY_COMMITS,
  type AgentSession
} from "./agent-session";

/** Longer than the session's own turn timeout, so a stuck backend is reset
 *  here rather than left pooled. */
const AGENT_REQUEST_TIMEOUT_MS = 160_000;
const REQUEST_ID_PATTERN = /^[a-zA-Z0-9._:-]{1,120}$/;
/** A plan that failed its check may be revised this many times before the
 *  operator is asked to take it from there. */
export const MAX_TIDY_REVISIONS = 2;

type AgentWorktreeRow = {
  path: string;
  profile_id: string;
};

type ActiveRequest = {
  controller: AbortController;
  webContentsId?: number;
  timedOut: boolean;
};

export type AgentHandlerDependencies = {
  session: AgentSession;
  git: GitExec;
  validate: typeof validateSelection;
  collectCommits: typeof collectCommitsInput;
  collectStaged: typeof collectStagedInput;
  requestTimeoutMs: number;
};

export type AgentHandlerLifecycle = {
  releaseWebContents: (webContentsId: number) => void;
  dispose: () => Promise<void>;
};

const DEFAULT_DEPENDENCIES: Omit<AgentHandlerDependencies, "session"> = {
  git: execGit,
  validate: validateSelection,
  collectCommits: collectCommitsInput,
  collectStaged: collectStagedInput,
  requestTimeoutMs: AGENT_REQUEST_TIMEOUT_MS
};

function error(code: string, message: string, cause?: unknown): PwrGitError {
  return cause === undefined
    ? { kind: "agent", code, message }
    : { kind: "agent", code, message, cause };
}

function sameOwner(request: ActiveRequest, context: CommandContext): boolean {
  return (
    request.webContentsId === undefined ||
    context.webContentsId === undefined ||
    request.webContentsId === context.webContentsId
  );
}

/**
 * Agent handlers own no Git mutation. Everything they run is a read — the
 * selection check and the diff collection — and what they return is a draft
 * or a proposal. Changing history stays in rebase-handlers, behind the
 * isolated check's approval token.
 */
export function registerAgentHandlers(
  bus: CommandBus,
  db: DB,
  overrides: Pick<AgentHandlerDependencies, "session"> &
    Partial<AgentHandlerDependencies>
): AgentHandlerLifecycle {
  const dependencies: AgentHandlerDependencies = {
    ...DEFAULT_DEPENDENCIES,
    ...overrides
  };
  const active = new Map<string, ActiveRequest>();

  const worktreeRow = (
    worktreeId: string
  ): Result<AgentWorktreeRow, PwrGitError> => {
    const row = db
      .prepare(
        `SELECT w.path AS path, r.profile_id AS profile_id
         FROM worktrees w
         JOIN repos r ON r.id = w.repo_id
         WHERE w.id = ?`
      )
      .get(worktreeId) as AgentWorktreeRow | undefined;
    if (row === undefined) {
      return err({ kind: "repo", code: "not_found", message: "Worktree not found." });
    }
    const gone = missingWorktreeError(db, worktreeId);
    return gone === null ? ok(row) : err(gone);
  };

  const checkSelection = async (
    row: AgentWorktreeRow,
    commits: RebaseCommitRef[],
    limit: number
  ): Promise<Result<null, PwrGitError>> => {
    if (commits.length > limit) {
      return err(
        error(
          "selection_too_large",
          `Codex works on at most ${limit} commits at a time. Squash and Reorder still work without it.`
        )
      );
    }
    if (commits.length < 2) {
      return err(error("invalid_selection", "Select at least two commits."));
    }
    const selection = await dependencies.validate(dependencies.git, row.path, commits);
    return selection.ok ? ok(null) : selection;
  };

  /**
   * One request lifecycle for every agent command: a request id the renderer
   * can cancel by, a hard deadline, and cleanup that holds even when the
   * backend never settles. Every outcome — cancelled and timed out included —
   * comes back as this command's own result. The request was reserved before
   * the first await, so it is cancellable for its whole life.
   */
  const run = async <T>(
    requestId: string,
    request: ActiveRequest,
    profileId: string,
    context: CommandContext,
    work: (signal: AbortSignal) => Promise<Result<T, PwrGitError>>
  ): Promise<Result<T, PwrGitError>> => {
    const controller = request.controller;
    // A cancel that arrived while the selection was being checked has already
    // fired; the listener below would never see it.
    if (controller.signal.aborted) {
      return err(error("cancelled", "Cancelled. Nothing changed."));
    }
    const onContextAbort = (): void => controller.abort();
    context.signal?.addEventListener("abort", onContextAbort, { once: true });
    const timeout = setTimeout(() => {
      request.timedOut = true;
      controller.abort();
      // A backend that ignored abort must not remain pooled for the next
      // request. Reset THIS profile's backend out-of-band: the deadline
      // response is not held up by an app-server that is itself stuck while
      // closing, and another profile's in-flight request keeps its own client.
      void Promise.resolve()
        .then(() => dependencies.session.reset(profileId))
        .catch(() => undefined);
    }, dependencies.requestTimeoutMs);
    timeout.unref?.();

    let removeControllerAbort = (): void => undefined;
    const interrupted = new Promise<Result<T, PwrGitError>>((resolve) => {
      const onAbort = (): void => {
        resolve(
          err(
            request.timedOut
              ? error("timeout", "Codex did not finish in time. Nothing changed.")
              : error("cancelled", "Cancelled. Nothing changed.")
          )
        );
      };
      controller.signal.addEventListener("abort", onAbort, { once: true });
      removeControllerAbort = () =>
        controller.signal.removeEventListener("abort", onAbort);
    });

    try {
      // Keep a rejection handler attached even when the deadline wins; the
      // backend is then free to settle later without producing an unhandled
      // rejection or keeping this command in the active-request map.
      const settled = work(controller.signal).catch(
        (cause): Result<T, PwrGitError> =>
          err(error("session_failed", "Codex could not finish. Nothing changed.", cause))
      );
      return await Promise.race([settled, interrupted]);
    } finally {
      clearTimeout(timeout);
      removeControllerAbort();
      context.signal?.removeEventListener("abort", onContextAbort);
      if (active.get(requestId) === request) active.delete(requestId);
    }
  };

  /**
   * Take the request id before the first await. The reservation IS the
   * request — `run` adopts it — so two messages carrying one id cannot both
   * be admitted, and a cancel that arrives during the selection check reaches
   * the work that follows it.
   */
  const reserve = (
    requestId: string,
    context: CommandContext
  ): Result<ActiveRequest, PwrGitError> => {
    if (!REQUEST_ID_PATTERN.test(requestId)) {
      return err(error("invalid_request_id", "The agent request id is not valid."));
    }
    if (active.has(requestId)) {
      return err(error("request_in_progress", "That agent request is already running."));
    }
    const request: ActiveRequest = {
      controller: new AbortController(),
      ...(context.webContentsId !== undefined
        ? { webContentsId: context.webContentsId }
        : {}),
      timedOut: false
    };
    active.set(requestId, request);
    return ok(request);
  };

  /** Give the id back, whether or not `run` already did. */
  const release = (requestId: string, request: ActiveRequest): void => {
    if (active.get(requestId) === request) active.delete(requestId);
  };

  const profileExists = (profileId: string): boolean =>
    db.prepare("SELECT id FROM profiles WHERE id = ?").get(profileId) !== undefined;

  // Each job's state for the window's profile. Both jobs resolve through the
  // same cached, de-duplicated discovery in AiProviderService, so asking for
  // both costs one probe at most.
  bus.register("agent:availability", async (req, context) => {
    if (!profileExists(req.profileId)) {
      return err({
        kind: "profile",
        code: "not_found",
        message: `No profile "${req.profileId}"`
      });
    }
    try {
      const statuses = await Promise.all(
        AI_JOB_IDS.map((jobId) =>
          dependencies.session.jobStatus({
            profileId: req.profileId,
            jobId,
            ...(req.refresh !== undefined ? { refresh: req.refresh } : {}),
            ...(context.signal !== undefined ? { signal: context.signal } : {})
          })
        )
      );
      const jobs = Object.fromEntries(
        statuses.map((status) => [status.jobId, status])
      ) as Record<AiJobId, AgentJobStatus>;
      return ok({ profileId: req.profileId, jobs });
    } catch (cause) {
      if (context.signal?.aborted === true) {
        return err(error("cancelled", "Agent discovery was cancelled."));
      }
      return err(
        error(
          "discovery_failed",
          "Local agent discovery could not finish. Squash and Reorder still work without it.",
          cause
        )
      );
    }
  });

  bus.register("agent:draftMessage", async (req, context) => {
    const reserved = reserve(req.requestId, context);
    if (!reserved.ok) return reserved;
    const request = reserved.value;
    try {
      const row = worktreeRow(req.worktreeId);
      if (!row.ok) return row;

      if (req.source.kind === "commits") {
        const commits = req.source.commits;
        const selection = await checkSelection(row.value, commits, MAX_MESSAGE_COMMITS);
        if (!selection.ok) return selection;
        return await run(
          req.requestId,
          request,
          row.value.profile_id,
          context,
          async (signal) => {
            const data = await dependencies.collectCommits(dependencies.git, row.value.path, commits);
            if (data === null) {
              return err(error("input_unavailable", "PwrGit could not read those commits."));
            }
            return dependencies.session.draftMessage({
              requestId: req.requestId,
              profileId: row.value.profile_id,
              source: "commits",
              data,
              signal,
              ...(req.choice !== undefined ? { choice: req.choice } : {})
            });
          }
        );
      }

      return await run(
        req.requestId,
        request,
        row.value.profile_id,
        context,
        async (signal) => {
          const data = await dependencies.collectStaged(dependencies.git, row.value.path);
          if (data === null) {
            return err(error("input_unavailable", "PwrGit could not read the staged changes."));
          }
          if (data.manifest.files.length === 0) {
            return err(error("nothing_staged", "Stage something first; Codex drafts from staged changes only."));
          }
          return dependencies.session.draftMessage({
            requestId: req.requestId,
            profileId: row.value.profile_id,
            source: "staged",
            data,
            signal,
            ...(req.choice !== undefined ? { choice: req.choice } : {})
          });
        }
      );
    } finally {
      release(req.requestId, request);
    }
  });

  bus.register("agent:tidyPlan", async (req, context) => {
    const reserved = reserve(req.requestId, context);
    if (!reserved.ok) return reserved;
    const request = reserved.value;
    try {
      const row = worktreeRow(req.worktreeId);
      if (!row.ok) return row;
      const selection = await checkSelection(row.value, req.commits, MAX_TIDY_COMMITS);
      if (!selection.ok) return selection;
      if (req.revision !== undefined) {
        if (
          !Number.isInteger(req.revision.attempt) ||
          req.revision.attempt < 1 ||
          req.revision.attempt > MAX_TIDY_REVISIONS
        ) {
          return err(
            error(
              "revision_limit",
              `Codex has already revised this plan ${MAX_TIDY_REVISIONS} times. Edit it by hand, or start over.`
            )
          );
        }
        // The failed plan is quoted back into the prompt, so it must name the
        // selection and nothing else.
        if (!validateProgramShape(req.commits, req.revision.program).ok) {
          return err(error("invalid_revision", "The plan to revise does not match the selection."));
        }
      }

      return await run(
        req.requestId,
        request,
        row.value.profile_id,
        context,
        async (signal) => {
          const data = await dependencies.collectCommits(dependencies.git, row.value.path, req.commits);
          if (data === null) {
            return err(error("input_unavailable", "PwrGit could not read those commits."));
          }
          return dependencies.session.proposeTidy({
            requestId: req.requestId,
            profileId: row.value.profile_id,
            commits: req.commits,
            data,
            signal,
            ...(req.revision !== undefined ? { revision: req.revision } : {}),
            ...(req.choice !== undefined ? { choice: req.choice } : {})
          });
        }
      );
    } finally {
      release(req.requestId, request);
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
