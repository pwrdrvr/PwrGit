import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, realpath, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Repo, StackConflict, StackPlanPreview } from "@pwrgit/shared";
import type { GitExec } from "./dugite";
import type { GhStackCatalogStore } from "./stack-catalog-store";
import { StackGit, branchRef, isOid } from "./stack-engine/git";
import type { ResolvedStackStep, StackPlan, StackStep } from "./stack-engine";
import { listWorktrees, worktreeRemove } from "./git-service";
import { readOperationState } from "./operation-service";

export type ConflictJournal = {
  kind: "resolution"; scope: { repoId: string; profileId: string }; stackId: string;
  path: string; disposable: boolean; resolutionBranch?: string;
  step: StackStep; plan: StackPlan; preview: StackPlanPreview;
};

export function ownsConflict(journal: ConflictJournal, repo: Repo): boolean {
  return journal.scope.repoId === repo.id && journal.scope.profileId === repo.profileId;
}

export async function readConflict(store: GhStackCatalogStore, commonDir: string, repo: Repo): Promise<ConflictJournal | undefined> {
  const journal = await store.readResolutionJournal(commonDir);
  if (journal && !ownsConflict(journal, repo)) throw new Error("The conflict is open in another profile");
  return journal;
}

async function canonical(path: string): Promise<string> {
  return realpath(path).catch(error => {
    if (error.code !== "ENOENT") throw error;
    return resolve(path);
  });
}

async function registeredWorktree(git: StackGit, execute: GitExec, path: string) {
  const listed = await listWorktrees(execute, git.cwd);
  if (!listed.ok) throw new Error(listed.error.message);
  const wanted = await canonical(path);
  for (const entry of listed.value) if (await canonical(entry.path) === wanted) return entry;
  return undefined;
}

async function resolutionState(git: StackGit, execute: GitExec, journal: ConflictJournal) {
  const checkout = await registeredWorktree(git, execute, journal.path);
  if (!checkout || checkout.prunable) return null;
  const root = await git.run(["rev-parse", "--show-toplevel"], undefined, journal.path);
  if (root.exitCode !== 0 || await canonical(root.stdout.trimEnd()) !== await canonical(journal.path)) return null;
  const commonArgs = ["rev-parse", "--path-format=absolute", "--git-common-dir"];
  const common = await git.run(commonArgs, undefined, journal.path);
  if (common.exitCode !== 0 ||
      await canonical(common.stdout.trimEnd()) !== await canonical((await git.output(commonArgs)).trimEnd())) return null;
  const state = await readOperationState(execute, journal.path);
  if (!state.ok) throw new Error(state.error.message);
  const head = (await git.output(["rev-parse", "HEAD"], undefined, journal.path)).trim();
  return { operation: state.value.operation, head };
}

async function completedRebase(git: StackGit, journal: ConflictJournal, head: string): Promise<boolean> {
  if (!journal.resolutionBranch || !isOid(head)) return false;
  const ref = branchRef(journal.resolutionBranch);
  const held = await git.run(["symbolic-ref", "--quiet", "HEAD"], undefined, journal.path);
  if (held.exitCode !== 0 || held.stdout.trim() !== ref || await git.tip(journal.resolutionBranch) !== head) return false;
  // Git updates this operation's private branch only when the rebase finishes.
  const log = await git.output(["reflog", "show", "-2", "--format=%H%x00%gs", ref]);
  const [finish, start] = log.trimEnd().split(/\r?\n/);
  return finish === `${head}\0rebase (finish): ${ref} onto ${journal.step.newBase}` &&
    start?.split("\0")[0] === journal.step.oldTip &&
    await git.ancestor(journal.step.newBase, head);
}

export async function conflictStatus(git: StackGit, execute: GitExec, repo: Repo, journal: ConflictJournal): Promise<StackConflict> {
  const state = await resolutionState(git, execute, journal);
  const phase = !state ? "aborted" : state.operation ? "resolving" :
    state.head === journal.step.oldTip ? "aborted" :
      await completedRebase(git, journal, state.head) ? "resolved" : "unverified";
  const path = await canonical(journal.path);
  let worktreeId: string | null = null;
  if (state) {
    for (const worktree of repo.worktrees) {
      if (!worktree.missing && await canonical(worktree.path) === path) { worktreeId = worktree.id; break; }
    }
  }
  return { plan: journal.preview, branch: journal.step.branch, worktreePath: path, worktreeId, phase };
}

async function requireFresh(git: StackGit, store: GhStackCatalogStore, commonDir: string, plan: StackPlan) {
  if ((await store.read(commonDir)).sha256 !== plan.catalogHash) throw new Error("The stack catalog changed. Plan the operation again.");
  for (const [branch, expected] of Object.entries(plan.expectedTips)) {
    if (await git.tip(branch) !== expected) throw new Error(`${branch} moved. Plan the operation again.`);
  }
}

async function localChanges(git: StackGit, cwd: string, ignored = false) {
  return git.output([
    "--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all",
    ...(ignored ? ["--ignored=matching"] : []),
  ], undefined, cwd);
}

export async function startConflict(
  git: StackGit, execute: GitExec, store: GhStackCatalogStore, commonDir: string,
  input: Pick<ConflictJournal, "scope" | "stackId" | "plan" | "preview">,
): Promise<void> {
  const step = input.plan.steps.find(candidate => candidate.conflict);
  if (!step) throw new Error("This plan no longer has a conflict");
  await store.withOperationLock(commonDir, async () => {
    await requireFresh(git, store, commonDir, input.plan);
    const path = join(await realpath(await mkdtemp(join(tmpdir(), "pwrgit-conflict-"))), "resolution");
    const resolutionBranch = `pwrgit-resolution/${randomUUID()}`;
    const journal: ConflictJournal = { ...input, kind: "resolution", path, disposable: true, resolutionBranch, step };
    await store.writeJournal(commonDir, journal);
    try {
      await git.output(["-c", "core.logAllRefUpdates=true", "worktree", "add", "-b", resolutionBranch, path, step.oldTip]);
      const rebased = await git.run([
        "rebase", "--no-update-refs", "--no-autostash", "--no-fork-point", "--onto", step.newBase, step.oldBase,
      ], undefined, path);
      if (rebased.exitCode !== 0 && !(await resolutionState(git, execute, journal))?.operation) {
        throw new Error(rebased.stderr.trim() || "Git could not start conflict resolution");
      }
    } catch (error) {
      // If setup was interrupted in a worktree Git still needs, leave the
      // journal available for the user to finish, abort, or recover.
      await leaveResolution(git, execute, journal).then(() => store.removeJournal(commonDir)).catch(() => undefined);
      throw error;
    }
  });
}

export async function collectResolution(git: StackGit, execute: GitExec, journal: ConflictJournal): Promise<ResolvedStackStep[] | null> {
  const state = await resolutionState(git, execute, journal);
  if (state?.operation) throw new Error("Finish or abort the rebase first");
  if (!state || state.head === journal.step.oldTip) return null;
  if (!await completedRebase(git, journal, state.head)) {
    throw new Error("This checkout does not contain the completed stack rebase. Close the session to keep your work.");
  }
  if (await localChanges(git, journal.path)) throw new Error("Save local changes in the resolution checkout before finishing");
  const prefix = journal.plan.steps.flatMap(step => step.newTip ? [{
    branch: step.branch, oldTip: step.oldTip, newBase: step.newBase, newTip: step.newTip,
    ...(step.proof ? { previousProof: step.proof } : {}),
  }] : []);
  return [...prefix, { branch: journal.step.branch, oldTip: journal.step.oldTip, newBase: journal.step.newBase, newTip: state.head }];
}

export async function leaveResolution(
  git: StackGit, execute: GitExec, journal: ConflictJournal,
  { appliedTip, keepWork = false, keepBranch = false }: { appliedTip?: string; keepWork?: boolean; keepBranch?: boolean } = {},
): Promise<void> {
  const state = await resolutionState(git, execute, journal);
  if (state?.operation) throw new Error("Finish or abort the rebase in the resolution worktree first");
  const safeTip = appliedTip ?? journal.step.oldTip;
  if (state && (state.head !== safeTip || await localChanges(git, journal.path, true))) {
    if (keepWork) return; // Keep the checkout, including detached commits and ignored files.
    throw new Error("The resolution checkout contains local work. Save it before resuming cleanup.");
  }
  if (!journal.disposable) {
    // Compatible with old journals that used the original checkout.
    if (state && await git.tip(journal.step.branch) === safeTip) {
      await git.output(["switch", "--no-guess", journal.step.branch], undefined, journal.path);
    }
    return;
  }
  if (!state && await lstat(journal.path).then(() => true, error => {
    if (error.code !== "ENOENT") throw error;
    return false;
  })) {
    if (keepWork) return;
    throw new Error("The resolution path is no longer this repository's checkout.");
  }
  if (state || await registeredWorktree(git, execute, journal.path)) {
    const removed = await worktreeRemove(execute, git.cwd, journal.path);
    if (!removed.ok) throw new Error(removed.error.message);
  }
  if (journal.resolutionBranch && !keepBranch) {
    const tip = await git.tip(journal.resolutionBranch);
    if (tip === safeTip) await git.output(["update-ref", "-d", branchRef(journal.resolutionBranch), tip]);
    else if (tip && !keepWork) throw new Error("The resolution branch moved. Close the session to keep your work.");
  }
  await rmdir(dirname(journal.path)).catch(() => undefined);
}
