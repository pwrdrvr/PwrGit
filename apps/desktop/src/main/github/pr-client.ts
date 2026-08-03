import { graphql, GraphqlResponseError } from "@octokit/graphql";
import type { PrSummary } from "@pwrgit/shared";
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

let tokenCache: { token: string; at: number } | null = null;
const TOKEN_TTL_MS = 5 * 60_000;

/** GITHUB_TOKEN if set, else `gh auth token` (reusing the user's gh login). */
export async function getGitHubToken(): Promise<string | null> {
  if (tokenCache !== null && Date.now() - tokenCache.at < TOKEN_TTL_MS) {
    return tokenCache.token;
  }
  const env = process.env.GITHUB_TOKEN?.trim();
  if (env) {
    tokenCache = { token: env, at: Date.now() };
    return env;
  }
  try {
    const token = await gh(["auth", "token"]);
    if (token) {
      tokenCache = { token, at: Date.now() };
      return token;
    }
  } catch {
    // gh missing or not logged in
  }
  return null;
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

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
const clamp = (ms: number): number => Math.max(0, Math.min(ms, 60_000));

/** ghcrawl-style backoff: respect Retry-After / rate-limit reset, exponential
 *  for transient/5xx, and don't retry GraphQL-level or 4xx errors. */
function retryDelayMs(error: unknown, attempt: number): number | null {
  const status = (error as { status?: number }).status;
  const headers =
    (error as { response?: { headers?: Record<string, string> } }).response
      ?.headers ?? {};
  const retryAfter = Number(headers["retry-after"]);
  if (Number.isFinite(retryAfter) && retryAfter > 0) return clamp(retryAfter * 1000);

  const remaining = Number(headers["x-ratelimit-remaining"]);
  const reset = Number(headers["x-ratelimit-reset"]);
  if ((status === 403 || status === 429) && remaining === 0 && Number.isFinite(reset)) {
    return clamp(reset * 1000 - Date.now());
  }
  if (status === 429 || status === undefined || (status !== undefined && status >= 500)) {
    return clamp(1000 * 2 ** (attempt - 1));
  }
  return null; // 401/403/404/422 etc. — not worth retrying
}

async function runQuery(
  token: string,
  query: string,
  variables: Record<string, string | number>
): Promise<unknown> {
  const client = graphql.defaults({
    headers: { authorization: `token ${token}` }
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
  owner: string,
  repo: string,
  branches: string[]
): Promise<Map<string, PrSummary | null>> {
  const result = new Map<string, PrSummary | null>();
  for (let i = 0; i < branches.length; i += BATCH) {
    const chunk = branches.slice(i, i + BATCH);
    const { query, variables } = buildPrQuery(owner, repo, chunk);
    const data = await runQuery(token, query, variables);
    for (const [branch, pr] of parsePrResponse(chunk, data)) {
      result.set(branch, pr);
    }
  }
  return result;
}

/** Fetch the best PR associated with each exact commit in batched GraphQL calls. */
export async function fetchPrsForCommits(
  token: string,
  owner: string,
  repo: string,
  commitHashes: string[]
): Promise<Map<string, PrSummary | null>> {
  const result = new Map<string, PrSummary | null>();
  for (let i = 0; i < commitHashes.length; i += BATCH) {
    const chunk = commitHashes.slice(i, i + BATCH);
    const { query, variables } = buildCommitPrQuery(owner, repo, chunk);
    const data = await runQuery(token, query, variables);
    for (const [hash, pr] of parseCommitPrResponse(chunk, data)) {
      result.set(hash, pr);
    }
  }
  return result;
}

/** Refresh already-discovered PRs once per unique number. */
export async function fetchPrsByNumbers(
  token: string,
  owner: string,
  repo: string,
  numbers: number[]
): Promise<Map<number, PrSummary | null>> {
  const result = new Map<number, PrSummary | null>();
  for (let i = 0; i < numbers.length; i += BATCH) {
    const chunk = numbers.slice(i, i + BATCH);
    const { query, variables } = buildPrNumberQuery(owner, repo, chunk);
    const data = await runQuery(token, query, variables);
    for (const [number, pr] of parsePrNumberResponse(chunk, data)) {
      result.set(number, pr);
    }
  }
  return result;
}
