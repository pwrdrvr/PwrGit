import { parseGhStackCatalog, requireWritableCatalog, type GhStackCatalog } from "./catalog";
import { isOid, StackGit } from "./git";
import { planStack } from "./plan";
import type { ApplyHooks, CatalogStore, GitRunner, StackOperation, StackPlan, StackReceipt } from "./types";

export * from "./catalog";
export * from "./types";

function undoPrefix(id: string): string {
  if (!/^[a-z0-9-]{1,80}$/.test(id)) throw new Error("Invalid stack operation ID");
  return `refs/pwrgit/undo/${id}`;
}

function sameCatalog(a: GhStackCatalog, b: GhStackCatalog): boolean {
  // The in-memory catalog and the store preserve field order across writes.
  return JSON.stringify(a) === JSON.stringify(b);
}

export class StackEngine {
  private readonly git: StackGit;

  constructor(runner: GitRunner, private readonly store: CatalogStore, cwd: string, private readonly commonDir: string) {
    this.git = new StackGit(runner, cwd);
  }

  plan(operation: StackOperation): Promise<StackPlan> {
    return planStack(this.git, this.store, this.commonDir, operation);
  }

  async apply(plan: StackPlan, id: string, when: number, hooks: ApplyHooks = {}, cleanPrefix = false): Promise<StackReceipt> {
    const prefix = undoPrefix(id);
    const conflict = plan.steps.some(step => step.conflict);
    if (conflict && !(cleanPrefix && plan.cleanPrefix)) throw new Error("The stack plan has a conflict");
    return this.store.withOperationLock(this.commonDir, async () => {
      const { catalog, sha256 } = await this.store.read(this.commonDir);
      requireWritableCatalog(catalog);
      if (sha256 !== plan.catalogHash) throw new Error("The stack catalog changed. Plan the operation again.");
      const worktrees = await this.git.worktrees(plan.moves);
      await this.checkWorktrees(worktrees);
      await hooks.beforeTransaction?.();
      const receipt: StackReceipt = {
        id, when, moves: plan.moves, before: plan.before, after: (conflict && plan.cleanPrefix) || plan.after,
      };
      const manifest = (await this.git.output(["hash-object", "-w", "--stdin"], JSON.stringify(receipt))).trim();
      if (!isOid(manifest)) throw new Error("Invalid undo receipt object");
      const creates = [`create ${prefix}/receipt ${manifest}`];
      for (const move of receipt.moves) {
        await this.git.tip(move.branch);
        if (move.old) creates.push(`create ${prefix}/heads/${move.branch} ${move.old}`);
      }
      await hooks.begin?.({ direction: "apply", receipt, worktrees });
      try {
        // Undo refs and branch refs become visible in the same transaction.
        await this.git.transaction(receipt.moves, plan.expectedTips, creates);
      } catch (error) {
        await hooks.finish?.();
        throw error;
      }
      await this.finish(receipt.after, sha256, worktrees, hooks);
      return receipt;
    });
  }

  async undo(id: string, hooks: ApplyHooks = {}): Promise<StackReceipt> {
    const prefix = undoPrefix(id);
    return this.store.withOperationLock(this.commonDir, async () => {
      const { catalog, sha256 } = await this.store.read(this.commonDir);
      requireWritableCatalog(catalog);
      const receipt = JSON.parse(await this.git.output(["cat-file", "blob", `${prefix}/receipt`])) as StackReceipt;
      const before = parseGhStackCatalog(JSON.stringify(receipt.before));
      const after = parseGhStackCatalog(JSON.stringify(receipt.after));
      requireWritableCatalog(before);
      requireWritableCatalog(after);
      if (receipt.id !== id || !sameCatalog(catalog, after)) {
        throw new Error("The stack catalog changed after this operation");
      }
      const moves = receipt.moves.map(({ branch, old, next }) => ({ branch, old: next, next: old }));
      const worktrees = await this.git.worktrees(moves);
      await this.checkWorktrees(worktrees);
      await hooks.beforeTransaction?.();
      await hooks.begin?.({ direction: "undo", receipt, worktrees });
      try {
        await this.git.transaction(moves, {});
      } catch (error) {
        await hooks.finish?.();
        throw error;
      }
      await this.finish(before, sha256, worktrees, hooks);
      return receipt;
    });
  }

  private async checkWorktrees(worktrees: StackPlan["worktrees"]) {
    const blocked = await this.git.dirtyOverlap(worktrees);
    if (blocked.length) {
      throw new Error(blocked.map(({ path, files }) => `Local changes in ${path}: ${files.join(", ")}`).join("\n"));
    }
  }

  private async finish(next: GhStackCatalog, sha256: string, worktrees: StackPlan["worktrees"], hooks: ApplyHooks): Promise<void> {
    // Leave the journal in place if anything after the ref commit fails. It
    // names the old/new tips and worktrees for recovery and blocks other apps.
    for (const worktree of worktrees) await this.git.follow(worktree);
    await this.store.writeIfUnchanged(this.commonDir, next, sha256);
    await hooks.finish?.();
  }
}
