import {
  forgeProductFor, forgeRepoKey, inferPullRequestStacks, stackBranchHealth, type ChangeRequestEntry, type ChangeRequestList, type GitHubStack,
  type PrSummary, type Repo, type RepositoryStack, type StackLayer, type StackSnapshot,
} from "@pwrgit/shared";
import type { GitExec } from "./dugite";
import type { ScopedGitHubStack } from "../github/stack-history-service";
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
  linked?: GitHubStack;
  observations?: GitHubStack;
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
    private readonly readGitHubStacks: (repo: Repo) => readonly ScopedGitHubStack[] | Promise<readonly ScopedGitHubStack[]> = () => [],
    private readonly readPrTitles: (repoId: string, forgeRepo: string) => ReadonlyMap<number, string> = () => new Map(),
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
    const [open, github] = await Promise.all([this.readOpen(repo.id), this.readGitHubStacks(repo)]);
    const { catalog } = tracked;
    const remotes = new Map(open.remotes.map(remote => [remote.forgeRepo, remote]));
    const githubRemotes = new Map(github.map(({ scope, remote }) => [scope, remote]));
    const linked = github.filter(({ stack }) => !stack.closed);
    const closed = github.filter(({ stack }) => stack.closed);
    const catalogScope = parsedCatalogKey(catalog.repository);
    const trackedBranches = new Set(catalog.stacks.flatMap(stack => stack.branches.map(branch => branch.branch)));
    const usedLinked = new Set<GitHubStack>();
    const trackedSources: StackSource[] = catalog.stacks.flatMap(stack => {
      const match = linked.find(candidate => candidate.scope === catalogScope && (stack.number === candidate.stack.number ||
        candidate.stack.members.some(pr => stack.branches.some(branch => branch.pullRequest?.number === pr.number ||
          (!branch.pullRequest && branch.branch === pr.headRefName)))));
      const entirelyHistorical = !match && closed.some(candidate => candidate.scope === catalogScope &&
        stack.branches.length > 0 && stack.branches.every(branch =>
          candidate.stack.members.some(pr => branch.pullRequest?.number === pr.number)));
      if (entirelyHistorical) return [];
      const sameMembers = match && match.stack.trunk === stack.trunk.branch &&
        match.stack.members.length === stack.branches.length &&
        match.stack.members.every((pr, index) => {
          const branch = stack.branches[index];
          return branch.pullRequest ? pr.number === branch.pullRequest.number : pr.headRefName === branch.branch;
        });
      if (sameMembers) usedLinked.add(match.stack);
      return [{
        stack, catalogRepository: catalog.repository, inferred: false,
        open: open.entries.filter(entry => !catalog.repository || entry.forgeRepo === catalogScope),
        ...(sameMembers ? { linked: match.stack } : {}),
        ...(match ? { observations: match.stack } : {}),
      }];
    });
    const sources: StackSource[] = [];
    const linkedPrs = new Set(linked.flatMap(({ scope, stack }) => stack.members.map(pr => `${scope}#${pr.number}`)));
    for (const { scope, stack } of linked) {
      if (usedLinked.has(stack)) continue;
      const separator = scope.indexOf("/");
      sources.push({
        inferred: true, open: open.entries.filter(entry => entry.forgeRepo === scope), linked: stack,
        catalogRepository: `${scope.slice(0, separator)}:${scope.slice(separator + 1)}`,
        stack: { trunk: { branch: stack.trunk }, branches: stack.members.map(pr => ({
          branch: pr.headRefName!, pullRequest: { number: pr.number },
        })) },
      });
    }
    // GitHub's ordered membership wins PR lookups when the local catalog
    // differs. Keep the catalog's write model scoped to its local branches.
    sources.push(...trackedSources);
    const completeEntries = open.entries.filter(entry => !(remotes.get(entry.forgeRepo)?.truncated ?? open.truncated));
    for (const entries of inferPullRequestStacks(completeEntries, trackedBranches)) {
      if (entries.some(entry => linkedPrs.has(`${entry.forgeRepo}#${entry.pr.number}`))) continue;
      const [{ forgeRepo, pr }] = entries;
      const separator = forgeRepo.indexOf("/");
      sources.push({
        inferred: true, open: entries,
        catalogRepository: `${forgeRepo.slice(0, separator)}:${forgeRepo.slice(separator + 1)}`,
        stack: { trunk: { branch: pr.baseRefName! }, branches: entries.map(({ pr: layer }) => ({ branch: layer.headRefName! })) },
      });
    }
    const busy = await store.journalBlocker(commonDir);
    const titlesByScope = new Map<string, ReadonlyMap<number, string>>();
    for (const { scope } of closed) {
      if (!titlesByScope.has(scope)) titlesByScope.set(scope, this.readPrTitles(repo.id, scope));
    }
    const snapshot: StackSnapshot = {
      schemaVersion: catalog.schemaVersion, readOnly: catalog.schemaVersion !== 1,
      stacks: closed.map(({ scope, stack }): RepositoryStack => ({
        id: JSON.stringify(["github", scope, stack.number]),
        source: "inferred", catalogRepository: scope.replace("/", ":"),
        closed: stack.closed!,
        githubNumber: stack.number, githubUrl: stack.url,
        trunk: { branch: stack.trunk },
        layers: stack.members.map((pr, index) => ({
          branch: pr.headRefName!, parent: stack.members[index - 1]?.headRefName ?? stack.trunk,
          pr: { ...pr, title: titlesByScope.get(scope)?.get(pr.number) ?? pr.title }, forgeRepo: scope, local: false,
          health: { inSync: false, needsRestack: false, parentMerged: false, needsPush: false, drift: false, remoteAhead: false },
        })),
      })),
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
      const { stack, inferred, catalogRepository, linked } = source;
      if (!stack.branches.length) continue;
      const scope = parsedCatalogKey(catalogRepository);
      const remote = remotes.get(scope)?.name ?? githubRemotes.get(scope) ?? "origin";
      const localTrunk = local(stack.trunk.branch);
      const trunkHead = localTrunk ?? stack.trunk.head;
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
        const member = (source.observations ?? linked)?.members.find(pr => number !== undefined ? pr.number === number : pr.headRefName === branch.branch);
        if (member && member.state !== "open") return member;
        if (entry) return entry.pr;
        if (member) return member;
        const recorded = branch.pullRequest;
        return recorded?.merged && recorded.url ? {
          number: recorded.number, url: recorded.url, title: branch.branch, state: "merged" as const, isDraft: false,
          headRefName: branch.branch, ...(recorded.mergedHead ? { headOid: recorded.mergedHead } : {}),
        } : undefined;
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
        const baseIsAncestor = await isAncestor(base, localHead);
        const health = stackBranchHealth({
          branch: branch.branch, parent: parent.branch, parentMerged,
          ...(base ? { base } : {}), ...(branch.head ? { catalogHead: branch.head } : {}),
          ...(localHead ? { localHead } : {}), ...(parentHead ? { parentHead } : {}),
          ...(remoteHead ? { remoteHead } : {}), ...(pr ? { pr } : {}),
          baseIsAncestor,
          remoteIsAncestor: await isAncestor(remoteHead, localHead),
          localIsAncestorOfRemote: Boolean(localHead && (
            (localHead !== remoteHead && await isAncestor(localHead, remoteHead)) ||
            (localHead !== pr?.headOid && await isAncestor(localHead, pr?.headOid))
          )),
        });
        let syncReady = false;
        if (!inferred && index === 1 && parentMerged && localTrunk && base && baseIsAncestor) {
          // This is the history the replay will exclude, which may extend
          // beyond the merged PR if the parent has unpublished commits.
          const mergedHead = parent.pullRequest?.mergedHead ?? (parentPr?.state === "merged" ? parentPr.headOid : undefined);
          syncReady = mergedHead !== undefined && await git.containsChanges(localTrunk, mergedHead) &&
            (base === mergedHead || await git.containsChanges(localTrunk, base));
        }
        let behindParent = 0;
        if (parentHead && base && base !== parentHead && isOid(base) && isOid(parentHead)
            && await isAncestor(base, parentHead)) {
          const distance = await git.run(["rev-list", "--count", `${base}..${parentHead}`]);
          if (distance.exitCode === 0) behindParent = Number(distance.stdout.trim());
        }
        let commitCount: number | undefined;
        if (!pr && localHead && parentHead) {
          const commits = await git.run(["rev-list", "--count", `${parentHead}..${localHead}`]);
          if (commits.exitCode === 0) commitCount = Number(commits.stdout.trim());
        }
        const head = localHead ?? branch.head ?? pr?.headOid;
        layers.push({
          branch: branch.branch, parent: parent.branch, health, local: !!localHead,
          ...(behindParent > 0 ? { behindParent } : {}),
          ...(syncReady ? { syncReady } : {}),
          ...(!inferred && base ? { baseIsAncestor } : {}),
          ...(commitCount === undefined ? {} : { commitCount }), ...(base ? { base } : {}),
          ...(head ? { head } : {}), ...(pr ? { pr, forgeRepo: scope } : {}),
        });
      }
      const stackSource: RepositoryStack["source"] = inferred ? "inferred" : "tracked";
      snapshot.stacks.push({
        id: JSON.stringify([stackSource, catalogRepository, stack.id ?? stack.number ?? linked?.number ?? stack.branches[0].branch]),
        source: stackSource, catalogRepository,
        ...(linked ? { githubNumber: linked.number, githubUrl: linked.url } : {}),
        ...(inferred ? { canTrack: Boolean(localTrunk && layers.every(layer => layer.local) &&
          (!catalogScope || catalogScope === scope) && layers.every(layer => !trackedBranches.has(layer.branch))) } : {}),
        trunk: { branch: stack.trunk.branch, local: !!localTrunk, ...(trunkHead ? { head: trunkHead } : {}) }, layers,
      });
    }
    return snapshot;
  }
}
