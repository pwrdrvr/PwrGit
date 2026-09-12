import type { ForgeKind } from "@pwrgit/shared";
import { clampRetryDelayMs } from "../util/timing";

/**
 * One retry/backoff decision for every forge client.
 *
 * The GitHub and GitLab clients each held a copy of this, spelled against their
 * own header names and error type, so a fix or a tuning change applied to one
 * silently missed the other. What actually differs per forge is vocabulary —
 * how the rate-limit headers are spelled, which status carries an exhausted
 * window, and the shape of the error that arrives. That is all the dialect
 * table and the caller's `header` reader supply; the decision lives here.
 *
 * Retry *budgets* are deliberately not here. How many attempts a call may spend
 * is the caller's to choose, and GitLab's commit association picks a smaller
 * one than its branch query on purpose — see `AGENTS.md`, "Commit association
 * has no batch API".
 */

/** How one forge spells the rate-limit conversation. */
type RateLimitDialect = {
  /** Header naming the requests left in the current window. */
  remaining: string;
  /** Header naming when that window refills, as a Unix time in seconds. */
  reset: string;
  /** Statuses on which an exhausted window is believed, and waited out. */
  exhaustedOn: readonly number[];
};

/** Add a forge by adding a row, the way `capabilities.ts` is extended. */
const RATE_LIMIT_DIALECT: Readonly<Record<ForgeKind, RateLimitDialect>> = {
  github: {
    remaining: "x-ratelimit-remaining",
    reset: "x-ratelimit-reset",
    // GitHub answers a *secondary* rate limit with 403 rather than 429, still
    // carrying the window headers. A 403 that says nothing is left is a wait;
    // a 403 without them stays the refusal it reads as.
    exhaustedOn: [403, 429]
  },
  gitlab: {
    remaining: "ratelimit-remaining",
    reset: "ratelimit-reset",
    // GitLab rate-limits with 429 only, so a 403 here means forbidden and
    // waiting on it would spend the budget to be told the same thing again.
    exhaustedOn: [429]
  }
};

/**
 * Reads one header off whatever the failing request carried.
 *
 * A reader rather than a bag, because the clients hold their headers in
 * different shapes: Octokit hangs a plain record off `error.response`, while
 * `fetch` gives GitLab a `Headers` whose `get` answers null. Both spellings of
 * "absent" are understood below, so no client has to normalize first.
 */
export type ForgeHeaderReader = (
  name: string
) => string | number | null | undefined;

export type ForgeRetryInput = {
  kind: ForgeKind;
  /** The HTTP status, or undefined when the request never got one — a DNS
   *  failure, a dropped socket, a client-side timeout. */
  status: number | undefined;
  header: ForgeHeaderReader;
  /** 1 on the first retry, which makes the first exponential wait one second. */
  attempt: number;
};

/**
 * A header as a number, or undefined when it is absent or unparseable.
 *
 * Absent must not read as zero. `Headers.get` answers null for a header that
 * was never sent and `Number(null)` is 0, so a 429 carrying no rate-limit
 * headers would otherwise look like a window with nothing left in it that
 * refilled at the epoch — a zero-length wait, and an immediate retry storm
 * instead of a backoff.
 */
function numericHeader(
  header: ForgeHeaderReader,
  name: string
): number | undefined {
  const raw = header(name);
  if (raw === null || raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/** How long to wait before retrying, or null when a retry cannot help. */
export function forgeRetryDelayMs({
  kind,
  status,
  header,
  attempt
}: ForgeRetryInput): number | null {
  const dialect = RATE_LIMIT_DIALECT[kind];

  // An explicit Retry-After outranks everything else: the server has named its
  // own number, and guessing a smaller one only earns another refusal. Both
  // forges spell this one the standard way.
  const retryAfter = numericHeader(header, "retry-after");
  if (retryAfter !== undefined && retryAfter > 0) {
    return clampRetryDelayMs(retryAfter * 1000);
  }

  // An exhausted window says exactly when it refills. `clampRetryDelayMs`
  // absorbs both a reset already in the past (a skewed clock) and one far
  // enough out to strand the refresh.
  const remaining = numericHeader(header, dialect.remaining);
  const reset = numericHeader(header, dialect.reset);
  if (
    status !== undefined &&
    dialect.exhaustedOn.includes(status) &&
    remaining === 0 &&
    reset !== undefined
  ) {
    return clampRetryDelayMs(reset * 1000 - Date.now());
  }

  // Transient by nature: a 429 that named no window, any 5xx, or no status at
  // all, which is a request that never reached an answer.
  if (status === undefined || status === 429 || status >= 500) {
    return clampRetryDelayMs(1000 * 2 ** (attempt - 1));
  }

  // 401/403/404/422 and friends — the same request would get the same answer.
  return null;
}
