import type { PrLifecycle, PrSummary } from "@pwrgit/shared";

/** Hosting products PwrGit can read change-request status from. */
export type ForgeKind = "github" | "gitlab";

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
 * Everything `PrService` needs from a forge, and nothing more.
 *
 * Each method is best-effort from the service's point of view: it may throw,
 * and the caller keeps whatever it had cached. Returning an explicit `null` for
 * a key means "this forge has no change request for it" and is what drives
 * negative caching — omitting the key instead would make the service re-fetch
 * it forever, so implementations must return an entry for every key requested.
 */
export type ForgeProvider = {
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

/** Fill every requested key, so keys a forge omitted negative-cache correctly. */
export function withNullsForMissing<K>(
  requested: readonly K[],
  found: Map<K, PrSummary>
): Map<K, PrSummary | null> {
  return new Map(requested.map((key) => [key, found.get(key) ?? null]));
}
