import { graphql, GraphqlResponseError } from "@octokit/graphql";
import type { PrSummary } from "@pwrgit/shared";
import { clampRetryDelayMs, delay } from "../util/timing";
import { forgeOrigin, type ForgeRepo } from "../forge/types";
import { runGh } from "./gh-cli";
import {
  buildCommitPrQuery,
  buildPrQuery,
  buildPrNumberQuery,
  parseCommitPrResponse,
  parsePrNumberResponse,
  parsePrResponse
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
 */
export async function getGitHubToken(
  host: string = GITHUB_DOT_COM
): Promise<string | null> {
  const key = host.trim().toLowerCase();
  const cached = tokenCache.get(key);
  if (cached !== undefined && Date.now() - cached.at < TOKEN_TTL_MS) {
    return cached.token;
  }
  const env =
    key === GITHUB_DOT_COM ? process.env.GITHUB_TOKEN?.trim() : undefined;
  if (env) {
    tokenCache.set(key, { token: env, at: Date.now() });
    return env;
  }
  try {
    const token = await gh(["auth", "token", "--hostname", key]);
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


/** ghcrawl-style backoff: respect Retry-After / rate-limit reset, exponential
 *  for transient/5xx, and don't retry GraphQL-level or 4xx errors. */
function retryDelayMs(error: unknown, attempt: number): number | null {
  const status = (error as { status?: number }).status;
  const headers =
    (error as { response?: { headers?: Record<string, string> } }).response
      ?.headers ?? {};
  const retryAfter = Number(headers["retry-after"]);
  if (Number.isFinite(retryAfter) && retryAfter > 0) return clampRetryDelayMs(retryAfter * 1000);

  const remaining = Number(headers["x-ratelimit-remaining"]);
  const reset = Number(headers["x-ratelimit-reset"]);
  if ((status === 403 || status === 429) && remaining === 0 && Number.isFinite(reset)) {
    return clampRetryDelayMs(reset * 1000 - Date.now());
  }
  if (status === 429 || status === undefined || (status !== undefined && status >= 500)) {
    return clampRetryDelayMs(1000 * 2 ** (attempt - 1));
  }
  return null; // 401/403/404/422 etc. — not worth retrying
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
      return await client(query, variables);
    } catch (error) {
      // GraphQL-level errors (missing repo, one bad alias) won't fix on retry —
      // salvage whatever partial data came back.
      if (error instanceof GraphqlResponseError) {
        return (error as GraphqlResponseError<unknown>).data ?? null;
      }
      attempt += 1;
      const wait = retryDelayMs(error, attempt);
      if (wait === null || attempt > MAX_RETRIES) throw error;
      await delay(wait);
    }
  }
}

/** Fetch the most-recent PR for each branch in one repo (batched + backed off). */
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
    const data = await runQuery(token, repo, query, variables);
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
    const data = await runQuery(token, repo, query, variables);
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
    const data = await runQuery(token, repo, query, variables);
    for (const [number, pr] of parsePrNumberResponse(chunk, data)) {
      result.set(number, pr);
    }
  }
  return result;
}
