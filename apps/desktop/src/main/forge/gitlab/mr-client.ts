import type { OpenChangeRequest, PrSummary } from "@pwrgit/shared";
import { fetchInChunks } from "../chunked";
import { mapLimit } from "../../util/map-limit";
import { delay } from "../../util/timing";
import { forgeRetryDelayMs } from "../retry";
import type { ForgeRepo, OpenPrList } from "../types";
import { ForgeResponseError } from "../repo-provider";
import {
  forgeOrigin,
  OPEN_PR_LIST_CAP,
  withNullsForMissing
} from "../types";
import {
  buildOpenMrQuery,
  parseOpenMrPage,
  buildMrBranchQuery,
  buildMrNumberQuery,
  mrForkPath,
  parseMrPage,
  pickBestAssociation,
  pickBestByBranch,
  toSummary,
  type MrNode,
  type MrPage,
  type MrQueryOptions
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
  if (data === null && refusedTrainFields(body)) {
    throw new MergeTrainFieldsRefused();
  }
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

/** The instance refused the merge-train fields; ask again without them. */
class MergeTrainFieldsRefused extends Error {
  constructor() {
    super("GitLab does not know the merge-train fields.");
    this.name = "MergeTrainFieldsRefused";
  }
}

/** A validation refusal naming one of `MR_TRAIN_FIELDS`. */
export function refusedTrainFields(body: unknown): boolean {
  const errors = (body as { errors?: unknown } | null)?.errors;
  if (!Array.isArray(errors)) return false;
  return errors.some((entry: { message?: unknown } | null) => {
    const message = typeof entry?.message === "string" ? entry.message : "";
    return /doesn't exist on type/i.test(message) &&
      /mergeTrainCar|availableAutoMergeStrategies|autoMergeStrategy|autoMergeEnabled|detailedMergeStatus/.test(message);
  });
}

/** Instances (host and port) without merge-train fields, for the session. */
const noTrainFields = new Set<string>();

/** For tests. */
export function resetMergeTrainFieldSupport(): void {
  noTrainFields.clear();
}

/** `graphql` with the train fields, or without them where they were refused. */
async function mrGraphql(
  repo: ForgeRepo,
  token: string,
  build: (options: MrQueryOptions) => { query: string; variables: Record<string, unknown> }
): Promise<unknown> {
  const key = `${repo.host.toLowerCase()}:${repo.port ?? ""}`;
  if (!noTrainFields.has(key)) {
    try {
      const { query, variables } = build({ mergeTrain: true });
      return await graphql(repo, token, query, variables);
    } catch (error) {
      if (!(error instanceof MergeTrainFieldsRefused)) throw error;
      noTrainFields.add(key);
    }
  }
  const { query, variables } = build({ mergeTrain: false });
  return await graphql(repo, token, query, variables);
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
    const cursor = after;
    const parsed = parseMrPage(await mrGraphql(repo, token,
      (options) => buildMrBranchQuery(repo.path, chunk, cursor, options)));
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
      return parseMrPage(await mrGraphql(repo, token,
        (options) => buildMrNumberQuery(repo.path, chunk, options)));
    },
    (chunk, parsed: MrPage) => {
      const found = new Map<number, PrSummary>();
      for (const node of parsed.nodes) {
        // A fork's carries `headRepoPath`: a lookup locates the head by it.
        const summary: OpenChangeRequest = { ...toSummary(node) };
        const fork = mrForkPath(node, repo.path);
        if (fork !== undefined) summary.headRepoPath = fork;
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

/**
 * Every open merge request, newest update first, up to `OPEN_PR_LIST_CAP`.
 *
 * Any page failing — or resolving no project — fails the walk; see
 * `OpenPrList` for why a short walk is not an answer.
 */
export async function fetchOpenMrs(
  token: string,
  repo: ForgeRepo
): Promise<OpenPrList> {
  const items: OpenPrList["items"] = [];
  const seen = new Set<string>();
  let after: string | null = null;
  for (;;) {
    const cursor = after;
    const page = parseOpenMrPage(
      await mrGraphql(repo, token, (options) => buildOpenMrQuery(repo.path, cursor, options)),
      repo.path
    );
    if (page === null) {
      throw new ForgeResponseError(
        "GitLab answered without the project this list asked for."
      );
    }
    items.push(...page.items);
    if (!page.hasNextPage || page.endCursor === null) {
      return { items, truncated: false };
    }
    if (items.length >= OPEN_PR_LIST_CAP) {
      return { items: items.slice(0, OPEN_PR_LIST_CAP), truncated: true };
    }
    if (seen.has(page.endCursor)) {
      throw new ForgeResponseError("GitLab repeated a pagination cursor.");
    }
    seen.add(page.endCursor);
    after = page.endCursor;
  }
}

/**
 * Add a merge request to its target branch's merge train
 * (`POST /projects/:id/merge_trains/merge_requests/:iid`, Premium).
 *
 * Never a merge: this endpoint only boards the train, and it fails on a
 * project without merge trains rather than merging. `sha` pins the head the
 * user looked at.
 */
export async function addMergeRequestToTrain(
  token: string,
  repo: ForgeRepo,
  iid: number,
  expectedHeadOid?: string
): Promise<{ position?: number; state?: string }> {
  const project = encodeURIComponent(repo.path);
  const body = await request(
    `${forgeOrigin(repo)}/api/v4/projects/${project}/merge_trains/merge_requests/${iid}`,
    token,
    {
      method: "POST",
      body: JSON.stringify(expectedHeadOid === undefined ? {} : { sha: expectedHeadOid })
    },
    // A POST is not retried: a lost answer to a write that landed would
    // otherwise be sent again.
    0
  );
  const car = Array.isArray(body) ? body[0] : body;
  const status = (car as { status?: unknown } | null)?.status;
  return typeof status === "string" ? { state: status } : {};
}
