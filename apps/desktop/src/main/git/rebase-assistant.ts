import {
  err,
  ok,
  type RebaseCommitRef,
  type RebasePlan,
  type Result
} from "@pwrgit/shared";
import type { GitExec } from "./dugite";
import type { CommitIdentity } from "./git-service";

/**
 * Build the plan preview from a selection. `commits` are newest-first (graph
 * order). Squash → one commit; Reorder → reversed history order. Deterministic
 * so the preview matches exactly what apply does; an agent could later refine
 * the squash message (agent-kit bindings), but the mechanics don't need it.
 */
export function planRebase(
  commits: RebaseCommitRef[],
  op: "squash" | "reorder"
): RebasePlan {
  const short = (h: string): string => h.slice(0, 7);
  if (commits.length < 2) {
    return {
      op,
      steps: [],
      summary: "",
      valid: false,
      reason: "Select at least two commits."
    };
  }
  const oldestFirst = [...commits].reverse();
  if (op === "squash") {
    return {
      op,
      steps: oldestFirst.map((c, i) => ({
        action: i === 0 ? "pick" : "squash",
        shortHash: short(c.hash),
        subject: c.subject
      })),
      summary: `→ 1 commit, message drafted from ${commits.length} subjects`,
      valid: true
    };
  }
  return {
    op,
    steps: oldestFirst.map((c) => ({
      action: "pick",
      shortHash: short(c.hash),
      subject: c.subject
    })),
    summary: "→ reversed order, no content change",
    valid: true
  };
}

/** The selection must be exactly the N most-recent commits (contiguous, incl HEAD). */
export async function validateSelection(
  git: GitExec,
  cwd: string,
  commits: RebaseCommitRef[]
): Promise<Result<{ oldest: string; base: string }>> {
  const n = commits.length;
  const raw = await git(["log", "-n", String(n), "--format=%H"], cwd);
  if (!raw.ok) return raw;
  const top = raw.value.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const selected = new Set(commits.map((c) => c.hash));
  if (top.length !== n || !top.every((h) => selected.has(h))) {
    return err({
      kind: "rebase",
      code: "not_top_run",
      message: "Select a contiguous run of the most recent commits."
    });
  }
  const oldest = top[n - 1];
  if (oldest === undefined) {
    return err({ kind: "rebase", code: "empty", message: "no commits" });
  }
  const baseRaw = await git(["rev-parse", `${oldest}^`], cwd);
  if (!baseRaw.ok) return baseRaw;
  if (baseRaw.value.exitCode !== 0) {
    return err({
      kind: "rebase",
      code: "includes_root",
      message: "Can't rebase a range that includes the initial commit."
    });
  }
  return ok({ oldest, base: baseRaw.value.stdout.trim() });
}

/** Apply the rebase locally, gated + rollback on failure. Never pushes. */
export async function applyRebase(
  git: GitExec,
  cwd: string,
  commits: RebaseCommitRef[],
  op: "squash" | "reorder",
  identity: CommitIdentity
): Promise<Result<void>> {
  const status = await git(["status", "--porcelain"], cwd);
  if (!status.ok) return status;
  if (status.value.stdout.trim() !== "") {
    return err({
      kind: "rebase",
      code: "dirty",
      message: "Commit or stash your changes before rebasing."
    });
  }

  const validated = await validateSelection(git, cwd, commits);
  if (!validated.ok) return validated;

  const headRaw = await git(["rev-parse", "HEAD"], cwd);
  if (!headRaw.ok) return headRaw;
  const head = headRaw.value.stdout.trim();

  const idArgs = ["-c", `user.email=${identity.email}`];
  if (identity.name !== undefined && identity.name !== "") {
    idArgs.push("-c", `user.name=${identity.name}`);
  }

  const restore = async (): Promise<void> => {
    await git(["reset", "--hard", head], cwd);
  };

  if (op === "squash") {
    const reset = await git(["reset", "--soft", validated.value.base], cwd);
    if (!reset.ok || reset.value.exitCode !== 0) {
      await restore();
      return err({
        kind: "rebase",
        code: "reset_failed",
        message: "could not start the squash"
      });
    }
    const message = [...commits].reverse().map((c) => c.subject).join("\n\n");
    const commit = await git([...idArgs, "commit", "-m", message], cwd);
    if (!commit.ok || commit.value.exitCode !== 0) {
      await restore();
      return err({
        kind: "rebase",
        code: "commit_failed",
        message: commit.ok ? commit.value.stderr.trim() : "squash commit failed"
      });
    }
    return ok(undefined);
  }

  // reorder: reset to base, then cherry-pick newest-first (reverses history).
  const reset = await git(["reset", "--hard", validated.value.base], cwd);
  if (!reset.ok || reset.value.exitCode !== 0) {
    await restore();
    return err({
      kind: "rebase",
      code: "reset_failed",
      message: "could not start the reorder"
    });
  }
  for (const c of commits) {
    const pick = await git([...idArgs, "cherry-pick", c.hash], cwd);
    if (!pick.ok || pick.value.exitCode !== 0) {
      await git(["cherry-pick", "--abort"], cwd);
      await restore();
      return err({
        kind: "rebase",
        code: "conflict",
        message: "Reorder hit a conflict — worktree restored unchanged."
      });
    }
  }
  return ok(undefined);
}
