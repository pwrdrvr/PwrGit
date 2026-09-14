import {
  err,
  forgeBlockAt,
  forgeCapabilities,
  forgeProductOrAssumed,
  forgeWebUrl,
  ok,
  parseForgeRemote,
  type CloneProtocol,
  type CloneRepository,
  type ForgeHost,
  type ForgeHostMap,
  type ForgeKind,
  type ForgeOwner,
  type ForgeRepoRef,
  type ForkCheckoutPreflight,
  type ForkPreflight,
  type ForkProgress,
  type PwrGitError,
  type Repo,
  type Result
} from "@pwrgit/shared";
import type { ProfileService } from "../profiles/profile-service";
import type { ForgeRepoRegistry } from "../forge/repo-provider";
import type { ForgeStatusService } from "../forge/status";
import type { GitExec } from "./dugite";
import { requireExit0 } from "./dugite";
import {
  CloneService,
  normalizeRepositoryPath,
  operationWasCanceled,
  removePartialCheckout,
  unsupportedHostMessage,
  validateCheckoutDestination
} from "./clone-service";
import {
  applyForkRemotes,
  forkRemoteUrl,
  planUpstreamRemote,
  readCheckoutRemotes,
  remoteProtocol,
  UPSTREAM_REMOTE,
  type CheckoutRemote
} from "./fork-remotes";
import type { RepoIndexer } from "./repo-indexer";

/** The remote name a fork's original is added under. Defined in
 *  `fork-remotes.ts`, where the checkout-rewiring path also needs it — and
 *  where the case `ForkService` never had to handle lives: a checkout that
 *  already has a remote by that name. Re-exported because the fork flow is
 *  what callers import. */
export { UPSTREAM_REMOTE } from "./fork-remotes";

/** Forking a checkout that already exists. No destination and no protocol:
 *  nothing is cloned, and the fork's URL is written in whatever protocol
 *  `origin` already speaks. */
export type ForkCheckoutRequest = {
  profileId: string;
  repoId: string;
  targetOwner: string;
  targetOwnerKind: "user" | "organization";
  targetName: string;
  /** `owner/name` of the repository the original should be kept under, or null
   *  to add no remote for it. Must be one of the preflight's choices. */
  upstream: string | null;
};

export type ForkRequest = {
  profileId: string;
  /** The repository being forked. */
  source: string;
  host: ForgeHost;
  hostname: string;
  /** Account the fork is created in. */
  targetOwner: string;
  /** Whether that account is the signed-in user or an organization. */
  targetOwnerKind: "user" | "organization";
  /** Name for the fork. */
  targetName: string;
  protocol: CloneProtocol;
  parentPath: string;
  defaultBranchOnly: boolean;
  /** `owner/name` of the repository `upstream` should point at, or null to
   *  add no upstream remote. Must be one of the preflight's choices. */
  upstream: string | null;
};

function forgeName(host: ForgeHost): string {
  return forgeProductOrAssumed(host).label;
}

/** The candidates for `upstream`, best answer first.
 *
 *  A source that is not a fork yields exactly one entry and the dialog asks
 *  nothing. A fork yields the network root first — rebasing on the root is
 *  almost always what someone forking a fork wants — then the intermediate
 *  parent, then the repository actually picked. */
export function upstreamChoicesFor(source: CloneRepository): ForgeRepoRef[] {
  const choices: ForgeRepoRef[] = [];
  if (source.parent !== undefined) {
    if (source.root !== undefined) choices.push(source.root);
    choices.push(source.parent);
  }
  choices.push({
    nameWithOwner: source.nameWithOwner,
    url: forgeWebUrl(source.hostname, source.nameWithOwner)
  });
  return choices.filter(
    (choice, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.nameWithOwner.toLowerCase() ===
          choice.nameWithOwner.toLowerCase()
      ) === index
  );
}

/** Whether `candidate` is this account's existing fork of `source` — rather
 *  than an unrelated repository that merely occupies the name. Getting this
 *  wrong would offer to "clone your fork" for a stranger's namesake repo. */
export function isForkOf(
  candidate: CloneRepository,
  source: CloneRepository
): boolean {
  const slug = source.nameWithOwner.toLowerCase();
  return (
    candidate.parent?.nameWithOwner.toLowerCase() === slug ||
    candidate.root?.nameWithOwner.toLowerCase() === slug ||
    // Forking a fork puts the new repo under the picked repo but leaves the
    // root pointing at the original, so a shared root also identifies it.
    (source.root !== undefined &&
      candidate.root?.nameWithOwner.toLowerCase() ===
        source.root.nameWithOwner.toLowerCase()) ||
    (source.parent !== undefined &&
      candidate.parent?.nameWithOwner.toLowerCase() ===
        source.parent.nameWithOwner.toLowerCase())
  );
}

export class ForkService {
  constructor(
    private readonly git: GitExec,
    private readonly indexer: RepoIndexer,
    private readonly profiles: ProfileService,
    private readonly forges: ForgeRepoRegistry,
    private readonly clones: CloneService,
    private readonly forgeStatus: ForgeStatusService,
    /** `ForgeHosts.overrides()`, for reading a checkout's own remotes.
     *
     *  Only the checkout-rewiring path needs it, and only because a hostname
     *  says nothing about which forge runs on it: without the map a
     *  self-managed instance classifies as `other`, which has no provider, and
     *  forking an Enterprise checkout would report "unsupported host" about a
     *  host PwrGit talks to all day. Defaulted so existing callers and specs
     *  that only fork-and-clone need not supply it. */
    private readonly hosts: () => ForgeHostMap = () => ({})
  ) {}

  /**
   * Answer everything the dialog needs before anything is created: what the
   * source is, where the fork would land, whether it is already there, which
   * repository `upstream` should point at, and whether the whole thing is
   * blocked. Every one of those costs a round trip the user would otherwise
   * spend pressing a button and reading a CLI error.
   */
  async preflight(input: {
    profileId: string;
    source: string;
    host: ForgeHost;
    /** The instance the source lives on. Without it a self-managed project is
     *  preflighted against the forge's SaaS instance, which answers about a
     *  different repository that shares the slug. */
    hostname?: string;
    targetOwner?: string;
    targetName?: string;
  }): Promise<Result<ForkPreflight>> {
    if (this.profiles.get(input.profileId) === null) {
      return err({
        kind: "profile",
        code: "not_found",
        message: `No profile "${input.profileId}"`
      });
    }
    const source = normalizeRepositoryPath(input.source);
    if (source === null) {
      return err({
        kind: "validation",
        code: "invalid_repository",
        message: "Enter a repository as owner/name."
      });
    }
    const provider = this.forges.get(input.host, input.hostname);
    if (provider === null) {
      return this.blocked(source, input.targetOwner, {
        code: "unsupported_host",
        message: unsupportedHostMessage("fork")
      });
    }
    const status = (await this.forgeStatus.list()).find(
      (candidate) => candidate.kind === input.host
    );
    if (status === undefined || !status.installed) {
      return this.blocked(source, input.targetOwner, {
        code: "cli_missing",
        message: `Forking on ${forgeName(input.host)} needs the ${forgeName(input.host)} CLI.`
      });
    }
    // The host the provider will actually talk to, not the forge summary: a
    // machine signed in only to a self-managed instance reads merge requests
    // fine and still has no credential for gitlab.com. `provider.hostname` is
    // literally that host now that the request carries one, so this asks about
    // the instance the fork is really going to rather than assuming the SaaS
    // one. A host the user switched OFF is reported separately — telling them
    // to sign in to something they are already signed in to names a remedy
    // that cannot work.
    const block = forgeBlockAt(status, provider.hostname);
    if (block === "host_off") {
      return this.blocked(source, input.targetOwner, {
        code: "login_required",
        message: `${provider.hostname} is switched off in Settings → Forges.`
      });
    }
    if (block !== null) {
      return this.blocked(source, input.targetOwner, {
        code: "login_required",
        message: `Sign in with the ${forgeName(input.host)} CLI to fork.`
      });
    }

    let repository: CloneRepository;
    try {
      repository = await provider.viewRepo(source);
    } catch (cause) {
      return err({
        kind: "remote",
        code: "repository_not_found",
        message: `Couldn't find ${source}. ${provider.errorMessage(cause)}`
      });
    }

    // Only when the caller did not name one: resolving owners costs one or
    // two more forge calls, and the dialog supplies a target on every
    // preflight after its picker has a value.
    const targetOwner =
      input.targetOwner ??
      (await provider.owners().catch(() => []))[0]?.login ??
      repository.owner;
    // The fork name is editable, and every answer below — the existing fork,
    // the collision — is about the name actually being created.
    const targetName = input.targetName?.trim() || repository.name;
    const target = {
      owner: targetOwner,
      name: targetName,
      nameWithOwner: `${targetOwner}/${targetName}`
    };
    const upstreamChoices = upstreamChoicesFor(repository);

    // Neither forge will fork a repository into the account that owns it.
    if (repository.owner.toLowerCase() === targetOwner.toLowerCase()) {
      return ok({
        source: repository,
        target,
        upstreamChoices,
        blocked: {
          code: "self_owned",
          message: `${forgeName(input.host)} does not fork a repository into the account that already owns it. ${repository.nameWithOwner} is yours — clone it instead.`
        }
      });
    }

    const preflight: ForkPreflight = {
      source: repository,
      target,
      upstreamChoices
    };
    // A repository already at the target name is only "your fork" if it
    // actually descends from the source; otherwise it is a name collision the
    // user has to resolve, and forking would fail server-side.
    const existing = await provider
      .viewRepo(target.nameWithOwner)
      .catch(() => null);
    if (existing !== null) {
      if (isForkOf(existing, repository)) {
        existing.localPaths = this.checkoutsFor(input.profileId, existing);
        preflight.existing = existing;
      } else {
        preflight.blocked = {
          code: "forking_disabled",
          message: `${target.nameWithOwner} already exists and is not a fork of ${repository.nameWithOwner}. Rename the fork, or pick another account.`
        };
      }
    }
    return ok(preflight);
  }

  /**
   * The same questions as `preflight`, asked about a repository that is
   * already on disk — plus the ones this checkout's own remotes decide.
   *
   * The fork half is `preflight` verbatim: the source is whatever `origin`
   * points at, and the two forge reads answer the same things whether the
   * checkout exists yet or not. What is added is local and free: which URL
   * `origin` holds now, which protocol it speaks, and what the remote keeping
   * the original will end up being called.
   */
  async checkoutPreflight(input: {
    profileId: string;
    repoId: string;
    targetOwner?: string;
    targetName?: string;
    /** The `upstream` choice the dialog is currently showing, when the source
     *  is itself a fork and the choice is open. Defaults to `origin`'s own
     *  repository, which is the only candidate for an unforked source. */
    upstream?: string;
  }): Promise<Result<ForkCheckoutPreflight>> {
    const origin = await this.readOrigin(input.profileId, input.repoId);
    if (!origin.ok) return origin;
    const fork = await this.preflight({
      profileId: input.profileId,
      source: origin.value.nameWithOwner,
      host: origin.value.host,
      hostname: origin.value.hostname,
      ...(input.targetOwner === undefined
        ? {}
        : { targetOwner: input.targetOwner }),
      ...(input.targetName === undefined
        ? {}
        : { targetName: input.targetName })
    });
    if (!fork.ok) return fork;
    const upstreamFor = input.upstream ?? origin.value.nameWithOwner;
    return ok({
      fork: fork.value,
      origin: {
        url: origin.value.url,
        nameWithOwner: origin.value.nameWithOwner
      },
      protocol: origin.value.protocol,
      upstreamRemote: planUpstreamRemote(
        origin.value.remotes,
        { hostname: origin.value.hostname, nameWithOwner: upstreamFor },
        this.hosts()
      ),
      upstreamFor
    });
  }

  /**
   * Fork the repository this checkout was cloned from, and point the checkout
   * at the fork. Nothing is cloned and nothing moves on disk.
   *
   * The remote rewire is the whole operation, and `applyForkRemotes` documents
   * why its order is what it is. Afterwards both remotes are fetched: the
   * fork's refs are new names for objects already present, and the original's
   * are what `upstream` exists to be rebased on.
   */
  async forkCheckout(
    input: ForkCheckoutRequest,
    onProgress: (progress: ForkProgress) => void = () => undefined,
    signal?: AbortSignal
  ): Promise<Result<Repo>> {
    if (this.profiles.get(input.profileId) === null) {
      return err({
        kind: "profile",
        code: "not_found",
        message: `No profile "${input.profileId}"`
      });
    }
    const origin = await this.readOrigin(input.profileId, input.repoId);
    if (!origin.ok) return origin;
    const { repo, remotes, hostname, protocol } = origin.value;
    const source = origin.value.nameWithOwner;
    if (
      normalizeRepositoryPath(`${input.targetOwner}/${input.targetName}`) === null
    ) {
      return err({
        kind: "validation",
        code: "invalid_repository",
        message: `Not a usable fork name: ${input.targetOwner}/${input.targetName}`
      });
    }
    const provider = this.forges.get(origin.value.host, hostname);
    if (provider === null) {
      return err({
        kind: "remote",
        code: "unsupported_host",
        message: unsupportedHostMessage("fork")
      });
    }
    // The same gate `fork` applies, for the same reason: this is the call that
    // WRITES, and the dialog cannot be relied on to have asked.
    const gated = await this.forgeGate(origin.value.host, provider.hostname);
    if (gated !== null) return gated;

    if (operationWasCanceled(signal)) return this.canceled(signal);

    onProgress({ phase: "starting", percent: null });
    let remoteCreated = false;
    let fork: CloneRepository;
    try {
      fork = await provider.fork({
        source,
        targetOwner: input.targetOwner,
        targetOwnerKind: input.targetOwnerKind,
        targetName: input.targetName,
        // Deliberately never set here. A partial copy is a clone-size saving,
        // and this path clones nothing — what it would buy instead is a set of
        // `origin/*` refs for branches the fork does not have, which the next
        // pruning fetch deletes out from under any local branch tracking them.
        defaultBranchOnly: false,
        onPhase: (phase) => {
          if (phase === "awaiting_fork") remoteCreated = true;
          onProgress({ phase, percent: null });
        },
        ...(signal === undefined ? {} : { signal })
      });
    } catch (cause) {
      if (operationWasCanceled(signal)) {
        return remoteCreated
          ? this.canceledAfterRemoteCreated(
              signal,
              `${input.targetOwner}/${input.targetName}`,
              origin.value.host
            )
          : this.canceled(signal);
      }
      if (provider.isAuthError(cause)) {
        return err({
          kind: "remote",
          code: "forge_login_required",
          message: provider.errorMessage(cause)
        });
      }
      return err({
        kind: "remote",
        code: "fork_failed",
        message: `Couldn't fork ${source}. ${provider.errorMessage(cause)}`
      });
    }

    if (input.upstream !== null) {
      const invalid = this.rejectUnrelatedUpstream(input.upstream, fork, source);
      if (invalid !== null) return invalid;
    }
    // Nothing has been written to the checkout yet, so cancelling here costs
    // only the fork on the forge — which is kept, as everywhere else.
    if (operationWasCanceled(signal)) {
      return this.canceled(
        signal,
        `Forked to ${fork.nameWithOwner}, but this checkout was left pointing at ${source}.`
      );
    }

    // Both URLs are shaped like the remote being replaced — see
    // `forkRemoteUrl`. Composing them from protocol + hostname alone drops a
    // non-default SSH port, which would swap a working `origin` for one that
    // cannot connect.
    const upstream =
      input.upstream === null
        ? null
        : {
            ...planUpstreamRemote(
              remotes,
              { hostname, nameWithOwner: input.upstream },
              this.hosts()
            ),
            url: forkRemoteUrl(
              protocol,
              hostname,
              input.upstream,
              origin.value.url
            )
          };
    if (upstream !== null && !upstream.existing) {
      onProgress({ phase: "adding_upstream", percent: null });
    }
    onProgress({ phase: "repointing_origin", percent: null });
    // Deliberately NOT cancellable. Everything above this line is; from here
    // it is two or three local config writes, and an abort landing between
    // them leaves a checkout with an `upstream` remote and an `origin` still
    // on the repository the user cannot push to — reported, wrongly, as
    // "remotes were not changed".
    const rewired = await applyForkRemotes(this.git, repo.path, {
      originUrl: forkRemoteUrl(
        protocol,
        fork.hostname,
        fork.nameWithOwner,
        origin.value.url
      ),
      upstream
    });
    if (!rewired.ok) {
      return err({
        ...rewired.error,
        message: `Forked to ${fork.nameWithOwner}, but this checkout's remotes were not changed: ${rewired.error.message}`
      });
    }

    // Both remotes, best-effort. The rewire has already succeeded and is what
    // the user asked for; a network blip afterwards must not report it as a
    // failure, and the next fetch picks the refs up anyway.
    onProgress({ phase: "receiving", percent: null });
    await this.fetchRemote(repo.path, "origin", signal);
    if (upstream !== null) {
      await this.fetchRemote(repo.path, upstream.name, signal);
    }
    onProgress({ phase: "indexing", percent: null });
    return ok(repo);
  }

  /** `origin` for one indexed repository, with everything reading it decides.
   *
   *  Read from Git rather than from the stored identity: the identity row is
   *  up to six hours old and this is about to rewrite the very remote it
   *  describes. */
  private async readOrigin(
    profileId: string,
    repoId: string
  ): Promise<
    Result<{
      repo: Repo;
      remotes: CheckoutRemote[];
      url: string;
      host: ForgeHost;
      hostname: string;
      nameWithOwner: string;
      protocol: "ssh" | "https";
    }>
  > {
    const repo = this.indexer.getRepo(repoId);
    if (repo === null || repo.profileId !== profileId) {
      return err({
        kind: "repo",
        code: "not_found",
        message: "That repository is no longer in this profile."
      });
    }
    const remotes = await readCheckoutRemotes(this.git, repo.path);
    if (!remotes.ok) return remotes;
    const origin = remotes.value.find((remote) => remote.name === "origin");
    if (origin === undefined) {
      return err({
        kind: "remote",
        code: "no_origin",
        message: `${repo.name} has no origin remote, so there is nothing to fork.`
      });
    }
    const parsed = parseForgeRemote(origin.url, this.hosts());
    if (parsed === null || parsed.host === "other") {
      return err({
        kind: "remote",
        code: "unsupported_host",
        message: `${repo.name}'s origin is not on a forge PwrGit can fork: ${origin.url}`
      });
    }
    return ok({
      repo,
      remotes: remotes.value,
      url: origin.url,
      host: parsed.host,
      hostname: parsed.hostname,
      nameWithOwner: parsed.nameWithOwner,
      protocol: remoteProtocol(origin.url)
    });
  }

  /** Refresh one remote's refs. Never fails the operation it follows. */
  private async fetchRemote(
    cwd: string,
    remote: string,
    signal?: AbortSignal
  ): Promise<void> {
    // No `--prune`: the fork was made from these very refs, and pruning
    // against a fork that is still being prepared would delete
    // remote-tracking branches the local ones are following.
    await this.git(
      ["fetch", remote],
      cwd,
      signal === undefined ? undefined : { signal }
    );
  }

  /** Accounts a fork can be created in on one forge, or none when its CLI
   *  cannot answer. Best-effort: an empty list disables the picker rather
   *  than failing the dialog. */
  async targets(
    host: ForgeKind,
    hostname?: string
  ): Promise<Result<ForgeOwner[]>> {
    // A fork lands on the instance the source lives on, so the accounts
    // offered must come from that instance — the SaaS provider would list the
    // user's github.com/gitlab.com orgs for an Enterprise source.
    const provider = this.forges.get(host, hostname);
    if (provider === null) return ok([]);
    const status = (await this.forgeStatus.list()).find(
      (candidate) => candidate.kind === host
    );
    if (forgeBlockAt(status, provider.hostname) !== null) return ok([]);
    try {
      return ok(await provider.owners());
    } catch {
      return ok([]);
    }
  }

  /** Create the fork, clone it, wire `upstream`, and index the checkout. */
  async fork(
    input: ForkRequest,
    onProgress: (progress: ForkProgress) => void = () => undefined,
    signal?: AbortSignal
  ): Promise<Result<Repo>> {
    const profile = this.profiles.get(input.profileId);
    if (profile === null) {
      return err({
        kind: "profile",
        code: "not_found",
        message: `No profile "${input.profileId}"`
      });
    }
    const source = normalizeRepositoryPath(input.source);
    if (source === null) {
      return err({
        kind: "validation",
        code: "invalid_repository",
        message: "Enter a repository as owner/name."
      });
    }
    const targetSlug = normalizeRepositoryPath(
      `${input.targetOwner}/${input.targetName}`
    );
    if (targetSlug === null) {
      return err({
        kind: "validation",
        code: "invalid_repository",
        message: `Not a usable fork name: ${input.targetOwner}/${input.targetName}`
      });
    }
    // `input.hostname` is already carried by `repo:fork` and was previously
    // used only to build remote URLs — so the fork itself was created on the
    // SaaS instance while the checkout's remotes pointed at the self-managed
    // one.
    const provider = this.forges.get(input.host, input.hostname);
    if (provider === null) {
      return err({
        kind: "remote",
        code: "unsupported_host",
        message: unsupportedHostMessage("fork")
      });
    }
    // `preflight` and `targets` both ask this, and this is the one that WRITES
    // — it creates a repository on the forge. Resolution and permission are
    // different questions: `get` answers which instance, the switch answers
    // whether we may talk to it, and the dialog cannot be relied on to have
    // asked (its `forge_host_off` is a code the clone dialog deliberately
    // swallows).
    const gated = await this.forgeGate(input.host, provider.hostname);
    if (gated !== null) return gated;

    const destinationCheck = validateCheckoutDestination(
      profile,
      input.parentPath,
      input.targetName
    );
    if (!destinationCheck.ok) return destinationCheck;
    const { parentPath, destination } = destinationCheck.value;

    if (operationWasCanceled(signal)) return this.canceled(signal);

    onProgress({ phase: "starting", percent: null });
    let remoteCreated = false;
    let fork: CloneRepository;
    try {
      fork = await provider.fork({
        source,
        targetOwner: input.targetOwner,
        targetOwnerKind: input.targetOwnerKind,
        targetName: input.targetName,
        defaultBranchOnly:
          input.defaultBranchOnly &&
          forgeCapabilities(provider.host).forkDefaultBranchOnly,
        onPhase: (phase) => {
          // Both providers enter awaiting_fork only after the remote fork
          // exists: GitHub is reading it back, while GitLab is waiting for its
          // queued import. Preserve that fact if either follow-up is canceled.
          if (phase === "awaiting_fork") remoteCreated = true;
          onProgress({ phase, percent: null });
        },
        ...(signal === undefined ? {} : { signal })
      });
    } catch (cause) {
      if (operationWasCanceled(signal)) {
        return remoteCreated
          ? this.canceledAfterRemoteCreated(signal, targetSlug, input.host)
          : this.canceled(signal);
      }
      if (provider.isAuthError(cause)) {
        return err({
          kind: "remote",
          code: "forge_login_required",
          message: provider.errorMessage(cause)
        });
      }
      return err({
        kind: "remote",
        code: "fork_failed",
        message: `Couldn't fork ${source}. ${provider.errorMessage(cause)}`
      });
    }

    if (operationWasCanceled(signal)) {
      return this.canceled(
        signal,
        `Forked to ${fork.nameWithOwner}, but the checkout was canceled.`
      );
    }

    if (input.upstream !== null) {
      const invalid = this.rejectUnrelatedUpstream(input.upstream, fork, source);
      if (invalid !== null) return invalid;
    }

    const cloned = await this.clones.runClone(
      {
        host: fork.host,
        hostname: fork.hostname,
        nameWithOwner: fork.nameWithOwner,
        protocol: input.protocol
      },
      destination,
      parentPath,
      (progress) => onProgress(progress),
      signal
    );
    if (!cloned.ok) {
      if (operationWasCanceled(signal)) {
        return this.canceledCheckout(signal, fork, destination);
      }
      await removePartialCheckout(destination);
      return err({
        ...cloned.error,
        // The fork itself succeeded — saying only "clone failed" would leave
        // the user unsure whether a repository was created on the forge.
        message: `Forked to ${fork.nameWithOwner}, but the checkout failed: ${cloned.error.message}`
      });
    }

    if (operationWasCanceled(signal)) {
      return this.canceledCheckout(signal, fork, destination);
    }

    if (input.upstream !== null) {
      onProgress({ phase: "adding_upstream", percent: null });
      const added = await this.addUpstream(
        destination,
        input.upstream,
        input.protocol,
        fork.hostname,
        signal
      );
      if (operationWasCanceled(signal)) {
        return this.canceledCheckout(signal, fork, destination);
      }
      if (!added.ok) {
        return err({
          ...added.error,
          message: `Forked and checked out to ${destination}, but couldn't add the ${UPSTREAM_REMOTE} remote: ${added.error.message}`
        });
      }
    }

    onProgress({ phase: "indexing", percent: null });
    const indexed = await this.indexer.indexRepoAt(input.profileId, destination);
    if (!indexed.ok) {
      return err({
        kind: "repo",
        code: "clone_index_failed",
        message: `Forked and checked out to ${destination}, but couldn't add it to PwrGit: ${indexed.error.message}`
      });
    }
    this.clones.rememberDestination(input.profileId, parentPath);
    return ok(indexed.value);
  }

  /**
   * Refuse to run a forge-writing command against a host we may not talk to.
   *
   * `preflight` and `targets` both ask this and neither writes; these two are
   * the ones that create a repository, and the dialog cannot be relied on to
   * have asked (its `forge_host_off` is a code the clone dialog deliberately
   * swallows). Resolution and permission are different questions: `get`
   * answers which instance, this answers whether we may reach it.
   */
  private async forgeGate(
    host: ForgeHost,
    hostname: string
  ): Promise<Result<never> | null> {
    const status = (await this.forgeStatus.list()).find(
      (candidate) => candidate.kind === host
    );
    const block = forgeBlockAt(status, hostname);
    if (block === null) return null;
    return err({
      kind: "remote",
      code: block === "host_off" ? "forge_host_off" : "forge_login_required",
      message:
        block === "host_off"
          ? `${hostname} is switched off in Settings → Forges.`
          : block === "cli_missing"
            ? `Forking on ${forgeName(host)} needs the ${forgeName(host)} CLI.`
            : `Sign in with the ${forgeName(host)} CLI to fork.`
    });
  }

  /** Refuse an `upstream` that is not one of the repositories the fork came
   *  from, or null when it is fine.
   *
   *  Derived from the fork the forge just reported rather than another round
   *  trip: its parent is the repository it was forked from, and its root the
   *  head of that network — which, with the source itself, is exactly what the
   *  preflight offered. */
  private rejectUnrelatedUpstream(
    upstream: string,
    fork: CloneRepository,
    source: string
  ): Result<never> | null {
    const candidates = [
      fork.parent?.nameWithOwner,
      fork.root?.nameWithOwner,
      source
    ].filter((slug): slug is string => slug !== undefined);
    if (
      candidates.some((slug) => slug.toLowerCase() === upstream.toLowerCase())
    ) {
      return null;
    }
    return err({
      kind: "validation",
      code: "invalid_repository",
      message: `${upstream} is not one of the repositories ${source} was forked from.`
    });
  }

  private async addUpstream(
    destination: string,
    upstream: string,
    protocol: CloneProtocol,
    hostname: string,
    signal?: AbortSignal
  ): Promise<Result<true>> {
    const slug = normalizeRepositoryPath(upstream);
    if (slug === null) {
      return err({
        kind: "validation",
        code: "invalid_repository",
        message: `Not a usable upstream: ${upstream}`
      });
    }
    // SSH for the `cli` protocol too: the CLI cloned `origin`, but `upstream`
    // is only ever fetched by plain Git, which has no forge CLI to defer to.
    const url =
      protocol === "https"
        ? `https://${hostname}/${slug}.git`
        : `git@${hostname}:${slug}.git`;
    const added = await this.git(
      ["remote", "add", UPSTREAM_REMOTE, url],
      destination,
      signal === undefined ? undefined : { signal }
    );
    if (!added.ok) return added;
    const checked = requireExit0(added.value, ["remote", "add"]);
    if (!checked.ok) return checked;
    return ok(true);
  }

  private canceled(
    signal: AbortSignal,
    message = "Fork canceled."
  ): Result<Repo> {
    const reason = signal.reason;
    if (
      typeof reason === "object" &&
      reason !== null &&
      "kind" in reason &&
      "code" in reason &&
      "message" in reason
    ) {
      return err({ ...(reason as PwrGitError), message });
    }
    return err({ kind: "git", code: "aborted", message, cause: reason });
  }

  private async canceledCheckout(
    signal: AbortSignal,
    fork: CloneRepository,
    destination: string
  ): Promise<Result<Repo>> {
    const cleaned = await removePartialCheckout(destination);
    return this.canceled(
      signal,
      cleaned
        ? `Forked to ${fork.nameWithOwner}, but the checkout was canceled and no partial checkout was kept.`
        : `Forked to ${fork.nameWithOwner}, but the checkout was canceled and PwrGit could not remove ${destination}. Remove it before retrying.`
    );
  }

  private canceledAfterRemoteCreated(
    signal: AbortSignal,
    targetSlug: string,
    host: ForgeHost
  ): Result<Repo> {
    const product = forgeProductOrAssumed(host);
    return this.canceled(
      signal,
      product.forkCompletesAsynchronously
        ? `Forked to ${targetSlug}, but the local checkout was canceled. ${product.label} may still be finishing the fork.`
        : `Forked to ${targetSlug}, but the local checkout was canceled.`
    );
  }

  private checkoutsFor(
    profileId: string,
    repository: CloneRepository
  ): string[] {
    // Read from the identities already joined onto `repo:list`, not by asking
    // Git. The version this replaced spawned `git remote get-url origin` in
    // every indexed repository — 52 subprocesses on this author's profile —
    // and preflight runs it again every time the fork name settles.
    //
    // Compared, not substring-matched: `huntharo/react` is a substring of
    // `huntharo/react-native`, and of a gitlab.com URL carrying the same slug.
    // Either false positive points "Reveal checkout" at the wrong folder.
    return this.indexer
      .listRepos(profileId)
      .filter(
        (repo) =>
          repo.identity !== undefined &&
          repo.identity.host === repository.host &&
          repo.identity.hostname === repository.hostname &&
          repo.identity.nameWithOwner.toLowerCase() ===
            repository.nameWithOwner.toLowerCase()
      )
      .map((repo) => repo.path);
  }

  private blocked(
    source: string,
    targetOwner: string | undefined,
    blocked: NonNullable<ForkPreflight["blocked"]>
  ): Result<ForkPreflight> {
    const lastSlash = source.lastIndexOf("/");
    const owner = source.slice(0, lastSlash);
    const name = source.slice(lastSlash + 1);
    const placeholder: CloneRepository = {
      name,
      owner,
      nameWithOwner: source,
      visibility: "unknown",
      host: "other",
      hostname: "",
      sshUrl: "",
      httpsUrl: "",
      localPaths: []
    };
    return ok({
      source: placeholder,
      target: {
        owner: targetOwner ?? owner,
        name,
        nameWithOwner: `${targetOwner ?? owner}/${name}`
      },
      upstreamChoices: [],
      blocked
    });
  }
}
