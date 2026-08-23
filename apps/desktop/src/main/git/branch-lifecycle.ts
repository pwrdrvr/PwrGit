import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { err, ok, type PwrGitError, type Result } from "@pwrgit/shared";
import { requireExit0, type GitExec } from "./dugite";
import { listWorktrees, type WorktreeInfo } from "./git-service";

type ReviewedBranch = {
  branch: string;
  expectedHead: string;
};

const operationMarkers = [
  ["rebase-merge", "rebase"],
  ["rebase-apply", "rebase"],
  ["MERGE_HEAD", "merge"],
  ["CHERRY_PICK_HEAD", "cherry-pick"],
  ["REVERT_HEAD", "revert"],
  ["BISECT_LOG", "bisect"],
  ["sequencer", "sequencer"]
] as const;

function lifecycleError(code: string, message: string): PwrGitError {
  return { kind: "repo", code, message };
}

async function validLocalName(
  git: GitExec,
  cwd: string,
  name: string
): Promise<Result<void>> {
  if (name.startsWith("refs/remotes/")) {
    return err(
      lifecycleError(
        "remote_branch",
        "Remote-tracking branches cannot be renamed or deleted here. Create or select a local branch instead."
      )
    );
  }
  if (name === "" || name !== name.trim() || name.startsWith("refs/")) {
    return err(
      lifecycleError("invalid_branch", `“${name}” is not a valid local branch name.`)
    );
  }
  const args = ["check-ref-format", "--branch", name];
  const checked = await git(args, cwd);
  if (!checked.ok) return checked;
  if (checked.value.exitCode === 0) return ok(undefined);
  return err(
    lifecycleError("invalid_branch", `“${name}” is not a valid local branch name.`)
  );
}

async function refHead(
  git: GitExec,
  cwd: string,
  fullName: string
): Promise<Result<string | null>> {
  const args = ["rev-parse", "--verify", "--quiet", fullName];
  const raw = await git(args, cwd);
  if (!raw.ok) return raw;
  if (raw.value.exitCode === 0) return ok(raw.value.stdout.trim());
  if (raw.value.exitCode === 1) return ok(null);
  const checked = requireExit0(raw.value, args);
  return checked.ok ? ok(null) : checked;
}

async function reviewedLocalHead(
  git: GitExec,
  cwd: string,
  reviewed: ReviewedBranch
): Promise<Result<string>> {
  const valid = await validLocalName(git, cwd, reviewed.branch);
  if (!valid.ok) return valid;
  const local = await refHead(git, cwd, `refs/heads/${reviewed.branch}`);
  if (!local.ok) return local;
  if (local.value === null) {
    const remote = await refHead(
      git,
      cwd,
      `refs/remotes/${reviewed.branch}`
    );
    if (!remote.ok) return remote;
    return err(
      remote.value === null
        ? lifecycleError(
            "branch_not_found",
            `The local branch ${reviewed.branch} no longer exists. Refresh branches and try again.`
          )
        : lifecycleError(
            "remote_branch",
            `${reviewed.branch} is a remote-tracking branch. No remote branch was changed.`
          )
    );
  }
  if (local.value !== reviewed.expectedHead) {
    return err(
      lifecycleError(
        "stale_branch",
        `${reviewed.branch} moved after it was shown. Refresh branches and review its latest tip before trying again.`
      )
    );
  }
  return ok(local.value);
}

async function gitDirectory(
  git: GitExec,
  worktree: WorktreeInfo
): Promise<Result<string>> {
  const args = ["rev-parse", "--absolute-git-dir"];
  const raw = await git(args, worktree.path);
  if (!raw.ok) return raw;
  const checked = requireExit0(raw.value, args);
  if (!checked.ok) {
    return err(
      lifecycleError(
        "operation_check_failed",
        `Could not inspect Git state in ${worktree.path}. No branch was changed.`
      )
    );
  }
  const path = checked.value.stdout.trim();
  if (path === "") {
    return err(
      lifecycleError(
        "operation_check_failed",
        `Could not inspect Git state in ${worktree.path}. No branch was changed.`
      )
    );
  }
  return ok(isAbsolute(path) ? path : resolve(worktree.path, path));
}

async function guardWorktrees(
  git: GitExec,
  cwd: string,
  branch: string
): Promise<Result<void>> {
  const listed = await listWorktrees(git, cwd);
  if (!listed.ok) return listed;
  for (const worktree of listed.value) {
    const directory = await gitDirectory(git, worktree);
    if (!directory.ok) return directory;
    const operation = operationMarkers.find(([marker]) =>
      existsSync(join(directory.value, marker))
    );
    if (operation !== undefined) {
      return err(
        lifecycleError(
          "operation_in_progress",
          `A ${operation[1]} is in progress in ${worktree.path}. Finish or abort it before changing branch refs.`
        )
      );
    }
    if (!worktree.detached && !worktree.bare && worktree.branch === branch) {
      return err(
        lifecycleError(
          "branch_checked_out",
          `${branch} is checked out in ${worktree.path}. Switch that worktree to another branch before renaming or deleting it.`
        )
      );
    }
  }
  return ok(undefined);
}

async function guardRenameTarget(
  git: GitExec,
  cwd: string,
  branch: string,
  newBranch: string
): Promise<Result<void>> {
  const valid = await validLocalName(git, cwd, newBranch);
  if (!valid.ok) return valid;
  if (branch === newBranch) {
    return err(
      lifecycleError("same_branch", "The new branch name is unchanged.")
    );
  }

  const args = ["for-each-ref", "--format=%(refname)", "refs/heads"];
  const raw = await git(args, cwd);
  if (!raw.ok) return raw;
  const checked = requireExit0(raw.value, args);
  if (!checked.ok) return checked;
  const target = `refs/heads/${newBranch}`;
  const refs = checked.value.stdout
    .split("\n")
    .map((ref) => ref.trim())
    .filter((ref) => ref !== "");
  if (refs.includes(target)) {
    return err(
      lifecycleError("already_exists", `A local branch named ${newBranch} already exists.`)
    );
  }
  if (
    refs.some(
      (ref) => ref.startsWith(`${target}/`) || target.startsWith(`${ref}/`)
    )
  ) {
    return err(
      lifecycleError(
        "ref_conflict",
        `${newBranch} conflicts with an existing local branch namespace.`
      )
    );
  }
  return ok(undefined);
}

function mutationFailure(
  operation: "rename" | "delete",
  branch: string,
  stderr: string
): PwrGitError {
  const message = stderr.trim();
  const code = /not fully merged|not yet merged/i.test(message)
    ? "unmerged"
    : /checked out|used by worktree/i.test(message)
      ? "branch_checked_out"
      : /cannot lock ref|exists; cannot create|already exists/i.test(message)
        ? "ref_conflict"
        : /not found|not exist|not a valid branch/i.test(message)
          ? "branch_not_found"
          : `branch_${operation}_failed`;
  return lifecycleError(
    code,
    message !== ""
      ? message
      : `Could not ${operation} the local branch ${branch}.`
  );
}

/** Rename one unoccupied local branch while preserving its config and reflog. */
export async function renameLocalBranch(
  git: GitExec,
  cwd: string,
  reviewed: ReviewedBranch,
  newBranch: string
): Promise<Result<void>> {
  const source = await reviewedLocalHead(git, cwd, reviewed);
  if (!source.ok) return source;
  const worktrees = await guardWorktrees(git, cwd, reviewed.branch);
  if (!worktrees.ok) return worktrees;
  const target = await guardRenameTarget(
    git,
    cwd,
    reviewed.branch,
    newBranch
  );
  if (!target.ok) return target;
  const fresh = await reviewedLocalHead(git, cwd, reviewed);
  if (!fresh.ok) return fresh;

  const raw = await git(
    ["branch", "-m", "--", reviewed.branch, newBranch],
    cwd
  );
  if (!raw.ok) return raw;
  if (raw.value.exitCode !== 0) {
    return err(mutationFailure("rename", reviewed.branch, raw.value.stderr));
  }
  return ok(undefined);
}

/** Delete one unoccupied local branch; ordinary deletion keeps Git's merge check. */
export async function deleteLocalBranch(
  git: GitExec,
  cwd: string,
  reviewed: ReviewedBranch,
  force = false
): Promise<Result<void>> {
  const source = await reviewedLocalHead(git, cwd, reviewed);
  if (!source.ok) return source;
  const worktrees = await guardWorktrees(git, cwd, reviewed.branch);
  if (!worktrees.ok) return worktrees;
  const fresh = await reviewedLocalHead(git, cwd, reviewed);
  if (!fresh.ok) return fresh;

  const raw = await git(
    ["branch", force ? "-D" : "-d", "--", reviewed.branch],
    cwd
  );
  if (!raw.ok) return raw;
  if (raw.value.exitCode !== 0) {
    return err(mutationFailure("delete", reviewed.branch, raw.value.stderr));
  }
  return ok(undefined);
}
