import type { PrSummary } from "@pwrgit/shared";
import { fetchInChunks } from "../chunked";
import { mapLimit } from "../../util/map-limit";
import { delay } from "../../util/timing";
import { forgeRetryDelayMs } from "../retry";
import type { ForgeRepo } from "../types";
import { ForgeResponseError } from "../repo-provider";
import { forgeOrigin, withNullsForMissing } from "../types";
import {
  buildMrBranchQuery,
  buildMrNumberQuery,
  parseMrPage,
  pickBestAssociation,
  pickBestByBranch,
  toSummary,
  type MrNode,
  type MrPage
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
 * The shared forge backoff (`../retry`), against GitLab's error shape.
 *
 * Only a `GitLabHttpError` carries a status and headers. Everything else the
 * retried block can throw reaches the policy as the no-status case and is
 * retried as transient — a timeout or a DNS failure, but also a `SyntaxError`
 * from `response.json()`, which is what a captive portal answering 200 with
 * HTML looks like from here.
 */
function retryDelayMs(error: unknown, attempt: number): number | null {
  const http = error instanceof GitLabHttpError ? error : undefined;
  return forgeRetryDelayMs({
    kind: "gitlab",
    status: http?.status,
    header: (name) => http?.headers?.get(name),
    attempt
  });
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
  // GraphQL-level errors will not fix on retry — salvage whatever partial data
  // came back, as the GitHub client does with a `GraphqlResponseError`. A
  // project we cannot see is answered as a null `project` *inside* `data`, so
  // it still lands here and still negative-caches, which is intended.
  const data = (body as { data?: unknown } | null)?.data ?? null;
  // `data` itself being absent is a different thing: nothing resolved, and
  // reporting that as an empty page would negative-cache every branch in the
  // batch as "no MR". `PrService` keeps what it had cached when this throws.
  if (data === null) {
    throw new ForgeResponseError(
      "GitLab answered without the data this query asked for."
    );
  }
  return data;
}

/**
 * Newest merge request per source branch, for one batch.
 *
 * Pages newest-first and stops as soon as every requested branch has a match,
 * so the common case costs one request. Paging decisions need parsed data, so
 * unlike the other clients this batch cannot separate fetch from parse — which
 * is exactly why it is a named function rather than a block inside the walk.
 */
async function newestMrPerBranch(
  token: string,
  repo: ForgeRepo,
  chunk: string[]
): Promise<Map<string, PrSummary>> {
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
  return found;
}

/**
 * Newest merge request per source branch.
 *
 * Branches still unmatched when paging ends are returned as explicit nulls,
 * which is what lets them negative-cache — but only for a batch that finished.
 * A batch abandoned mid-paging contributes nothing, because filling its nulls
 * would negative-cache branches whose MR is on a page we never read.
 */
export async function fetchMrsForBranches(
  token: string,
  repo: ForgeRepo,
  branches: string[]
): Promise<Map<string, PrSummary | null>> {
  return await fetchInChunks(
    branches,
    BRANCH_BATCH,
    async (chunk) => await newestMrPerBranch(token, repo, chunk),
    withNullsForMissing
  );
}

/**
 * Current status of merge requests already discovered by iid.
 *
 * Nulls are filled per batch rather than once at the end: each query asks for
 * its own batch's iids, so a later batch's failure must not turn numbers we
 * never asked about into "this MR is gone".
 */
export async function fetchMrsByNumbers(
  token: string,
  repo: ForgeRepo,
  numbers: number[]
): Promise<Map<number, PrSummary | null>> {
  return await fetchInChunks(
    numbers,
    BRANCH_BATCH,
    async (chunk) => {
      const { query, variables } = buildMrNumberQuery(repo.path, chunk);
      return parseMrPage(await graphql(repo, token, query, variables));
    },
    (chunk, parsed: MrPage) => {
      const found = new Map<number, PrSummary>();
      for (const node of parsed.nodes) {
        const summary = toSummary(node);
        if (summary.number > 0) found.set(summary.number, summary);
      }
      return withNullsForMissing(chunk, found);
    }
  );
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
  let failure: { error: unknown } | undefined;
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
    } catch (error) {
      // One unreachable commit must not fail the whole visible set; it simply
      // stays unknown and is retried on the next refresh.
      failure ??= { error };
    }
  });
  // Not one unreachable commit but every one of them: a revoked token or an
  // unreachable host. Resolving that as an empty map reads to `PrService` as a
  // clean answer, so it would clear the backoff instead of arming it and the
  // 60s poll would re-fan-out all sixty REST calls forever. Same first-chunk
  // rule as every other client here — "nothing resolved" must fail.
  if (resolved.size === 0 && failure !== undefined) throw failure.error;
  return resolved;
}
