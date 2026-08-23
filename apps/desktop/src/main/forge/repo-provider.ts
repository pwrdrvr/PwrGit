import type {
  CloneRepository,
  ForgeHost,
  ForgeKind,
  ForgeOwner,
  ForgeRepoRef
} from "@pwrgit/shared";

/** What one forge must answer for the clone and fork dialogs.
 *
 *  Deliberately separate from `types.ts`'s `ForgeProvider`, which answers
 *  change-request status: these are different questions about the same two
 *  hosts, and widening that four-method seam would drag `PrService` into
 *  repository metadata it does not use.
 *
 *  Every method may reject. Callers translate a rejection with `isAuthError`
 *  and `errorMessage` rather than inspecting the cause, so nothing above this
 *  layer needs to know which CLI produced it. */
export type ForgeRepoProvider = {
  /** Always a real forge — `other` has no provider, which is what makes
   *  `registry.get()` return null for it. */
  host: ForgeKind;
  /** The forge's canonical hostname. Self-hosted instances override it. */
  hostname: string;
  /** Accounts this forge can create a fork in, for the signed-in user.
   *
   *  Availability (installed / logged in) is deliberately NOT here:
   *  `ForgeStatusService` already answers that for the whole app, from one
   *  cached probe. A provider that probed again would spawn a second
   *  subprocess to learn something main already knew. */
  owners(): Promise<ForgeOwner[]>;
  /** Read one repository's full metadata, including fork lineage. */
  viewRepo(nameWithOwner: string): Promise<CloneRepository>;
  /** Repositories matching a query, answered by the forge's own search.
   *
   *  There is deliberately no "list everything this account owns": the clone
   *  dialog used to call one per known owner as it opened, which is one round
   *  trip per account before the user has typed a character. Searching is a
   *  single call and only ever runs on settled input. */
  searchRepos(input: RepoSearch): Promise<CloneRepository[]>;
  /** Create a fork, or return the caller's existing one. Resolves to the fork
   *  as the forge reports it after creation. */
  fork(input: ForkInput): Promise<CloneRepository>;
  /** Clone through the CLI itself, so its credential helper is used. */
  cloneWithCli(
    nameWithOwner: string,
    destination: string,
    options: {
      onStderr: (chunk: string) => void;
      env: Record<string, string>;
      signal?: AbortSignal;
    }
  ): Promise<void>;
  isAuthError(cause: unknown): boolean;
  errorMessage(cause: unknown): string;
};

/** One repository search. Both fields may be empty in isolation but not
 *  together — a search with neither a term nor an owner is an enumeration of
 *  the whole forge, which is what this seam exists to prevent. */
export type RepoSearch = {
  /** Free text from the input box, already stripped of any owner prefix. */
  query: string;
  /** Accounts to restrict the search to. Empty searches the whole forge, which
   *  is what a profile with nothing indexed yet gets. */
  owners: string[];
  limit: number;
};

export type ForkInput = {
  /** The repository being forked, as `owner/name`. */
  source: string;
  /** Account the fork is created in. */
  targetOwner: string;
  /** Whether that account is the signed-in user or an organization. Passed
   *  rather than re-derived: `status()` already established it, and a
   *  provider that re-asks has to decide what to do when the second answer
   *  fails — which is how a personal fork ends up with `--org <user>`. */
  targetOwnerKind: "user" | "organization";
  /** Name for the fork; defaults to the source's name. */
  targetName: string;
  /** Copy only the default branch. Ignored where the forge's
   *  `forkDefaultBranchOnly` capability is false. */
  defaultBranchOnly: boolean;
  /** Called as the forge moves between its two unmetered steps, so the dialog
   *  can name the step instead of showing a bar that does not move. */
  onPhase?: (phase: "creating" | "awaiting_fork") => void;
  /** Cancels the CLI call and any forge-side readiness wait. A forge that
   *  completed before cancellation is deliberately not deleted. */
  signal?: AbortSignal;
};

/** Picks the provider for a host. Registered at startup so a forge with no
 *  usable CLI simply is not in the map — callers then report
 *  `unsupported_host` rather than guessing GitHub. */
export class ForgeRepoRegistry {
  private readonly providers = new Map<ForgeHost, ForgeRepoProvider>();

  register(provider: ForgeRepoProvider): void {
    this.providers.set(provider.host, provider);
  }

  get(host: ForgeHost): ForgeRepoProvider | null {
    return this.providers.get(host) ?? null;
  }

  all(): ForgeRepoProvider[] {
    return [...this.providers.values()];
  }
}

/** Split `owner/name`, where the owner may itself contain slashes (GitLab
 *  subgroups). Returns null when there is no owner segment at all. */
export function splitNameWithOwner(
  nameWithOwner: string
): { owner: string; name: string } | null {
  const trimmed = nameWithOwner.trim().replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");
  const lastSlash = trimmed.lastIndexOf("/");
  if (lastSlash <= 0 || lastSlash === trimmed.length - 1) return null;
  return {
    owner: trimmed.slice(0, lastSlash),
    name: trimmed.slice(lastSlash + 1)
  };
}

/** A forge answered, but not with the shape we asked for. Distinct from a CLI
 *  failure: the command succeeded and the payload was still unusable. */
export class ForgeResponseError extends Error {
  readonly name = "ForgeResponseError";
}

export function parseJsonObject(stdout: string, what: string): unknown {
  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    throw new ForgeResponseError(`Could not read the ${what} response.`);
  }
}

export function ownersFrom(
  host: ForgeKind,
  user: string | null,
  organizations: string[]
): ForgeOwner[] {
  const owners: ForgeOwner[] = [];
  if (user !== null && user.trim() !== "") {
    owners.push({ login: user.trim(), kind: "user", host });
  }
  for (const organization of organizations) {
    if (organization.trim() === "") continue;
    if (
      owners.some(
        (owner) => owner.login.toLowerCase() === organization.trim().toLowerCase()
      )
    ) {
      continue;
    }
    owners.push({ login: organization.trim(), kind: "organization", host });
  }
  return owners;
}
