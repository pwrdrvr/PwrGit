import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { err, ok, type Profile, type Repo, type RepositoryStack, type StackAction, type StackApplied, type StackPlanPreview } from "@pwrgit/shared";
import type { CommandBus } from "../command-bus";
import { commitIdentityArgs, SCRUBBED_IDENTITY_ENV } from "./commit-identity";
import type { GitExec } from "./dugite";
import { StackEngine, type CatalogStore, type StackOperation, type StackPlan } from "./stack-engine";
import { StackGit } from "./stack-engine/git";
import { switchBranchCarryingChanges } from "./git-service";
import { collectResolution, conflictStatus, leaveResolution, readConflict, startConflict } from "./stack-conflicts";
import { stackRunner, type StackReader } from "./stack-reader";
import type { WorktreeOperationQueue } from "./worktree-operation-queue";

type RepoScope = { repoId: string; profileId: string };
type Draft = { repo: RepoScope; plan: StackPlan; preview: StackPlanPreview; commonDir: string; stackId: string; expires: number };
type Options = {
  findRepo: (id: string) => Repo | null;
  findProfile: (id: string) => Profile | null;
  reader: StackReader;
  git: GitExec;
  queue: WorktreeOperationQueue;
  changed: (repo: Repo) => Promise<void>;
};

function stackOperation(stack: RepositoryStack, action: StackAction): StackOperation {
  if (action.kind === "adopt") {
    if (stack.source !== "inferred") throw new Error("This stack is already tracked");
    return {
      kind: "adopt", repository: stack.catalogRepository,
      stack: {
        trunk: stack.trunk,
        branches: stack.layers.map(({ branch, base, head, pr }) => ({
          branch, ...(base ? { base } : {}), ...(head ? { head } : {}),
          ...(pr ? { pullRequest: { number: pr.number, url: pr.url } } : {}),
        })),
      },
    };
  }
  if (stack.source === "inferred") throw new Error("Adopt this stack before changing it");
  const root = stack.layers[0].branch;
  return { ...action, root };
}

function preview(id: string, action: StackAction, plan: StackPlan): StackPlanPreview {
  return { id, action, steps: plan.steps, moves: plan.moves, blocked: plan.blocked, cleanPrefix: plan.cleanPrefix !== undefined };
}

export function registerStackWriteHandlers(bus: CommandBus, options: Options) {
  const drafts = new Map<string, Draft>();
  const creating = new Set<string>();
  const carried = new Map<string, { repoId: string; path: string; from: string; to: string; oid: string }>();
  const lifetime = 15 * 60 * 1000;
  const scopedRepo = ({ repoId, profileId }: RepoScope) => {
    const repo = options.findRepo(repoId);
    if (!repo || repo.profileId !== profileId) throw new Error("Repository is outside this profile");
    return repo;
  };
  const getDraft = (id: string, repo: Repo) => {
    const draft = drafts.get(id);
    if (!draft || draft.expires < Date.now() || draft.repo.repoId !== repo.id || draft.repo.profileId !== repo.profileId) {
      throw new Error("This stack plan expired. Plan the operation again.");
    }
    return draft;
  };
  const runnerFor = (repo: Repo) => {
    const profile = options.findProfile(repo.profileId);
    if (!profile) return stackRunner(options.git);
    const args = commitIdentityArgs({ email: profile.email, ...(profile.authorName ? { name: profile.authorName } : {}) });
    return stackRunner((command, cwd, opts) => {
      if (command[0] !== "replay" && command[0] !== "rebase") return options.git(command, cwd, opts);
      return options.git([...args, ...command], cwd, { ...opts, env: { ...SCRUBBED_IDENTITY_ENV, GIT_EDITOR: "true" } });
    });
  };
  const inWorktreeLocks = <T>(repo: Repo, run: () => Promise<T>): Promise<T> => {
    const ids = repo.worktrees.filter(worktree => !worktree.missing).map(worktree => worktree.id).sort();
    const lockNext = (index: number): Promise<T> => index === ids.length ? run() : options.queue.run(ids[index], () => lockNext(index + 1));
    return lockNext(0);
  };
  const resultError = (error: unknown) => err({
    kind: "git" as const, code: "stack_operation_failed",
    message: error instanceof Error ? error.message : String(error),
  });

  bus.register("stack:plan", async request => {
    if (creating.has(request.repoId)) return resultError(new Error("A stack plan is already running"));
    creating.add(request.repoId);
    try {
      const repo = scopedRepo(request);
      const snapshot = await options.reader.list(repo);
      if (snapshot.readOnly || snapshot.busy) throw new Error(snapshot.busy ?? "This stack catalog is read-only");
      const stack = snapshot.stacks.find(model => model.id === request.stackId);
      if (!stack) throw new Error("This stack changed. Select it again.");
      const { store, commonDir } = await options.reader.location(repo);
      const engine = new StackEngine(runnerFor(repo), store, repo.path, commonDir);
      const operation = stackOperation(stack, request.action);
      if (operation.kind !== "adopt" && snapshot.stacks.filter(candidate =>
        candidate.source === "tracked" && candidate.layers[0]?.branch === operation.root).length > 1) {
        throw new Error("This branch starts more than one tracked stack");
      }
      const plan = await engine.plan(operation);
      const id = randomUUID();
      const published = preview(id, request.action, plan);
      for (const [key, draft] of drafts) if (draft.expires < Date.now()) drafts.delete(key);
      if (drafts.size >= 64) {
        const oldest = drafts.keys().next().value;
        if (oldest) drafts.delete(oldest);
      }
      drafts.set(id, { repo: request, plan, preview: published, commonDir, stackId: stack.id, expires: Date.now() + lifetime });
      return ok(published);
    } catch (error) { return resultError(error); }
    finally { creating.delete(request.repoId); }
  });

  bus.register("stack:apply", async request => {
    try {
      const repo = scopedRepo(request);
      const applied = await options.queue.runRepository(repo.id, () => inWorktreeLocks(scopedRepo(request), async () => {
        const draft = getDraft(request.planId, repo);
        const { store, commonDir } = await options.reader.location(repo);
        if (resolve(commonDir) !== resolve(draft.commonDir)) throw new Error("The repository moved after this plan");
        const engine = new StackEngine(runnerFor(repo), store, repo.path, commonDir);
        const op = draft.plan.operation;
        const receipt = await engine.apply(draft.plan, draft.preview.id, Date.now(), store.journalHooks(commonDir), request.cleanPrefix);
        drafts.delete(draft.preview.id);
        const answer: StackApplied = { operationId: receipt.id, plan: draft.preview };
        if (op.kind === "add_branch" && request.worktreeId) {
          const worktree = repo.worktrees.find(worktree => worktree.id === request.worktreeId && !worktree.missing);
          const top = receipt.before.stacks.find(stack => stack.branches[0]?.branch === op.root)?.branches.at(-1)?.branch;
          if (worktree && top) {
            const git = new StackGit(runnerFor(repo), worktree.path);
            const current = await git.run(["symbolic-ref", "--short", "HEAD"]);
            if (current.stdout.trim() === top) {
              const switched = await switchBranchCarryingChanges(options.git, worktree.path, op.branch);
              if (!switched.ok) answer.checkoutWarning = switched.error.message;
              const oid = receipt.moves[0]?.next;
              if (switched.ok && oid) {
                if (carried.size >= 50) {
                  const oldest = carried.keys().next().value;
                  if (oldest) carried.delete(oldest);
                }
                carried.set(receipt.id, { repoId: repo.id, path: worktree.path, from: top, to: op.branch, oid });
              }
            }
          }
        }
        const updated = await options.reader.list(repo).catch(() => null);
        const original = updated?.stacks.find(stack => stack.id === draft.stackId);
        const root = op.kind === "adopt" ? op.stack.branches[0]?.branch :
          op.kind === "remove" && op.branch === op.root
            ? receipt.before.stacks.find(stack => stack.branches[0]?.branch === op.root)?.branches[1]?.branch
            : op.root;
        const next = original ?? updated?.stacks.find(stack => stack.source === "tracked" && stack.layers[0]?.branch === root);
        if (next) answer.stack = next;
        return answer;
      }));
      await options.changed(repo);
      return ok(applied);
    } catch (error) { return resultError(error); }
  });

  bus.register("stack:resolve", async request => {
    try {
      const repo = scopedRepo(request);
      await options.queue.runRepository(repo.id, () => inWorktreeLocks(scopedRepo(request), async () => {
        const draft = getDraft(request.planId, repo);
        const { commonDir, store } = await options.reader.location(repo);
        if (resolve(commonDir) !== resolve(draft.commonDir)) throw new Error("The repository moved after this plan");
        const git = new StackGit(runnerFor(repo), repo.path);
        await startConflict(git, options.git, store, commonDir, {
          scope: { repoId: repo.id, profileId: repo.profileId }, stackId: draft.stackId,
          plan: draft.plan, preview: draft.preview,
        });
      }));
      await options.changed(repo);
      const fresh = scopedRepo(request);
      const { commonDir, store } = await options.reader.location(fresh);
      const journal = await readConflict(store, commonDir, fresh);
      if (!journal) throw new Error("The stack resolution was closed");
      return ok(await conflictStatus(new StackGit(runnerFor(fresh), fresh.path), options.git, fresh, journal));
    } catch (error) { return resultError(error); }
  });

  bus.register("stack:conflict", async request => {
    try {
      const repo = scopedRepo(request);
      const { commonDir, store } = await options.reader.location(repo);
      const journal = await readConflict(store, commonDir, repo);
      if (!journal || journal.stackId !== request.stackId) return ok(null);
      return ok(await conflictStatus(new StackGit(runnerFor(repo), repo.path), options.git, repo, journal));
    } catch (error) { return resultError(error); }
  });

  bus.register("stack:finishConflict", async request => {
    try {
      const repo = scopedRepo(request);
      const answer = await options.queue.runRepository(repo.id, () => inWorktreeLocks(scopedRepo(request), async () => {
        const { commonDir, store } = await options.reader.location(repo);
        const journal = await readConflict(store, commonDir, repo);
        if (!journal || journal.preview.id !== request.planId) throw new Error("This conflict session changed");
        const runner = runnerFor(repo);
        const git = new StackGit(runner, repo.path);
        const status = await conflictStatus(git, options.git, repo, journal);
        if (status.phase === "resolving") throw new Error("Finish or abort the rebase first");
        const resolutions = await collectResolution(git, journal);
        const continuation = resolutions
          ? await new StackEngine(runner, store, repo.path, commonDir).plan(journal.plan.operation, resolutions)
          : null;
        if (continuation && continuation.catalogHash !== journal.plan.catalogHash) {
          throw new Error("The stack catalog changed while resolving the conflict");
        }
        return store.withJournalLock(commonDir, true, async (): Promise<{ applied?: StackApplied; plan?: StackPlanPreview }> => {
          const current = await readConflict(store, commonDir, repo);
          if (current?.preview.id !== request.planId) throw new Error("This conflict session changed");
          if (!continuation) {
            await leaveResolution(git, options.git, journal);
            drafts.delete(journal.preview.id);
            await store.removeJournal(commonDir);
            return {};
          }
          const continued = preview(journal.preview.id, journal.preview.action, continuation);
          if (continuation.steps.some(step => step.conflict)) {
            await leaveResolution(git, options.git, journal);
            await store.removeJournal(commonDir);
            drafts.set(continued.id, {
              repo: request, plan: continuation, preview: continued, commonDir, stackId: journal.stackId, expires: Date.now() + lifetime,
            });
            return { plan: continued };
          }
          // The operation lock is already held, and the journal belongs to
          // this resolution. The engine still rechecks refs and the catalog.
          const held: CatalogStore = {
            withOperationLock: (_dir, fn) => fn(),
            read: store.read.bind(store),
            writeIfUnchanged: store.writeIfUnchanged.bind(store),
          };
          const engine = new StackEngine(runner, held, repo.path, commonDir);
          let checkoutWarning: string | undefined;
          const receipt = await engine.apply(continuation, continued.id, Date.now(), {
            ...store.journalHooks(commonDir),
            abort: () => store.writeJournal(commonDir, journal),
            finish: async () => {
              try { await leaveResolution(git, options.git, journal, resolutions?.at(-1)?.newTip); }
              catch (error) { checkoutWarning = error instanceof Error ? error.message : String(error); }
              await store.removeJournal(commonDir);
            },
          });
          drafts.delete(continued.id);
          const updated = await options.reader.list(repo).catch(() => null);
          const stack = updated?.stacks.find(candidate => candidate.id === journal.stackId ||
            candidate.source === "tracked" && candidate.layers[0]?.branch === journal.plan.after.stacks.at(-1)?.branches[0]?.branch);
          return { applied: { operationId: receipt.id, plan: continued, ...(stack ? { stack } : {}), ...(checkoutWarning ? { checkoutWarning } : {}) } };
        });
      }));
      await options.changed(repo);
      return ok(answer);
    } catch (error) { return resultError(error); }
  });

  bus.register("stack:undo", async request => {
    try {
      const repo = scopedRepo(request);
      await options.queue.runRepository(repo.id, () => inWorktreeLocks(scopedRepo(request), async () => {
        const { commonDir, store } = await options.reader.location(repo);
        const engine = new StackEngine(runnerFor(repo), store, repo.path, commonDir);
        const shift = carried.get(request.operationId);
        const git = new StackGit(runnerFor(repo), repo.path);
        let switched = false;
        if (shift?.repoId === repo.id && await git.tip(shift.from) === shift.oid && await git.tip(shift.to) === shift.oid) {
          const current = await git.run(["symbolic-ref", "--short", "HEAD"], undefined, shift.path);
          if (current.stdout.trim() === shift.to) {
            await git.output(["switch", "--no-guess", shift.from], undefined, shift.path);
            switched = true;
          }
        }
        try {
          await engine.undo(request.operationId, store.journalHooks(commonDir));
        } catch (failure) {
          if (switched && shift) await git.run(["switch", "--no-guess", shift.to], undefined, shift.path);
          throw failure;
        }
        carried.delete(request.operationId);
      }));
      await options.changed(repo);
      return ok(null);
    } catch (error) { return resultError(error); }
  });
}
