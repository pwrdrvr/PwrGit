import { err, ok } from "@pwrgit/shared";
import type { CommandBus } from "../command-bus";
import type { DB } from "../persistence/db";
import { execGit } from "./dugite";
import {
  branchTips,
  listLocalBranchNames,
  readLog,
  readLogRefs,
  selectActiveBranches
} from "./git-service";
import type { WorktreeStateService } from "./worktree-state";

export function registerGraphHandlers(
  bus: CommandBus,
  db: DB,
  state: WorktreeStateService
): void {
  bus.register("graph:log", async (req) => {
    const wt = db
      .prepare("SELECT path, repo_id FROM worktrees WHERE id = ?")
      .get(req.worktreeId) as { path: string; repo_id: string } | undefined;
    if (wt === undefined) {
      return err({
        kind: "repo",
        code: "not_found",
        message: "worktree not found"
      });
    }

    const commits = await readLog(execGit, wt.path, req.limit ?? 200);
    if (!commits.ok) return commits;

    const def = await state.resolveDefaultBranch(wt.repo_id, wt.path);
    let branchRoot: string | null = null;
    const mb = await execGit(["merge-base", "HEAD", def.ref], wt.path);
    if (mb.ok && mb.value.exitCode === 0) {
      const hash = mb.value.stdout.trim();
      branchRoot = hash !== "" ? hash : null;
    }

    return ok({ commits: commits.value, branchRoot, defaultBranch: def.name });
  });

  bus.register("graph:lanes", async (req) => {
    const wt = db
      .prepare(
        `SELECT w.path AS path, w.repo_id AS repo_id, p.email AS email
         FROM worktrees w
         JOIN repos r ON r.id = w.repo_id
         JOIN profiles p ON p.id = r.profile_id
         WHERE w.id = ?`
      )
      .get(req.worktreeId) as
      | { path: string; repo_id: string; email: string }
      | undefined;
    if (wt === undefined) {
      return err({ kind: "repo", code: "not_found", message: "worktree not found" });
    }

    const def = await state.resolveDefaultBranch(wt.repo_id, wt.path);

    const worktreeBranches = new Set(
      (
        db
          .prepare("SELECT branch FROM worktrees WHERE repo_id = ?")
          .all(wt.repo_id) as { branch: string }[]
      ).map((r) => r.branch)
    );
    const mergedPrBranches = new Set(
      (
        db
          .prepare(
            "SELECT branch FROM branch_pr WHERE repo_id = ? AND state = 'merged'"
          )
          .all(wt.repo_id) as { branch: string }[]
      ).map((r) => r.branch)
    );

    const allLocal = await listLocalBranchNames(execGit, wt.path);
    if (!allLocal.ok) return allLocal;
    const totalOther = allLocal.value.filter((b) => b !== def.name).length;

    let shown: string[];
    if (req.scope === "all") {
      shown = allLocal.value.filter((b) => b !== def.name);
    } else {
      const active = await selectActiveBranches(execGit, wt.path, {
        defaultRef: def.ref,
        defaultName: def.name,
        email: wt.email,
        worktreeBranches,
        mergedPrBranches
      });
      if (!active.ok) return active;
      shown = active.value;
    }

    // Draw the default branch as the spine, plus the shown branches and HEAD.
    const refs = [...new Set([def.ref, "HEAD", ...shown])];
    const commits = await readLogRefs(execGit, wt.path, refs, req.limit ?? 300);
    if (!commits.ok) return commits;

    const tips = await branchTips(execGit, wt.path);
    if (!tips.ok) return tips;

    const headSha = await execGit(["rev-parse", "HEAD"], wt.path);
    const head =
      headSha.ok && headSha.value.exitCode === 0
        ? headSha.value.stdout.trim()
        : "";

    return ok({
      commits: commits.value,
      tips: tips.value,
      head,
      defaultBranch: def.name,
      shownBranches: shown,
      hiddenBranches: Math.max(0, totalOther - shown.length)
    });
  });
}
