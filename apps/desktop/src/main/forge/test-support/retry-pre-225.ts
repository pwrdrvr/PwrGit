import type { ForgeHeaderReader } from "../retry";

/**
 * The two retry policies #225 replaced, frozen for tests. Never import this
 * from app code.
 *
 * Copied from `07846582^` (`github/pr-client.ts` and
 * `forge/gitlab/mr-client.ts`, both `retryDelayMs`) with one change: each
 * reads headers through a `ForgeHeaderReader` instead of its client's error
 * type. GitHub read a plain record (absent → `undefined` → `Number()` is NaN);
 * GitLab read `Headers.get` (absent → `null` → `Number()` is 0). That
 * difference IS the #225 bug, so callers must pass each the reader its client
 * had. `clampRetryDelayMs` is inlined at its value then, so a later change to
 * the shared helper cannot quietly change the oracle.
 *
 * `retry.property.test.ts` keeps them for two jobs: the differential harness
 * #225's PR described and never committed (GitHub's path must differ from the
 * old one only in the ways that PR and this one name), and a check that the
 * properties there still catch the old GitLab policy.
 */

const CEILING_MS = 60_000;

function clamp(ms: number): number {
  return Math.max(0, Math.min(ms, CEILING_MS));
}

export function githubPre225(
  status: number | undefined,
  header: ForgeHeaderReader,
  attempt: number
): number | null {
  const retryAfter = Number(header("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return clamp(retryAfter * 1000);

  const remaining = Number(header("x-ratelimit-remaining"));
  const reset = Number(header("x-ratelimit-reset"));
  if ((status === 403 || status === 429) && remaining === 0 && Number.isFinite(reset)) {
    return clamp(reset * 1000 - Date.now());
  }
  if (status === 429 || status === undefined || (status !== undefined && status >= 500)) {
    return clamp(1000 * 2 ** (attempt - 1));
  }
  return null;
}

export function gitlabPre225(
  status: number | undefined,
  header: ForgeHeaderReader,
  attempt: number
): number | null {
  const retryAfter = Number(header("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return clamp(retryAfter * 1000);

  const remaining = Number(header("ratelimit-remaining"));
  const reset = Number(header("ratelimit-reset"));
  if (status === 429 && remaining === 0 && Number.isFinite(reset)) {
    return clamp(reset * 1000 - Date.now());
  }
  if (status === 429 || status === undefined || status >= 500) {
    return clamp(1000 * 2 ** (attempt - 1));
  }
  return null;
}
