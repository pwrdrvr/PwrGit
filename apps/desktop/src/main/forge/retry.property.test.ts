import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgeRetryDelayMs, type ForgeHeaderReader } from "./retry";
import { RETRY_DELAY_CEILING_MS } from "../util/timing";
import { githubPre225, gitlabPre225 } from "./test-support/retry-pre-225";

/**
 * The retry policy's promises, as properties over any response a forge or a
 * proxy in front of it can send.
 *
 * #225 found GitLab retrying a header-less 429 four times at 0 ms
 * (`Number(null) === 0`). The fix had an ad-hoc differential harness and
 * mutation testing that were never committed, and #230 followed the same day.
 * The promises come from `retry.ts`'s header and `forge/AGENTS.md`, never from
 * today's output:
 *
 * - no retry sooner than one second, on any status, so nothing storms a
 *   server that said slow down;
 * - no wait past the ceiling;
 * - a server's own number (Retry-After, or the reset of a spent window) is
 *   never undercut: wait at least that long, or give up;
 * - a rate limit is retried unless its window cannot refill inside the ceiling;
 * - GitHub and GitLab answer the same response the same way, except GitHub's
 *   403 rate limit, which GitLab does not have.
 *
 * Client-level versions (the real adapters, and #230's kept batches) are in
 * `retry-clients.property.test.ts`.
 */

const NOW = Date.UTC(2026, 10, 6, 12, 0, 0);
const NOW_S = Math.floor(NOW / 1000);
const KINDS = ["github", "gitlab"] as const;
type Kind = (typeof KINDS)[number];

/** Each forge's spelling of the window headers (`RATE_LIMIT_DIALECT`). */
const SPELLING: Record<Kind, { remaining: string; reset: string }> = {
  github: { remaining: "x-ratelimit-remaining", reset: "x-ratelimit-reset" },
  gitlab: { remaining: "ratelimit-remaining", reset: "ratelimit-reset" }
};

/** One response, before either forge spells it. Absent headers are absent. */
type Response = {
  status: number | undefined;
  retryAfter?: string;
  remaining?: string;
  reset?: string;
  attempt: number;
};

/** The reader each client really has: Octokit's record answers `undefined`
 *  for an absent header, `fetch`'s `Headers` answers `null` and trims. */
function readerFor(kind: Kind, response: Response): ForgeHeaderReader {
  const bag: Record<string, string> = {};
  if (response.retryAfter !== undefined) bag["retry-after"] = response.retryAfter;
  if (response.remaining !== undefined) bag[SPELLING[kind].remaining] = response.remaining;
  if (response.reset !== undefined) bag[SPELLING[kind].reset] = response.reset;
  if (kind === "github") return (name) => bag[name];
  const headers = new Headers(bag);
  return (name) => headers.get(name);
}

function delayFor(kind: Kind, response: Response): number | null {
  return forgeRetryDelayMs({
    kind,
    status: response.status,
    header: readerFor(kind, response),
    attempt: response.attempt
  });
}

/** RFC 9110 delay-seconds: one or more digits. Anything else is not a
 *  Retry-After the server can be held to (an HTTP-date is a documented
 *  non-goal of `retry.ts`). */
function retryAfterSeconds(raw: string | undefined): number | undefined {
  const text = raw?.trim();
  if (text === undefined || !/^\d+$/.test(text)) return undefined;
  const value = Number(text);
  return value > 0 ? value : undefined;
}

/** A number, or undefined when absent, blank or garbage. */
function numeric(raw: string | undefined): number | undefined {
  const text = raw?.trim();
  if (text === undefined || text === "") return undefined;
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
}

/** The window is spent and says when it refills — the case a reset is for.
 *  A reset with no count is believed only on 429 (`retry.ts` says why). */
function spentReset(kind: Kind, response: Response): number | undefined {
  const exhaustedOn = kind === "github" ? [403, 429] : [429];
  if (response.status === undefined || !exhaustedOn.includes(response.status)) {
    return undefined;
  }
  const remaining = numeric(response.remaining);
  const reset = numeric(response.reset);
  const spent = remaining === 0 || (remaining === undefined && response.status === 429);
  return spent ? reset : undefined;
}

const headerValue = (relative: fc.Arbitrary<string>): fc.Arbitrary<string | undefined> =>
  fc.oneof(
    fc.constant(undefined),
    fc.constantFrom("", " ", "0", "abc", "-5", "1.5", "0.001", "1e2", "NaN", "Infinity"),
    fc.constantFrom("Wed, 21 Oct 2026 07:28:00 GMT"),
    relative
  );

const responseArb: fc.Arbitrary<Response> = fc
  .record({
    status: fc.oneof(
      fc.constant(undefined),
      fc.constantFrom(400, 401, 403, 404, 409, 422, 429, 429, 429, 500, 502, 503, 504),
      fc.integer({ min: 100, max: 599 })
    ),
    retryAfter: headerValue(fc.nat({ max: 7200 }).map(String)),
    remaining: headerValue(fc.nat({ max: 5000 }).map(String)),
    // A Unix time in seconds, around now: past, inside the ceiling, beyond it.
    reset: headerValue(fc.integer({ min: -7200, max: 7200 }).map((d) => String(NOW_S + d))),
    attempt: fc.integer({ min: -1, max: 12 })
  })
  .map((raw) => {
    const response: Response = { status: raw.status, attempt: raw.attempt };
    if (raw.retryAfter !== undefined) response.retryAfter = raw.retryAfter;
    if (raw.remaining !== undefined) response.remaining = raw.remaining;
    if (raw.reset !== undefined) response.reset = raw.reset;
    return response;
  });

/** Every promise above, for one forge's policy. Returns what broke. */
function brokenPromises(
  kind: Kind,
  response: Response,
  delay: (kind: Kind, response: Response) => number | null
): string[] {
  const wait = delay(kind, response);
  const broken: string[] = [];
  if (wait !== null && wait < 1000) broken.push(`retries after ${wait} ms`);
  if (wait !== null && wait > RETRY_DELAY_CEILING_MS) broken.push(`waits ${wait} ms`);

  const retryAfter = retryAfterSeconds(response.retryAfter);
  if (retryAfter !== undefined) {
    if (wait !== null && wait < retryAfter * 1000) {
      broken.push(`undercuts Retry-After ${retryAfter}s with ${wait} ms`);
    }
  } else {
    const reset = spentReset(kind, response);
    if (reset !== undefined && wait !== null && wait < reset * 1000 - NOW) {
      broken.push(`undercuts a reset ${reset * 1000 - NOW} ms away with ${wait} ms`);
    }
  }

  // A rate limit is retried unless the server named a wait past the ceiling.
  const limited = response.status === 429 || spentReset(kind, response) !== undefined;
  const beyond =
    (retryAfter !== undefined && retryAfter * 1000 > RETRY_DELAY_CEILING_MS) ||
    (retryAfter === undefined &&
      (spentReset(kind, response) ?? -Infinity) * 1000 - NOW > RETRY_DELAY_CEILING_MS);
  if (limited && !beyond && wait === null) broken.push("gives up on a rate limit");
  return broken;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("forgeRetryDelayMs keeps its promises", () => {
  it.each(KINDS)("for any %s response", (kind) => {
    fc.assert(
      fc.property(responseArb, (response) => {
        expect(brokenPromises(kind, response, delayFor)).toEqual([]);
      })
    );
  });

  it("answers GitHub and GitLab alike, except GitHub's 403 rate limit", () => {
    fc.assert(
      fc.property(responseArb, (response) => {
        const github = delayFor("github", response);
        const gitlab = delayFor("gitlab", response);
        if (response.status !== 403) {
          expect(gitlab).toBe(github);
          return;
        }
        // GitLab rate-limits with 429 only, so its 403 is a refusal unless the
        // server named a wait itself.
        if (retryAfterSeconds(response.retryAfter) === undefined) {
          expect(gitlab).toBeNull();
        } else {
          expect(gitlab).toBe(github);
        }
      })
    );
  });

  it("still catches the pre-#225 GitLab policy", () => {
    // The properties have to fail on the code #225 fixed, or they would not
    // have caught it. fast-check shrinks this to a bare 429.
    const result = fc.check(
      fc.property(responseArb, (response) =>
        brokenPromises("gitlab", response, (kind, r) =>
          gitlabPre225(r.status, readerFor(kind, r), r.attempt)
        ).length === 0
      )
    );
    expect(result.failed).toBe(true);
  });
});

describe("shrunk counterexamples", () => {
  it("backs off a 429 with no headers on both forges (#225)", () => {
    const bare: Response = { status: 429, attempt: 1 };
    expect(gitlabPre225(429, readerFor("gitlab", bare), 1)).toBe(0);
    expect(delayFor("gitlab", bare)).toBe(1000);
    expect(delayFor("github", bare)).toBe(1000);
  });

  it("reads a fractional Retry-After as absent, not as a 1 ms wait", () => {
    // `Retry-After: 0.001` retried four times inside 5 ms.
    const response: Response = { status: 429, retryAfter: "0.001", attempt: 1 };
    expect(delayFor("github", response)).toBe(1000);
    expect(delayFor("gitlab", response)).toBe(1000);
  });

  it("gives up rather than retrying inside a Retry-After past the ceiling", () => {
    // Clamped to 60 s, a `Retry-After: 3600` was four refusals inside the
    // hour the server asked for, which a spent reset already declines.
    const response: Response = { status: 429, retryAfter: "3600", attempt: 1 };
    expect(delayFor("github", response)).toBeNull();
    expect(delayFor("gitlab", response)).toBeNull();
    expect(delayFor("github", { ...response, retryAfter: "60" })).toBe(60_000);
  });
});

/**
 * #225's differential harness, committed: every combination of status ×
 * Retry-After × remaining × reset × attempt, against the frozen pre-#225
 * policy for each forge. Every divergence must have a named reason, and every
 * named reason must occur, so a new divergence (or a reason that stopped
 * applying) fails here.
 */
describe("the policy against the pre-#225 implementations", () => {
  const STATUSES = [undefined, 200, 400, 401, 403, 404, 422, 429, 500, 502, 503];
  const RETRY_AFTER = [undefined, "", " ", "0", "1", "7", "60", "61", "3600", "1.5", "0.001", "abc", "-5", "Wed, 21 Oct 2026 07:28:00 GMT"];
  const REMAINING = [undefined, "", " ", "0", "1", "abc"];
  const RESET = [undefined, "", " ", "abc", ...[-30, 0, 5, 30, 59, 61, 3600].map((d) => String(NOW_S + d))];
  const ATTEMPTS = [0, 1, 2, 3, 4, 5];

  const blank = (raw: string | undefined) => raw !== undefined && raw.trim() === "";
  const exponential = (attempt: number) => Math.min(1000 * 2 ** (Math.max(1, attempt) - 1), RETRY_DELAY_CEILING_MS);

  /** Why the policy now answers differently from the code before #225. */
  function reason(kind: Kind, r: Response, before: number | null, after: number | null): string | null {
    const ra = retryAfterSeconds(r.retryAfter);
    const raNumber = Number(r.retryAfter);
    if (r.attempt < 1 && before !== null && after !== null && before < 1000) {
      return "attempt is 1-based";
    }
    if (kind === "gitlab" && (r.remaining === undefined || r.reset === undefined) && r.status === 429 && before !== null && before < 1000) {
      return "absent header is not zero (#225)";
    }
    if (blank(r.retryAfter) || blank(r.remaining) || blank(r.reset)) {
      return "blank header is absent (#225)";
    }
    if (ra === undefined && Number.isFinite(raNumber) && raNumber > 0) {
      return "Retry-After is whole seconds";
    }
    if (ra !== undefined && ra * 1000 > RETRY_DELAY_CEILING_MS && after === null) {
      return "a Retry-After past the ceiling declines";
    }
    const reset = spentReset(kind, r);
    if (ra === undefined && reset !== undefined && reset * 1000 - NOW > RETRY_DELAY_CEILING_MS && after === null) {
      return "a window past the ceiling declines (#225)";
    }
    if (ra === undefined && reset !== undefined && after === exponential(r.attempt) && before !== null && before < after) {
      return "a reset wait is floored at the exponential wait (#225)";
    }
    if (ra === undefined && r.status === 429 && numeric(r.remaining) === undefined && reset !== undefined) {
      return "a lone reset on 429 is waited out (#225)";
    }
    return null;
  }

  it.each(KINDS)("explains every way %s differs", (kind) => {
    const old = kind === "github" ? githubPre225 : gitlabPre225;
    const seen = new Map<string, number>();
    const unexplained: string[] = [];
    for (const status of STATUSES)
      for (const retryAfter of RETRY_AFTER)
        for (const remaining of REMAINING)
          for (const reset of RESET)
            for (const attempt of ATTEMPTS) {
              const r: Response = { status, attempt };
              if (retryAfter !== undefined) r.retryAfter = retryAfter;
              if (remaining !== undefined) r.remaining = remaining;
              if (reset !== undefined) r.reset = reset;
              const before = old(status, readerFor(kind, r), attempt);
              const after = delayFor(kind, r);
              if (before === after) continue;
              const why = reason(kind, r, before, after);
              if (why === null) {
                if (unexplained.length < 10) {
                  unexplained.push(`${JSON.stringify(r)}: ${before} → ${after}`);
                }
                continue;
              }
              seen.set(why, (seen.get(why) ?? 0) + 1);
            }
    expect(unexplained).toEqual([]);
    const expected = [
      "attempt is 1-based",
      "blank header is absent (#225)",
      "Retry-After is whole seconds",
      "a Retry-After past the ceiling declines",
      "a window past the ceiling declines (#225)",
      "a reset wait is floored at the exponential wait (#225)",
      "a lone reset on 429 is waited out (#225)",
      ...(kind === "gitlab" ? ["absent header is not zero (#225)"] : [])
    ];
    expect([...seen.keys()].sort()).toEqual(expected.sort());
  });
});
