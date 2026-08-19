import {
  err,
  forgeWebUrl,
  ok,
  type CloneProtocol,
  type CloneRepository,
  type ForgeHost,
  type ForgeKind,
  type ForgeOwner,
  type ForgeRepoRef,
  type ForkPreflight,
  type ForkProgress,
  type Repo,
  type Result
} from "@pwrgit/shared";
import type { ProfileService } from "../profiles/profile-service";
import type {
  ForgeRepoProvider,
  ForgeRepoRegistry
} from "../forge/repo-provider";
import { capabilitiesFor } from "../forge/capabilities";
import type { ForgeStatusService } from "../forge/status";
import type { GitExec } from "./dugite";
import { requireExit0 } from "./dugite";
import {
  CloneService,
  normalizeRepositoryPath,
  validateCheckoutDestination
} from "./clone-service";
import type { RepoIndexer } from "./repo-indexer";

/** The remote name a fork's original is added under. Not configurable: it is
 *  the near-universal convention, and `ForkService` only ever creates it on a
 *  checkout it made itself a moment earlier. */
export const UPSTREAM_REMOTE = "upstream";

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
  return host === "gitlab" ? "GitLab" : "GitHub";
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
    private readonly forgeStatus: ForgeStatusService
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
    const provider = this.forges.get(input.host);
    if (provider === null) {
      return this.blocked(source, input.targetOwner, {
        code: "unsupported_host",
        message: `PwrGit cannot fork on ${input.host} yet.`
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
    if (!status.loggedIn) {
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

  /** Accounts a fork can be created in on one forge, or none when its CLI
   *  cannot answer. Best-effort: an empty list disables the picker rather
   *  than failing the dialog. */
  async targets(host: ForgeKind): Promise<Result<ForgeOwner[]>> {
    const provider = this.forges.get(host);
    if (provider === null) return ok([]);
    const status = (await this.forgeStatus.list()).find(
      (candidate) => candidate.kind === host
    );
    if (status === undefined || !status.installed || !status.loggedIn) {
      return ok([]);
    }
    try {
      return ok(await provider.owners());
    } catch {
      return ok([]);
    }
  }

  /** Create the fork, clone it, wire `upstream`, and index the checkout. */
  async fork(
    input: ForkRequest,
    onProgress: (progress: ForkProgress) => void = () => undefined
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
    const provider = this.forges.get(input.host);
    if (provider === null) {
      return err({
        kind: "remote",
        code: "unsupported_host",
        message: `PwrGit cannot fork on ${input.host} yet.`
      });
    }

    const destinationCheck = validateCheckoutDestination(
      profile,
      input.parentPath,
      input.targetName
    );
    if (!destinationCheck.ok) return destinationCheck;
    const { parentPath, destination } = destinationCheck.value;

    onProgress({ phase: "starting", percent: null });
    let fork: CloneRepository;
    try {
      fork = await provider.fork({
        source,
        targetOwner: input.targetOwner,
        targetOwnerKind: input.targetOwnerKind,
        targetName: input.targetName,
        defaultBranchOnly:
          input.defaultBranchOnly &&
          capabilitiesFor(provider.host).forkDefaultBranchOnly,
        onPhase: (phase) => onProgress({ phase, percent: null })
      });
    } catch (cause) {
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
      // Derived from the fork the forge just reported rather than another
      // round trip: its parent is the repository it was forked from, and its
      // root the head of that network — which, with the source itself, is
      // exactly what the preflight offered.
      const candidates = [
        fork.parent?.nameWithOwner,
        fork.root?.nameWithOwner,
        source
      ].filter((slug): slug is string => slug !== undefined);
      if (
        !candidates.some(
          (slug) => slug.toLowerCase() === input.upstream!.toLowerCase()
        )
      ) {
        return err({
          kind: "validation",
          code: "invalid_repository",
          message: `${input.upstream} is not one of the repositories ${source} was forked from.`
        });
      }
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
      (progress) => onProgress(progress)
    );
    if (!cloned.ok) {
      return err({
        ...cloned.error,
        // The fork itself succeeded — saying only "clone failed" would leave
        // the user unsure whether a repository was created on the forge.
        message: `Forked to ${fork.nameWithOwner}, but the checkout failed: ${cloned.error.message}`
      });
    }

    if (input.upstream !== null) {
      onProgress({ phase: "adding_upstream", percent: null });
      const added = await this.addUpstream(
        destination,
        input.upstream,
        input.protocol,
        fork.hostname
      );
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

  private async addUpstream(
    destination: string,
    upstream: string,
    protocol: CloneProtocol,
    hostname: string
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
      destination
    );
    if (!added.ok) return added;
    const checked = requireExit0(added.value, ["remote", "add"]);
    if (!checked.ok) return checked;
    return ok(true);
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
