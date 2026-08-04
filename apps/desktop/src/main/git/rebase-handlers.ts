import { randomUUID } from "node:crypto";
import {
  err,
  ok,
  type RebaseCommitRef,
  type RebaseOperation
} from "@pwrgit/shared";
import type { CommandBus } from "../command-bus";
import type { DB } from "../persistence/db";
import { execGit, type GitExec } from "./dugite";
import type { CommitIdentity } from "./git-service";
import {
  applyRebase,
  dryRunRebase,
  planRebase,
  validateSelection
} from "./rebase-assistant";
import type { WorktreeRefresher } from "./worktree-handlers";

type RebaseRow = {
  path: string;
  email: string;
  author_name: string | null;
};

type Approval = {
  worktreeId: string;
  path: string;
  sourceHead: string;
  sourceRef: string | null;
  commits: RebaseCommitRef[];
  op: RebaseOperation;
};

export type RebaseHandlerDependencies = {
  git: GitExec;
  dryRun: typeof dryRunRebase;
  apply: typeof applyRebase;
  createToken: () => string;
};

const DEFAULT_DEPENDENCIES: RebaseHandlerDependencies = {
  git: execGit,
  dryRun: dryRunRebase,
  apply: applyRebase,
  createToken: randomUUID
};

function identityFor(row: RebaseRow): CommitIdentity {
  return row.author_name !== null
    ? { email: row.email, name: row.author_name }
    : { email: row.email };
}

function sameCommits(a: RebaseCommitRef[], b: RebaseCommitRef[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (commit, index) =>
        commit.hash === b[index]?.hash && commit.subject === b[index]?.subject
    )
  );
}

export function registerRebaseHandlers(
  bus: CommandBus,
  db: DB,
  refresher: WorktreeRefresher,
  dependencyOverrides: Partial<RebaseHandlerDependencies> = {}
): void {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  const approvals = new Map<string, Approval>();

  const invalidateWorktreeApprovals = (worktreeId: string): void => {
    for (const [token, approval] of approvals) {
      if (approval.worktreeId === worktreeId) approvals.delete(token);
    }
  };

  const rebaseRow = (worktreeId: string): RebaseRow | undefined =>
    db
      .prepare(
        `SELECT w.path AS path, p.email AS email, p.author_name AS author_name
         FROM worktrees w
         JOIN repos r ON r.id = w.repo_id
         JOIN profiles p ON p.id = r.profile_id
         WHERE w.id = ?`
      )
      .get(worktreeId) as RebaseRow | undefined;

  bus.register("rebase:draft", async (req) => {
    const row = db
      .prepare("SELECT path FROM worktrees WHERE id = ?")
      .get(req.worktreeId) as { path: string } | undefined;
    if (row === undefined) {
      return err({
        kind: "repo",
        code: "not_found",
        message: "Worktree not found."
      });
    }
    const plan = planRebase(req.commits, req.op);
    if (!plan.valid) return ok(plan);
    const valid = await validateSelection(
      dependencies.git,
      row.path,
      req.commits
    );
    if (!valid.ok) {
      return ok({ ...plan, valid: false, reason: valid.error.message });
    }
    return ok(plan);
  });

  bus.register("rebase:check", async (req) => {
    invalidateWorktreeApprovals(req.worktreeId);
    const row = rebaseRow(req.worktreeId);
    if (row === undefined) {
      return err({
        kind: "repo",
        code: "not_found",
        message: "Worktree not found."
      });
    }

    const plan = planRebase(req.commits, req.op);
    if (!plan.valid) {
      return ok({
        status: "snag" as const,
        code: "invalid_selection",
        message: plan.reason ?? "This commit selection cannot be rebased."
      });
    }

    const checked = await dependencies.dryRun(
      dependencies.git,
      row.path,
      req.commits,
      req.op,
      identityFor(row)
    );
    if (!checked.ok) {
      return ok({
        status: "snag" as const,
        code: checked.error.code,
        message: checked.error.message
      });
    }

    const approvalToken = dependencies.createToken();
    approvals.set(approvalToken, {
      worktreeId: req.worktreeId,
      path: row.path,
      sourceHead: checked.value.sourceHead,
      sourceRef: checked.value.sourceRef,
      commits: req.commits.map((commit) => ({ ...commit })),
      op: req.op
    });
    return ok({
      status: "clean" as const,
      approvalToken,
      sourceHead: checked.value.sourceHead,
      message:
        "Check passed under PwrGit's no-hooks, no-signing policy. Other repo-local Git settings can still affect Apply."
    });
  });

  bus.register("rebase:apply", async (req) => {
    const approval = approvals.get(req.approvalToken);
    // Approvals are one-shot even when the request fails later.
    approvals.delete(req.approvalToken);

    const row = rebaseRow(req.worktreeId);
    if (row === undefined) {
      return err({
        kind: "repo",
        code: "not_found",
        message: "Worktree not found."
      });
    }
    if (approval === undefined) {
      return err({
        kind: "rebase",
        code: "dry_run_required",
        message: "Run the isolated check before applying this rebase."
      });
    }
    if (
      approval.worktreeId !== req.worktreeId ||
      approval.path !== row.path ||
      approval.op !== req.op ||
      !sameCommits(approval.commits, req.commits)
    ) {
      return err({
        kind: "rebase",
        code: "dry_run_mismatch",
        message: "The rebase selection changed. Run the isolated check again."
      });
    }

    invalidateWorktreeApprovals(req.worktreeId);
    const result = await dependencies.apply(
      dependencies.git,
      row.path,
      req.commits,
      req.op,
      identityFor(row),
      { head: approval.sourceHead, headRef: approval.sourceRef }
    );
    if (!result.ok) return result;
    refresher.refreshWorktree(req.worktreeId);
    return ok(null);
  });
}
