import { mkdtemp, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Repo, StackConflict, StackPlanPreview } from "@pwrgit/shared";
import type { GitExec } from "./dugite";
import type { GhStackCatalogStore } from "./stack-catalog-store";
import { StackGit, branchRef, isOid } from "./stack-engine/git";
import type { ResolvedStackStep, StackPlan, StackStep } from "./stack-engine";
import { worktreeRemove } from "./git-service";
import { readOperationState } from "./operation-service";

export type ConflictJournal = {
  kind: "resolution"; scope: { repoId: string; profileId: string }; stackId: string;
  path: string; disposable: boolean; step: StackStep; plan: StackPlan; preview: StackPlanPreview;
};

export async function readConflict(store: GhStackCatalogStore, commonDir: string, repo: Repo): Promise<ConflictJournal | undefined> {
  const value = await store.readJournal(commonDir) as ConflictJournal | undefined;
  if (value?.kind !== "resolution") return undefined;
  if (value.scope.repoId !== repo.id || value.scope.profileId !== repo.profileId) {
    throw new Error("The conflict is open in another profile");
  }
  return value;
}

export async function conflictStatus(git: StackGit, execute: GitExec, repo: Repo, journal: ConflictJournal): Promise<StackConflict> {
  const state = await readOperationState(execute, journal.path);
  if (!state.ok) throw new Error(state.error.message);
  const head = (await git.output(["rev-parse", "HEAD"], undefined, journal.path)).trim();
  const phase = state.value.operation?.kind === "rebase" ? "resolving" :
    head === journal.step.oldTip ? "aborted" : "resolved";
  const worktree = repo.worktrees.find(item => resolve(item.path) === resolve(journal.path));
  return {
    plan: journal.preview, branch: journal.step.branch, worktreePath: journal.path,
    worktreeId: worktree?.id ?? null, phase,
  };
}

async function requireFresh(git: StackGit, store: GhStackCatalogStore, commonDir: string, plan: StackPlan) {
  if ((await store.read(commonDir)).sha256 !== plan.catalogHash) throw new Error("The stack catalog changed. Plan the operation again.");
  for (const [branch, expected] of Object.entries(plan.expectedTips)) {
    if (await git.tip(branch) !== expected) throw new Error(`${branch} moved. Plan the operation again.`);
  }
}

async function checkedOutBranch(git: StackGit, branch: string) {
  const records = (await git.output(["worktree", "list", "--porcelain", "-z"])).split("\0\0");
  for (const record of records) {
    const fields = record.split("\0");
    if (fields.includes(`branch ${branchRef(branch)}`)) return fields[0].slice("worktree ".length);
  }
  return undefined;
}

async function clean(git: StackGit, cwd: string) {
  const status = await git.output(["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all"], undefined, cwd);
  if (status) throw new Error(`Save local changes before resolving the stack in ${cwd}`);
}

export async function startConflict(
  git: StackGit, execute: GitExec, store: GhStackCatalogStore, commonDir: string,
  input: Pick<ConflictJournal, "scope" | "stackId" | "plan" | "preview">,
): Promise<void> {
  const step = input.plan.steps.find(candidate => candidate.conflict);
  if (!step) throw new Error("This plan no longer has a conflict");
  await store.withOperationLock(commonDir, async () => {
    await requireFresh(git, store, commonDir, input.plan);
    const holder = await checkedOutBranch(git, step.branch);
    if (holder) {
      const state = await readOperationState(execute, holder);
      if (!state.ok || state.value.operation) throw new Error(`Finish the Git operation in ${holder} before restacking`);
      await clean(git, holder);
    }
    const path = holder ?? join(await mkdtemp(join(tmpdir(), "pwrgit-conflict-")), "resolution");
    const journal: ConflictJournal = { ...input, kind: "resolution", path, disposable: !holder, step };
    await store.writeJournal(commonDir, journal);
    if (holder) await git.output(["switch", "--detach", step.oldTip], undefined, holder);
    else await git.output(["worktree", "add", "--detach", path, step.oldTip]);
    const rebased = await git.run([
      "rebase", "--no-update-refs", "--no-autostash", "--no-fork-point", "--onto", step.newBase, step.oldBase,
    ], undefined, path);
    if (rebased.exitCode !== 0) {
      const state = await readOperationState(execute, path);
      if (!state.ok || state.value.operation?.kind !== "rebase") {
        await leaveResolution(git, execute, journal);
        await store.removeJournal(commonDir);
        throw new Error(rebased.stderr.trim() || "Git could not start conflict resolution");
      }
    }
  });
}

export async function collectResolution(git: StackGit, journal: ConflictJournal): Promise<ResolvedStackStep[] | null> {
  const head = (await git.output(["rev-parse", "HEAD"], undefined, journal.path)).trim();
  if (head === journal.step.oldTip) return null;
  if (!isOid(head) || !await git.ancestor(journal.step.newBase, head)) {
    throw new Error("The resolution is outside the planned parent history");
  }
  await clean(git, journal.path);
  const prefix = journal.plan.steps.flatMap(step => step.newTip ? [{
    branch: step.branch, oldTip: step.oldTip, newBase: step.newBase, newTip: step.newTip,
    ...(step.proof ? { previousProof: step.proof } : {}),
  }] : []);
  return [...prefix, { branch: journal.step.branch, oldTip: journal.step.oldTip, newBase: journal.step.newBase, newTip: head }];
}

export async function leaveResolution(git: StackGit, execute: GitExec, journal: ConflictJournal, expected = journal.step.oldTip) {
  const status = await readOperationState(execute, journal.path);
  if (!status.ok || status.value.operation) throw new Error("Finish or abort the rebase in the resolution worktree first");
  await clean(git, journal.path);
  if (journal.disposable) {
    const removed = await worktreeRemove(execute, git.cwd, journal.path);
    if (!removed.ok) throw new Error(removed.error.message);
    await rmdir(dirname(journal.path)).catch(() => undefined);
  } else {
    if (await git.tip(journal.step.branch) !== expected) throw new Error("The branch moved during conflict resolution");
    await git.output(["switch", "--no-guess", journal.step.branch], undefined, journal.path);
  }
}
