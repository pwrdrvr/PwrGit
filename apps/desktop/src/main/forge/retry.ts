import type { ForgeKind } from "@pwrgit/shared";
import { clampRetryDelayMs, RETRY_DELAY_CEILING_MS } from "../util/timing";

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
 * The order, which is the policy: an explicit `Retry-After` on any status; then
 * a rate-limit window that named its reset and says it is spent; then a 429,
 * any 5xx, or a request that never got a status, on the exponential ladder;
 * everything else is not retried.
 *
 * What it deliberately does NOT do, each pinned by a test so it stays a
 * decision rather than a surprise: read the HTTP-date form of `Retry-After`
 * (RFC 9110 allows it, neither client has ever parsed it); jitter the wait, so
 * concurrent callers do wake together; or wait out a window that cannot refill
 * inside the ceiling — that one declines instead, because retrying into a spent
 * hourly budget is what GitHub warns can get an integration banned.
 *
 * Retry *budgets* are deliberately not here either. How many attempts a call
 * may spend is the caller's to choose, and GitLab's commit association picks a
 * smaller one than its branch query on purpose — see `AGENTS.md`, "Commit
 * association has no batch API".
 */

/** How one forge spells the rate-limit conversation. */
type RateLimitDialect = {
  /** Header naming the requests left in the current window. */
  remaining: string;
  /** Header naming when that window refills. Both forges send a Unix time in
   *  seconds — GitLab's spelling is borrowed from the IETF draft, but not that
   *  draft's delta-seconds encoding, and a proxy that sent delta-seconds would
   *  read as long past and retry at once. */
  reset: string;
  /** Statuses on which an exhausted window is believed, and waited out. */
  exhaustedOn: readonly number[];
};

/** Add a forge by adding a row. One of the tables `forge/AGENTS.md` lists
 *  under "Adding a forge"; `tsc` names this one when a kind is added. */
const RATE_LIMIT_DIALECT: Readonly<Record<ForgeKind, RateLimitDialect>> = {
  github: {
    remaining: "x-ratelimit-remaining",
    reset: "x-ratelimit-reset",
    // GitHub reports a spent *primary* (hourly) budget as 403 as well as 429,
    // carrying the window headers either way — `auto-updater.ts` says the same
    // thing about the same headers. A 403 that says nothing is left is a wait;
    // a 403 without that is the refusal it reads as. (The secondary
    // "abuse detection" limit leaves the budget intact and sends Retry-After,
    // which the branch below honours without consulting this row.)
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

type ForgeRetryInput = {
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
  if (raw === null || raw === undefined) return undefined;
  // Blank, not just empty: `Number(" ")` is 0 too, so a header a proxy rewrote
  // to whitespace would walk straight back into the trap above. `Headers`
  // already trims its values; a plain record does not.
  const text = String(raw).trim();
  if (text === "") return undefined;
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * One second, doubling per attempt, inside the ceiling.
 *
 * `Math.max` holds the 1-based contract on `attempt`: a caller passing its own
 * 0-based loop index would otherwise get 500ms, silently, with every test here
 * still green.
 */
function exponentialMs(attempt: number): number {
  return clampRetryDelayMs(1000 * 2 ** (Math.max(1, attempt) - 1));
}

/** How long to wait before retrying, or null when a retry cannot help. */
export function forgeRetryDelayMs({
  kind,
  status,
  header,
  attempt
}: ForgeRetryInput): number | null {
  const dialect = RATE_LIMIT_DIALECT[kind];

  // An explicit Retry-After (in seconds, from both forges) outranks everything
  // else, on any status: the server has named its own number, and guessing a
  // smaller one only earns another refusal. Both spell this one the same way.
  const retryAfter = numericHeader(header, "retry-after");
  if (retryAfter !== undefined && retryAfter > 0) {
    return clampRetryDelayMs(retryAfter * 1000);
  }

  // An exhausted window says exactly when it refills.
  //
  // A window with requests still left is a burst limit rather than a spent
  // budget, and its reset says nothing about when this call may go again, so
  // that falls through. A reset with NO count beside it is trusted only on
  // 429 — the status that means nothing but "rate limited". GitHub stamps a
  // reset on almost every response, 403s included, so trusting a lone reset
  // there would park an ordinary permissions error for the whole budget.
  const remaining = numericHeader(header, dialect.remaining);
  const reset = numericHeader(header, dialect.reset);
  const spent = remaining === 0 || (remaining === undefined && status === 429);
  if (
    status !== undefined &&
    dialect.exhaustedOn.includes(status) &&
    reset !== undefined &&
    spent
  ) {
    const untilRefill = reset * 1000 - Date.now();
    // Past the ceiling the window cannot refill inside any budget a caller
    // would spend, so waiting it out is four guaranteed refusals — GitHub's
    // hourly GraphQL budget against a 60s ceiling is exactly that shape, and
    // GitHub warns that requests sent while limited risk a ban. Give up, and
    // let the next scheduled refresh find the window open.
    if (untilRefill > RETRY_DELAY_CEILING_MS) return null;
    // Floored at the exponential wait, never at zero: a reset that reads as
    // past — a skewed clock, a cached header, a gateway sending the IETF
    // draft's delta-seconds instead of a Unix time — would otherwise spend the
    // whole budget in a few milliseconds against a server saying slow down,
    // which is the storm this file exists to prevent.
    return Math.max(clampRetryDelayMs(untilRefill), exponentialMs(attempt));
  }

  // Transient by nature: a 429 that named no window, any 5xx, or no status at
  // all, which is a request that never reached an answer.
  if (status === undefined || status === 429 || status >= 500) {
    return exponentialMs(attempt);
  }

  // 401/403/404/422 and friends — the same request would get the same answer.
  return null;
}
