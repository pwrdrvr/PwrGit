import type { PrSummary } from "@pwrgit/shared";
import { mapLimit } from "../../util/map-limit";
import { clampRetryDelayMs, delay } from "../../util/timing";
import type { ForgeRepo } from "../types";
import { forgeOrigin, withNullsForMissing } from "../types";
import {
  buildMrBranchQuery,
  buildMrNumberQuery,
  parseMrPage,
  pickBestAssociation,
  pickBestByBranch,
  toSummary,
  type MrNode
} from "./mr-query";

/** Branches per GraphQL request; keeps one query's complexity bounded. */
const BRANCH_BATCH = 50;
/** Pages walked per batch before giving up on a very busy project. */
const MAX_PAGES = 5;
/** Concurrent per-commit REST calls — GitLab has no batch association API. */
const COMMIT_CONCURRENCY = 5;
/** Commits per refresh. Each costs one request, unlike GitHub's batched 50. */
const MAX_COMMITS_PER_REFRESH = 60;
const MAX_RETRIES = 4;
/**
 * Commit association is one request per SHA, so the branch query's retry budget
 * would multiply: a total outage across 60 commits would spend minutes backing
 * off on the hover path. One retry is enough — an unresolved commit is simply
 * left uncached and picked up by the next refresh.
 */
const COMMIT_MAX_RETRIES = 1;
const REQUEST_TIMEOUT_MS = 15_000;


class GitLabHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly headers: Headers | undefined
  ) {
    super(message);
    this.name = "GitLabHttpError";
  }
}

/**
 * Same backoff policy as the GitHub client, against GitLab's header names.
 *
 * GitLab sends `RateLimit-Reset` as a Unix timestamp and `Retry-After` in
 * seconds. 4xx other than 429 will not fix themselves, so they are not retried.
 */
function retryDelayMs(error: unknown, attempt: number): number | null {
  const status = error instanceof GitLabHttpError ? error.status : undefined;
  const headers = error instanceof GitLabHttpError ? error.headers : undefined;

  const retryAfter = Number(headers?.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return clampRetryDelayMs(retryAfter * 1000);

  const remaining = Number(headers?.get("ratelimit-remaining"));
  const reset = Number(headers?.get("ratelimit-reset"));
  if (status === 429 && remaining === 0 && Number.isFinite(reset)) {
    return clampRetryDelayMs(reset * 1000 - Date.now());
  }
  if (status === 429 || status === undefined || status >= 500) {
    return clampRetryDelayMs(1000 * 2 ** (attempt - 1));
  }
  return null;
}

async function request(
  url: string,
  token: string,
  init: RequestInit = {},
  maxRetries: number = MAX_RETRIES
): Promise<unknown> {
  let attempt = 0;
  for (;;) {
    try {
      const response = await fetch(url, {
        ...init,
        headers: {
          ...init.headers,
          // A keyring OAuth token and a PAT are both accepted here; Bearer
          // covers both, where PRIVATE-TOKEN only accepts a PAT.
          authorization: `Bearer ${token}`,
          "content-type": "application/json"
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      if (!response.ok) {
        throw new GitLabHttpError(
          `GitLab request failed with ${response.status}`,
          response.status,
          response.headers
        );
      }
      return await response.json();
    } catch (error) {
      attempt += 1;
      const wait = retryDelayMs(error, attempt);
      if (wait === null || attempt > maxRetries) throw error;
      await delay(wait);
    }
  }
}

async function graphql(
  repo: ForgeRepo,
  token: string,
  query: string,
  variables: Record<string, unknown>
): Promise<unknown> {
  const body = await request(`${forgeOrigin(repo)}/api/graphql`, token, {
    method: "POST",
    body: JSON.stringify({ query, variables })
  });
  // GraphQL-level errors (a project we cannot see, one bad argument) will not
  // fix on retry — salvage whatever partial data came back, as the GitHub
  // client does with GraphqlResponseError.
  return (body as { data?: unknown } | null)?.data ?? null;
}

/**
 * Newest merge request per source branch.
 *
 * Pages newest-first and stops as soon as every requested branch has a match,
 * so the common case costs one request. Branches still unmatched when paging
 * ends are returned as explicit nulls, which is what lets them negative-cache.
 */
export async function fetchMrsForBranches(
  token: string,
  repo: ForgeRepo,
  branches: string[]
): Promise<Map<string, PrSummary | null>> {
  const result = new Map<string, PrSummary | null>();
  for (let i = 0; i < branches.length; i += BRANCH_BATCH) {
    const chunk = branches.slice(i, i + BRANCH_BATCH);
    const requested = new Set(chunk);
    const found = new Map<string, PrSummary>();
    let after: string | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const { query, variables } = buildMrBranchQuery(repo.path, chunk, after);
      const parsed = parseMrPage(await graphql(repo, token, query, variables));
      for (const [branch, best] of pickBestByBranch(parsed.nodes)) {
        // Ignore anything outside the requested set: counting a stray node
        // toward the early exit below would stop paging while a branch we did
        // ask about is still unseen, and then negative-cache it.
        if (!requested.has(branch)) continue;
        const current = found.get(branch);
        // Sorted newest-first, so the first sighting of a branch wins unless a
        // later page turns up the live MR behind a newer terminal one.
        if (current === undefined) found.set(branch, best.summary);
        else if (current.state !== "open" && best.summary.state === "open") {
          found.set(branch, best.summary);
        }
      }
      if (found.size === requested.size || !parsed.hasNextPage) break;
      after = parsed.endCursor;
      if (after === null) break;
    }
    for (const [branch, summary] of withNullsForMissing(chunk, found)) {
      result.set(branch, summary);
    }
  }
  return result;
}

/** Current status of merge requests already discovered by iid. */
export async function fetchMrsByNumbers(
  token: string,
  repo: ForgeRepo,
  numbers: number[]
): Promise<Map<number, PrSummary | null>> {
  const found = new Map<number, PrSummary>();
  for (let i = 0; i < numbers.length; i += BRANCH_BATCH) {
    const chunk = numbers.slice(i, i + BRANCH_BATCH);
    const { query, variables } = buildMrNumberQuery(repo.path, chunk);
    const parsed = parseMrPage(await graphql(repo, token, query, variables));
    for (const node of parsed.nodes) {
      const summary = toSummary(node);
      if (summary.number > 0) found.set(summary.number, summary);
    }
  }
  return withNullsForMissing(numbers, found);
}

/**
 * Best merge request associated with each exact commit.
 *
 * GitLab has no batch equivalent of GitHub's `associatedPullRequests`, so this
 * is one REST call per SHA at bounded concurrency, capped per refresh. The
 * service's `commit_pr` cache is what keeps that cost off the hover path.
 */
export async function fetchMrsForCommits(
  token: string,
  repo: ForgeRepo,
  commitHashes: string[]
): Promise<Map<string, PrSummary | null>> {
  const requested = commitHashes.slice(0, MAX_COMMITS_PER_REFRESH);
  const resolved = new Map<string, PrSummary | null>();
  const project = encodeURIComponent(repo.path);
  await mapLimit(requested, COMMIT_CONCURRENCY, async (sha) => {
    try {
      const body = await request(
        `${forgeOrigin(repo)}/api/v4/projects/${project}/repository/commits/${encodeURIComponent(sha)}/merge_requests`,
        token,
        {},
        COMMIT_MAX_RETRIES
      );
      // An answered lookup with no association is a real null and must be
      // cached; a failed one is omitted entirely, because caching it would
      // turn a transient network error into "no MR" until the TTL expires.
      resolved.set(
        sha,
        pickBestAssociation(Array.isArray(body) ? (body as MrNode[]) : [])
      );
    } catch {
      // One unreachable commit must not fail the whole visible set; it simply
      // stays unknown and is retried on the next refresh.
    }
  });
  return resolved;
}
