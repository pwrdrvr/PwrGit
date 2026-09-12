import { graphql, GraphqlResponseError } from "@octokit/graphql";
import type { PrSummary } from "@pwrgit/shared";
import { delay } from "../util/timing";
import { forgeRetryDelayMs } from "../forge/retry";
import { forgeOrigin, type ForgeRepo } from "../forge/types";
import { runGh } from "./gh-cli";
import { ForgeResponseError } from "../forge/repo-provider";
import {
  buildCommitPrQuery,
  buildPrQuery,
  buildPrNumberQuery,
  parseCommitPrResponse,
  parsePrNumberResponse,
  parsePrResponse,
  repositoryResolved
} from "./pr-query";
async function gh(args: string[]): Promise<string> {
  return runGh(args);
}

const TOKEN_TTL_MS = 5 * 60_000;
/** Keyed by host, mirroring `getGitLabToken`: an Enterprise Server instance and
 *  github.com are different credentials, and a single-slot cache would hand one
 *  host's token to the other for the rest of the TTL. */
const tokenCache = new Map<string, { token: string; at: number }>();

export const GITHUB_DOT_COM = "github.com";

/** Only reset by tests; the cache is otherwise per-host and time-bounded. */
export function clearGitHubTokenCache(): void {
  tokenCache.clear();
}

/**
 * `GITHUB_TOKEN` if set, else the token `gh` already holds for this host.
 *
 * `gh auth token` without `--hostname` answers for whatever host `gh` considers
 * default, which on a machine signed in to both github.com and an Enterprise
 * instance is a coin toss the caller cannot see. Always ask for the host we are
 * about to query.
 *
 * `GITHUB_TOKEN` applies to **github.com only**. It is a github.com PAT in
 * every convention that sets it, and sending it to a self-managed Enterprise
 * host would hand that server a credential for a forge it has nothing to do
 * with. `gh` draws the same line (`GH_ENTERPRISE_TOKEN` is a separate
 * variable), so an Enterprise host falls through to `gh auth token` instead.
 *
 * Omitting `host` means "whatever host `gh` considers default", NOT github.com.
 * That distinction is load-bearing: `GH_HOST` sets gh's default, and defaulting
 * to github.com here would pass `--hostname github.com` and override it — so an
 * operator who points `GH_HOST` at their Enterprise instance would watch
 * Settings → Forges flip from Connected to Signed out. Callers that know which
 * host they are about to query pass it. The status probe names the hosts it
 * reports on and omits the host for its `assumed` target — the backfilled SaaS
 * entry that exists precisely because nothing named a host — so `GH_HOST` still
 * decides there. See `ForgeStatusHost.assumed` in `../forge/status.ts`.
 */
export async function getGitHubToken(
  host?: string
): Promise<string | null> {
  const key = host?.trim().toLowerCase() ?? "";
  const cached = tokenCache.get(key);
  if (cached !== undefined && Date.now() - cached.at < TOKEN_TTL_MS) {
    return cached.token;
  }
  // "" is gh's own default host, which GITHUB_TOKEN has always applied to.
  const env =
    key === "" || key === GITHUB_DOT_COM
      ? process.env.GITHUB_TOKEN?.trim()
      : undefined;
  if (env) {
    tokenCache.set(key, { token: env, at: Date.now() });
    return env;
  }
  try {
    const token = await gh(
      key === "" ? ["auth", "token"] : ["auth", "token", "--hostname", key]
    );
    if (token) {
      tokenCache.set(key, { token, at: Date.now() });
      return token;
    }
  } catch {
    // gh missing, or holds no account for this host.
  }
  return null;
}

/**
 * The GraphQL base URL for a GitHub repo's host.
 *
 * `@octokit/graphql` appends `/graphql` to whatever `baseUrl` it is given, so
 * Enterprise Server wants `https://HOST/api` and github.com wants the SaaS
 * endpoint it already defaults to. Returning undefined for github.com keeps
 * that default rather than restating it, so this cannot drift from Octokit.
 *
 * Built from `forgeOrigin` — the same helper the GitLab client uses — so a
 * remote that named a non-default web port keeps it. Dropping the port would
 * send the Enterprise token at whatever answers on 443 instead.
 */
export function githubGraphqlBaseUrl(
  repo: Pick<ForgeRepo, "host" | "port">
): string | undefined {
  const key = repo.host.trim().toLowerCase();
  if (key === "") return undefined;
  if (key === GITHUB_DOT_COM && repo.port === undefined) return undefined;
  return `${forgeOrigin({ ...repo, host: key })}/api`;
}

export type GhStatus = { installed: boolean; loggedIn: boolean };

export async function getGhStatus(): Promise<GhStatus> {
  try {
    await gh(["--version"]);
  } catch {
    return { installed: false, loggedIn: false };
  }
  return { installed: true, loggedIn: (await getGitHubToken()) !== null };
}

// One request covers this many branches (aliased); 100 branches → 2 requests.
const BATCH = 50;
const MAX_RETRIES = 4;


/**
 * Is this GraphQL-level error GitHub saying "rate limited"?
 *
 * The REST API answers a spent budget with 403/429. GraphQL answers it with
 * **HTTP 200** and an `errors` entry, so `@octokit/graphql` raises it as a
 * `GraphqlResponseError` — the same class a missing repo arrives as, and the
 * one error shape the backoff would otherwise never see.
 */
function isGraphqlRateLimit(error: GraphqlResponseError<unknown>): boolean {
  // `errors` is typed as a required array, but it is whatever the server sent:
  // Octokit throws on any truthy value, so a proxy answering `{"errors":{…}}`
  // would make `.some` a TypeError raised inside `runQuery`'s catch, replacing
  // the real failure — the hazard the adapter below is already written against.
  const { errors } = error;
  return (
    Array.isArray(errors) &&
    errors.some((entry) => entry?.type === "RATE_LIMITED")
  );
}

/**
 * ghcrawl-style backoff, decided in `../forge/retry` so GitLab shares it.
 *
 * Octokit hangs the response — and so the rate-limit headers — off the error,
 * lowercased, and `ResponseHeaders` types its values as string *or* number.
 * There is no response to read when the request never reached one, but there
 * is still a status: `@octokit/request` stamps a synthetic 500 on a DNS
 * failure, a dropped socket and an abort alike, so those arrive here as 5xx
 * rather than as the no-status case the policy also handles.
 *
 * `error` is typed `unknown` and a rejection can be anything, including null —
 * and throwing from in here would replace the real failure with a TypeError
 * raised inside `runQuery`'s catch.
 */
function retryDelayMs(error: unknown, attempt: number): number | null {
  // A GraphQL rate limit came back 200, so it has no status of its own, and its
  // headers hang directly off the error — `response` there is the GraphQL body,
  // not the HTTP one. Reading it as the 429 it means puts the window it names
  // under the same policy as a REST 429 rather than beside it.
  if (error instanceof GraphqlResponseError) {
    // Only a rate limit is worth retrying here, and the check belongs beside
    // the synthetic status rather than at the one call site that happens to
    // filter first — a second caller would otherwise turn a SAML refusal into
    // four retries of an answer that cannot change.
    if (!isGraphqlRateLimit(error)) return null;
    const { headers } = error;
    return forgeRetryDelayMs({
      kind: "github",
      status: 429,
      header: (name) => headers?.[name],
      attempt
    });
  }
  const { status, response } = (error ?? {}) as {
    status?: unknown;
    response?: { headers?: Record<string, string | number | undefined> };
  };
  return forgeRetryDelayMs({
    kind: "github",
    status: typeof status === "number" ? status : undefined,
    header: (name) => response?.headers?.[name],
    attempt
  });
}

async function runQuery(
  token: string,
  repo: Pick<ForgeRepo, "host" | "port">,
  query: string,
  variables: Record<string, string | number>
): Promise<unknown> {
  const base = githubGraphqlBaseUrl(repo);
  const client = graphql.defaults({
    headers: { authorization: `token ${token}` },
    // Absent for github.com so Octokit's own default endpoint stands.
    ...(base === undefined ? {} : { baseUrl: base })
  });
  let attempt = 0;
  for (;;) {
    try {
      const data = await client(query, variables);
      // A 200 is not automatically an answer. Octokit only throws when the body
      // carries `errors`, so a captive portal's HTML, a `{"message":…}` body,
      // or GitHub's secondary rate limit — which it documents as a 200 — all
      // resolve here as a shape with no repository in it, and the parsers would
      // read that as "no PR" on every branch.
      if (!repositoryResolved(data)) {
        throw new ForgeResponseError(
          "GitHub answered without the repository this query asked for."
        );
      }
      return data;
    } catch (error) {
      // A rate limit is the one GraphQL-level error that *does* fix on retry,
      // and it names the window to wait out in its own headers, so it falls
      // past this to the backoff below.
      if (error instanceof GraphqlResponseError && !isGraphqlRateLimit(error)) {
        // One bad alias among fifty still resolves the other forty-nine, and
        // asking again returns the same answer — so salvage, but only once the
        // container itself came back. A null repository is a refusal or an
        // absence, and returning it would map *every* branch in the batch to
        // "no PR" and negative-cache that for the whole refresh TTL, where
        // throwing lets `PrService` keep what it already had.
        if (repositoryResolved(error.data)) return error.data;
        throw error;
      }
      attempt += 1;
      const wait = retryDelayMs(error, attempt);
      if (wait === null || attempt > MAX_RETRIES) throw error;
      await delay(wait);
    }
  }
}

/**
 * Fetch the most-recent PR for each branch in one repo (batched + backed off).
 *
 * A chunk that fails ends the walk with whatever the earlier chunks resolved,
 * rather than discarding them: 250 branches refused on the fourth request
 * would otherwise throw away 150 branches of answered data. Only a first chunk
 * failing — nothing resolved at all — rethrows, because that is the case the
 * caller must not read as "no PR anywhere". Stopping rather than skipping to
 * the next chunk is deliberate: a revoked token or a complexity cap refuses
 * every chunk alike, and continuing would spend the whole retry budget again
 * per chunk for an answer that cannot change.
 */
export async function fetchPrsForRepo(
  token: string,
  repo: Pick<ForgeRepo, "host" | "port">,
  owner: string,
  name: string,
  branches: string[]
): Promise<Map<string, PrSummary | null>> {
  const result = new Map<string, PrSummary | null>();
  for (let i = 0; i < branches.length; i += BATCH) {
    const chunk = branches.slice(i, i + BATCH);
    const { query, variables } = buildPrQuery(owner, name, chunk);
    let data: unknown;
    try {
      data = await runQuery(token, repo, query, variables);
    } catch (error) {
      if (result.size === 0) throw error;
      return result;
    }
    for (const [branch, pr] of parsePrResponse(chunk, data)) {
      result.set(branch, pr);
    }
  }
  return result;
}

/** Fetch the best PR associated with each exact commit in batched GraphQL calls. */
export async function fetchPrsForCommits(
  token: string,
  repo: Pick<ForgeRepo, "host" | "port">,
  owner: string,
  name: string,
  commitHashes: string[]
): Promise<Map<string, PrSummary | null>> {
  const result = new Map<string, PrSummary | null>();
  for (let i = 0; i < commitHashes.length; i += BATCH) {
    const chunk = commitHashes.slice(i, i + BATCH);
    const { query, variables } = buildCommitPrQuery(owner, name, chunk);
    let data: unknown;
    try {
      data = await runQuery(token, repo, query, variables);
    } catch (error) {
      // Same salvage as above; an omitted hash is simply not cached, which
      // `staleCommitHashes` already treats as "never looked up".
      if (result.size === 0) throw error;
      return result;
    }
    for (const [hash, pr] of parseCommitPrResponse(chunk, data)) {
      result.set(hash, pr);
    }
  }
  return result;
}

/** Refresh already-discovered PRs once per unique number. */
export async function fetchPrsByNumbers(
  token: string,
  repo: Pick<ForgeRepo, "host" | "port">,
  owner: string,
  name: string,
  numbers: number[]
): Promise<Map<number, PrSummary | null>> {
  const result = new Map<number, PrSummary | null>();
  for (let i = 0; i < numbers.length; i += BATCH) {
    const chunk = numbers.slice(i, i + BATCH);
    const { query, variables } = buildPrNumberQuery(owner, name, chunk);
    let data: unknown;
    try {
      data = await runQuery(token, repo, query, variables);
    } catch (error) {
      if (result.size === 0) throw error;
      return result;
    }
    for (const [number, pr] of parsePrNumberResponse(chunk, data)) {
      result.set(number, pr);
    }
  }
  return result;
}
