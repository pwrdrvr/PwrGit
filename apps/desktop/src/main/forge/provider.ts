import type {
  CloneRepository,
  ForgeHost,
  ForgeOwner,
  ForgeRepoRef,
  ForgeStatus
} from "@pwrgit/shared";

/** What one forge must be able to answer for the clone and fork dialogs.
 *
 *  Every method may reject. Callers translate a rejection with `isAuthError`
 *  and `errorMessage` rather than inspecting the cause, so nothing above this
 *  layer needs to know which CLI produced it. */
export type ForgeProvider = {
  host: ForgeHost;
  /** The forge's canonical hostname. Self-hosted instances override it. */
  hostname: string;
  /** Fork options this forge actually supports. GitLab's fork API has no
   *  default-branch-only equivalent, and offering a switch that silently does
   *  nothing is worse than not offering it. */
  capabilities: { defaultBranchOnly: boolean };
  /** Is the CLI installed and signed in, and which accounts may it fork into? */
  status(): Promise<ForgeStatus>;
  /** Read one repository's full metadata, including fork lineage. */
  viewRepo(nameWithOwner: string): Promise<CloneRepository>;
  /** Repositories owned by one account, newest activity first. */
  listRepos(owner: string, limit: number): Promise<CloneRepository[]>;
  /** Create a fork, or return the caller's existing one. Resolves to the fork
   *  as the forge reports it after creation. */
  fork(input: ForkInput): Promise<CloneRepository>;
  /** Clone through the CLI itself, so its credential helper is used. */
  cloneWithCli(
    nameWithOwner: string,
    destination: string,
    options: { onStderr: (chunk: string) => void; env: Record<string, string> }
  ): Promise<void>;
  isAuthError(cause: unknown): boolean;
  errorMessage(cause: unknown): string;
};

export type ForkInput = {
  /** The repository being forked, as `owner/name`. */
  source: string;
  /** Account the fork is created in. */
  targetOwner: string;
  /** Name for the fork; defaults to the source's name. */
  targetName: string;
  /** Copy only the default branch (`--default-branch-only`). Ignored by a
   *  provider whose `capabilities.defaultBranchOnly` is false. */
  defaultBranchOnly: boolean;
  /** Called as the forge moves between its two unmetered steps, so the dialog
   *  can name the step instead of showing a bar that does not move. */
  onPhase?: (phase: "creating" | "awaiting_fork") => void;
};

/** Picks the provider for a host. Registered at startup so a forge with no
 *  usable CLI simply is not in the map — callers then report
 *  `unsupported_host` rather than guessing GitHub. */
export class ForgeRegistry {
  private readonly providers = new Map<ForgeHost, ForgeProvider>();

  register(provider: ForgeProvider): void {
    this.providers.set(provider.host, provider);
  }

  get(host: ForgeHost): ForgeProvider | null {
    return this.providers.get(host) ?? null;
  }

  all(): ForgeProvider[] {
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
  host: ForgeHost,
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

export const UNAVAILABLE_STATUS = (host: ForgeHost): ForgeStatus => ({
  host,
  installed: false,
  loggedIn: false,
  owners: []
});

export function repoRef(nameWithOwner: string, url: string): ForgeRepoRef {
  return { nameWithOwner, url };
}
