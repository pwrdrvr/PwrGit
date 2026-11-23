import {
  forgeProductFor, forgeRepoKey, inferPullRequestStacks, stackBranchHealth, type ChangeRequestEntry, type ChangeRequestList,
  type PrSummary, type Repo, type RepositoryStack, type StackLayer, type StackSnapshot,
} from "@pwrgit/shared";
import type { GitExec } from "./dugite";
import { GhStackCatalogStore, type NativeStackLocks } from "./stack-catalog-store";
import type { GhStack, GhStackBranch, GitRunner } from "./stack-engine";
import { isOid, StackGit } from "./stack-engine/git";

export function stackRunner(execute: GitExec): GitRunner {
  return {
    async run(cwd, args, opts) {
      const result = await execute(args, cwd, {
        env: { GIT_NO_LAZY_FETCH: "1" },
        ...(opts?.stdin === undefined ? {} : { input: opts.stdin }),
      });
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    },
  };
}

type BranchPrObservation = { pr: PrSummary; fetchedAt: number };

type StackSource = {
  stack: GhStack;
  inferred: boolean;
  catalogRepository: string;
  open: ChangeRequestEntry[];
};

function parsedCatalogKey(value: string): string {
  return value.replace(":", "/").toLowerCase();
}

export class StackReader {
  constructor(
    readonly runner: GitRunner,
    private readonly locks: NativeStackLocks,
    private readonly readOpen: (repoId: string) => Promise<ChangeRequestList>,
    private readonly readBranchPr: (repoId: string, branch: string) => BranchPrObservation | null | undefined,
  ) {}

  async location(repo: Pick<Repo, "path" | "identity">) {
    const git = new StackGit(this.runner, repo.path);
    const commonDir = (await git.output(["rev-parse", "--path-format=absolute", "--git-common-dir"])).trimEnd();
    const gh = new GhStackCatalogStore(this.locks);
    const tracked = await gh.read(commonDir);
    const filename = forgeProductFor(repo.identity?.host)?.stackCatalog ?? "gh-stack";
    if (tracked.sha256 || filename === "gh-stack") return { commonDir, store: gh, tracked };
    const store = new GhStackCatalogStore(this.locks, filename);
    return { commonDir, store, tracked: await store.read(commonDir) };
  }

  async list(repo: Repo): Promise<StackSnapshot> {
    const { commonDir, store, tracked } = await this.location(repo);
    const open = await this.readOpen(repo.id);
    const { catalog } = tracked;
    const sources: StackSource[] = catalog.stacks.map(stack => ({
      stack, catalogRepository: catalog.repository, inferred: false,
      open: open.entries.filter(entry => !catalog.repository || entry.forgeRepo === parsedCatalogKey(catalog.repository)),
    }));
    const trackedBranches = new Set(catalog.stacks.flatMap(stack => stack.branches.map(branch => branch.branch)));
    const remotes = new Map(open.remotes.map(remote => [remote.forgeRepo, remote]));
    const completeEntries = open.entries.filter(entry => !(remotes.get(entry.forgeRepo)?.truncated ?? open.truncated));
    for (const entries of inferPullRequestStacks(completeEntries, trackedBranches)) {
      const [{ forgeRepo, pr }] = entries;
      const separator = forgeRepo.indexOf("/");
      sources.push({
        inferred: true, open: entries,
        catalogRepository: `${forgeRepo.slice(0, separator)}:${forgeRepo.slice(separator + 1)}`,
        stack: { trunk: { branch: pr.baseRefName! }, branches: entries.map(({ pr: layer }) => ({ branch: layer.headRefName! })) },
      });
    }
    const busy = await store.journalBlocker(commonDir);
    const snapshot: StackSnapshot = {
      schemaVersion: catalog.schemaVersion, readOnly: catalog.schemaVersion !== 1, stacks: [],
      ...(busy ? { busy } : {}),
    };
    if (busy && !snapshot.readOnly && !await store.journalBlocker(commonDir, true)) {
      const transaction = await store.readApplyJournal(commonDir);
      const resolution = transaction?.resolution?.journal ?? await store.readResolutionJournal(commonDir);
      if (resolution ? resolution.scope.repoId === repo.id && resolution.scope.profileId === repo.profileId : transaction) {
        snapshot.recoveryAvailable = true;
      }
    }
    if (!sources.length) return snapshot;
    const git = new StackGit(this.runner, repo.path);
    const refs = new Map((await git.output([
      "for-each-ref", "--format=%(refname)%00%(objectname)", "refs/heads", "refs/remotes",
    ])).trimEnd().split("\n").filter(Boolean).map(line => {
      const [ref, oid] = line.split("\0");
      return [ref, oid] as const;
    }));
    const local = (branch: string) => refs.get(`refs/heads/${branch}`);
    const ancestors = new Map<string, boolean>();
    const isAncestor = async (base: string | undefined, tip: string | undefined) => {
      if (!base || !tip || !isOid(base) || !isOid(tip)) return false;
      if (base === tip) return true;
      const key = `${base} ${tip}`;
      if (!ancestors.has(key)) {
        ancestors.set(key, (await git.run(["merge-base", "--is-ancestor", base, tip])).exitCode === 0);
      }
      return ancestors.get(key) ?? false;
    };
    for (const source of sources) {
      const { stack, inferred, catalogRepository } = source;
      if (!stack.branches.length) continue;
      const scope = parsedCatalogKey(catalogRepository);
      const remote = remotes.get(scope)?.name ?? "origin";
      const trunkHead = local(stack.trunk.branch) ?? stack.trunk.head;
      const layers: StackLayer[] = [];
      const lookupPr = (branch: GhStackBranch) => {
        const number = branch.pullRequest?.number;
        const entry = source.open.find(({ pr }) => number !== undefined
          ? pr.number === number
          : !pr.headRepoPath && pr.headRefName === branch.branch);
        const cached = this.readBranchPr(repo.id, branch.branch);
        const listFetchedAt = entry ? remotes.get(entry.forgeRepo)?.fetchedAt ?? open.fetchedAt : null;
        if (cached?.pr.host && cached.pr.repoPath && forgeRepoKey(cached.pr.host, cached.pr.repoPath) === scope &&
            (number === undefined || cached.pr.number === number) &&
            (!entry || (cached.pr.number === entry.pr.number && cached.fetchedAt >= (listFetchedAt ?? 0)))) {
          return cached.pr;
        }
        return entry?.pr;
      };
      for (const [index, branch] of stack.branches.entries()) {
        const parent = stack.branches[index - 1] ?? stack.trunk;
        const pr = lookupPr(branch);
        const parentPr = layers[index - 1]?.pr;
        const localHead = local(branch.branch);
        const parentHead = local(parent.branch);
        const remoteHead = refs.get(`refs/remotes/${remote}/${branch.branch}`);
        let base = branch.base;
        if (inferred) {
          const parentAnchor = parentPr?.headOid ?? parentHead;
          const head = localHead ?? pr?.headOid;
          if (head && parentAnchor && isOid(head) && isOid(parentAnchor)) {
            const result = await git.run(["merge-base", head, parentAnchor]);
            if (result.exitCode === 0) base = result.stdout.trim();
          }
        }
        let parentMerged = parentPr?.state === "merged" || parent.pullRequest?.merged === true;
        if (index > 0 && !open.forge && !forgeProductFor(repo.identity?.host) && !parentMerged && trunkHead && parentHead && isOid(trunkHead)) {
          const cherry = await git.run(["cherry", trunkHead, parentHead]);
          parentMerged = cherry.exitCode === 0 && cherry.stdout.trim() === "";
        }
        const health = stackBranchHealth({
          branch: branch.branch, parent: parent.branch, parentMerged,
          ...(base ? { base } : {}), ...(branch.head ? { catalogHead: branch.head } : {}),
          ...(localHead ? { localHead } : {}), ...(parentHead ? { parentHead } : {}),
          ...(remoteHead ? { remoteHead } : {}), ...(pr ? { pr } : {}),
          baseIsAncestor: await isAncestor(base, localHead),
          remoteIsAncestor: await isAncestor(remoteHead, localHead),
          localIsAncestorOfRemote: Boolean(localHead && (
            (localHead !== remoteHead && await isAncestor(localHead, remoteHead)) ||
            (localHead !== pr?.headOid && await isAncestor(localHead, pr?.headOid))
          )),
        });
        const head = localHead ?? branch.head ?? pr?.headOid;
        layers.push({
          branch: branch.branch, parent: parent.branch, health, ...(base ? { base } : {}),
          ...(head ? { head } : {}), ...(pr ? { pr, forgeRepo: scope } : {}),
        });
      }
      const stackSource: RepositoryStack["source"] = inferred ? "inferred" : "tracked";
      snapshot.stacks.push({
        id: JSON.stringify([stackSource, catalogRepository, stack.id ?? stack.number ?? stack.branches[0].branch]),
        source: stackSource, catalogRepository, trunk: { branch: stack.trunk.branch, ...(trunkHead ? { head: trunkHead } : {}) }, layers,
      });
    }
    return snapshot;
  }
}
