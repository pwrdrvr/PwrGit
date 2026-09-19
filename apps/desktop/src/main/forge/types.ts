import type {
  ForgeKind,
  OpenChangeRequest,
  PrLifecycle,
  PrSummary
} from "@pwrgit/shared";

// Defined in the shared contract because the renderer needs it too, to label a
// change request "pull request" or "merge request".
export type { ForgeKind };

/**
 * A repository on a forge, identified the way that forge identifies it.
 *
 * `path` is deliberately one string rather than {owner, repo}: a GitLab project
 * may live at any depth (`group/subgroup/project`), so a two-field shape cannot
 * represent it. GitHub paths always have exactly one slash, and the GitHub
 * provider splits them back apart for its GraphQL owner/name arguments.
 */
export type ForgeRepo = {
  kind: ForgeKind;
  /** Hostname only, no scheme or port — `github.com`, `gitlab.example.com`. */
  host: string;
  /**
   * Web port, only when the remote named a non-default one over http(s).
   *
   * Kept out of `host` on purpose: `host` is compared against URL hostnames and
   * passed to `gh`/`glab` as `--hostname`, both of which want a bare name. Only
   * URL building adds the port — see `forgeOrigin`.
   */
  port?: number;
  /** Namespace path without leading/trailing slashes or a `.git` suffix. */
  path: string;
};

/** Base URL for this repo's forge API, including a non-default web port. */
export function forgeOrigin(repo: Pick<ForgeRepo, "host" | "port">): string {
  return `https://${repo.host}${repo.port === undefined ? "" : `:${repo.port}`}`;
}

/**
 * One complete walk of a repository's open change requests, newest update
 * first.
 *
 * "Complete" is the contract: a provider that could not read every page it set
 * out to read throws rather than returning the pages it got, because the
 * service replaces its cached list wholesale and a short walk would silently
 * drop the change requests on the pages never read. `truncated` is the one
 * honest short answer — the walk stopped at its own page cap, and what it
 * returned is the newest of a longer list.
 */
export type OpenPrList = {
  items: OpenChangeRequest[];
  truncated: boolean;
};

/** How many open change requests one list refresh reads before it stops. */
export const OPEN_PR_LIST_CAP = 500;

/**
 * `headRepoPath` for a change request the forge says came from a fork it will
 * not name (deleted, or private to this token). The head is still reachable
 * through the change-request ref, and calling it same-repository would send a
 * checkout looking for a branch origin never had.
 */
export const UNAVAILABLE_FORK = "(fork unavailable)";

/**
 * Everything `PrService` needs from a forge, and nothing more.
 *
 * Each method is best-effort from the service's point of view: it may throw,
 * and the caller keeps whatever it had cached. Returning an explicit `null` for
 * a key means "this forge has no change request for it" and is what drives
 * negative caching, so return an entry for every key the forge actually
 * answered about.
 *
 * Omit a key only where the lookup *failed* — an unreachable commit, or a
 * batch the walk never reached. The service reads an omitted key as "never
 * looked up" and remembers the attempt in memory instead, which is what keeps
 * a blip from being cached as "no change request". Never fill a null for a key
 * you did not get an answer for. See ./AGENTS.md, "Return an entry for every
 * key requested" and the two bullets that qualify it.
 */
export type TokenForgeProvider = {
  authentication?: "token";
  kind: ForgeKind;
  /** A token for this host, or null when the user isn't logged in. */
  getToken(host: string): Promise<string | null>;
  /** Newest change request per source branch. One entry per requested branch. */
  fetchPrsForBranches(
    token: string,
    repo: ForgeRepo,
    branches: string[]
  ): Promise<Map<string, PrSummary | null>>;
  /** Best change request associated with each exact commit SHA. */
  fetchPrsForCommits(
    token: string,
    repo: ForgeRepo,
    commitHashes: string[]
  ): Promise<Map<string, PrSummary | null>>;
  /** Current status of change requests already discovered by number. */
  fetchPrsByNumbers(
    token: string,
    repo: ForgeRepo,
    numbers: number[]
  ): Promise<Map<number, PrSummary | null>>;
  /** Every open change request, newest update first — see `OpenPrList`. */
  fetchOpenPrs(token: string, repo: ForgeRepo): Promise<OpenPrList>;
};

/**
 * Normalize a forge's own state vocabulary onto `PrLifecycle`.
 *
 * GitHub sends OPEN/MERGED/CLOSED; GitLab sends opened/merged/closed/locked.
 * `locked` is an open MR whose discussion was locked, so it maps to "open" —
 * treating it as terminal would let the service stop refreshing a live MR.
 */
export function toPrLifecycle(state: string): PrLifecycle {
  switch (state.trim().toLowerCase()) {
    case "merged":
      return "merged";
    case "closed":
      return "closed";
    default:
      return "open";
  }
}

/**
 * Stamp forge identity onto summaries a provider produced.
 *
 * A number alone is ambiguous — `#4` means different things on two forges and
 * on two instances of one forge — so the identity travels with the summary
 * rather than being re-derived by every reader.
 */
export function stampForge<K>(
  summaries: Map<K, PrSummary | null>,
  repo: ForgeRepo
): Map<K, PrSummary | null> {
  return new Map(
    [...summaries].map(([key, summary]) => [
      key,
      summary === null
        ? null
        : { ...summary, forge: repo.kind, host: repo.host, repoPath: repo.path }
    ])
  );
}

/** Fill every requested key, so keys a forge omitted negative-cache correctly. */
export function withNullsForMissing<K>(
  requested: readonly K[],
  found: Map<K, PrSummary>
): Map<K, PrSummary | null> {
  return new Map(requested.map((key) => [key, found.get(key) ?? null]));
}

export type ForgeConnection = {
  fetchPrsForBranches(
    repo: ForgeRepo,
    branches: string[]
  ): Promise<Map<string, PrSummary | null>>;
  fetchPrsForCommits(
    repo: ForgeRepo,
    commits: string[]
  ): Promise<Map<string, PrSummary | null>>;
  fetchPrsByNumbers(
    repo: ForgeRepo,
    numbers: number[]
  ): Promise<Map<number, PrSummary | null>>;
  fetchOpenPrs(repo: ForgeRepo): Promise<OpenPrList>;
};
export type CliForgeProvider = ForgeConnection & {
  kind: ForgeKind;
  authentication: "cli";
};
export type ForgeProvider = TokenForgeProvider | CliForgeProvider;

/** CLI providers authenticate each command internally; token providers stay unchanged. */
export async function connectForge(
  provider: ForgeProvider,
  host: string
): Promise<ForgeConnection | null> {
  if (provider.authentication === "cli") return provider;
  const token = await provider.getToken(host);
  if (token === null) return null;
  return {
    fetchPrsForBranches: (repo, branches) =>
      provider.fetchPrsForBranches(token, repo, branches),
    fetchPrsForCommits: (repo, commits) =>
      provider.fetchPrsForCommits(token, repo, commits),
    fetchPrsByNumbers: (repo, numbers) =>
      provider.fetchPrsByNumbers(token, repo, numbers),
    fetchOpenPrs: (repo) => provider.fetchOpenPrs(token, repo)
  };
}

/** `stampForge` for a list: every item learns which instance issued it. */
export function stampOpenList(list: OpenPrList, repo: ForgeRepo): OpenPrList {
  return {
    truncated: list.truncated,
    items: list.items.map((item) => ({
      ...item,
      forge: repo.kind,
      host: repo.host,
      repoPath: repo.path
    }))
  };
}
