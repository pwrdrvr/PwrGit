import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgeRetryDelayMs, type ForgeHeaderReader } from "./retry";
import { RETRY_DELAY_CEILING_MS } from "../util/timing";

/** Octokit's shape: a plain record, absent keys reading as undefined. */
function record(bag: Record<string, string> = {}): ForgeHeaderReader {
  return (name) => bag[name];
}

/** GitLab's shape: a real `Headers`, absent keys reading as null. */
function fetched(bag: Record<string, string> = {}): ForgeHeaderReader {
  const headers = new Headers(bag);
  return (name) => headers.get(name);
}

const NOW = Date.UTC(2026, 0, 1);
/** A Unix time in seconds, `offsetMs` from the frozen clock. */
function resetAt(offsetMs: number): string {
  return String(Math.floor((NOW + offsetMs) / 1000));
}

beforeEach(() => {
  // Every reset case reads the clock; freezing the whole file beats nine calls
  // a reader has to check individually for whether they are load-bearing.
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("forgeRetryDelayMs", () => {
  it("waits exactly as long as an explicit Retry-After asks, on either forge", () => {
    expect(
      forgeRetryDelayMs({
        kind: "github",
        status: 429,
        header: record({ "retry-after": "7" }),
        attempt: 1
      })
    ).toBe(7_000);
    expect(
      forgeRetryDelayMs({
        kind: "gitlab",
        status: 429,
        header: fetched({ "retry-after": "7" }),
        attempt: 1
      })
    ).toBe(7_000);
  });

  it("prefers Retry-After over a window that also said when it refills", () => {
    // The server named its own number; a shorter guess only earns another 429.
    // (The clock is frozen because the losing branch would read it.)
    expect(
      forgeRetryDelayMs({
        kind: "github",
        status: 429,
        header: record({
          "retry-after": "7",
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": resetAt(30_000)
        }),
        attempt: 1
      })
    ).toBe(7_000);
  });

  it("ignores a Retry-After of zero or less rather than retrying instantly", () => {
    expect(
      forgeRetryDelayMs({
        kind: "gitlab",
        status: 503,
        header: fetched({ "retry-after": "0" }),
        attempt: 1
      })
    ).toBe(1_000);
    expect(
      forgeRetryDelayMs({
        kind: "github",
        status: 503,
        header: record({ "retry-after": "-5" }),
        attempt: 1
      })
    ).toBe(1_000);
  });

  it("waits out an exhausted window until it refills", () => {
    expect(
      forgeRetryDelayMs({
        kind: "gitlab",
        status: 429,
        header: fetched({
          "ratelimit-remaining": "0",
          "ratelimit-reset": resetAt(30_000)
        }),
        attempt: 1
      })
    ).toBe(30_000);
  });

  it("falls back to the ladder when the reset reads as already past", () => {
    // A skewed clock, a cached header, or a gateway sending the IETF draft's
    // delta-seconds instead of a Unix time. Waiting zero spent the entire
    // budget in milliseconds against a server saying slow down.
    for (const input of [
      {
        kind: "github" as const,
        status: 429,
        header: record({
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": resetAt(-90_000)
        })
      },
      {
        kind: "gitlab" as const,
        status: 429,
        header: fetched({
          "ratelimit-remaining": "0",
          "ratelimit-reset": resetAt(-90_000)
        })
      }
    ]) {
      expect(forgeRetryDelayMs({ ...input, attempt: 1 })).toBe(1_000);
      expect(forgeRetryDelayMs({ ...input, attempt: 3 })).toBe(4_000);
    }
  });

  it("declines a window that cannot refill inside the retry budget", () => {
    // GitHub's GraphQL budget resets hourly against a 60s ceiling, so waiting
    // it out was four guaranteed refusals — and GitHub warns that requests sent
    // while limited risk a ban. Failing now lets the caller keep its cache and
    // the next scheduled refresh find the window open.
    expect(
      forgeRetryDelayMs({
        kind: "github",
        status: 403,
        header: record({
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": resetAt(60 * 60_000)
        }),
        attempt: 1
      })
    ).toBeNull();
  });

  it("waits a window that refills just inside the ceiling", () => {
    expect(
      forgeRetryDelayMs({
        kind: "github",
        status: 429,
        header: record({
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": resetAt(RETRY_DELAY_CEILING_MS)
        }),
        attempt: 1
      })
    ).toBe(RETRY_DELAY_CEILING_MS);
  });

  it("backs off exponentially on a 429 that carried no headers at all", () => {
    // The trap this policy exists to hold in one place: `Headers.get` answers
    // null for an absent header and `Number(null)` is 0, so an unheadered 429
    // must not read as "nothing left, refilled at the epoch" — a zero-length
    // wait, and four immediate retries into a server already saying slow down.
    for (const header of [record(), fetched()]) {
      expect(
        forgeRetryDelayMs({ kind: "gitlab", status: 429, header, attempt: 1 })
      ).toBe(1_000);
      expect(
        forgeRetryDelayMs({ kind: "github", status: 429, header, attempt: 3 })
      ).toBe(4_000);
    }
  });

  it("does not retry a 404", () => {
    // The same request would get the same answer; spending the budget on it
    // only delays the failure the caller is already able to handle.
    expect(
      forgeRetryDelayMs({
        kind: "github",
        status: 404,
        header: record(),
        attempt: 1
      })
    ).toBeNull();
    expect(
      forgeRetryDelayMs({
        kind: "gitlab",
        status: 404,
        header: fetched(),
        attempt: 1
      })
    ).toBeNull();
  });

  it("does not retry the other client errors either", () => {
    for (const status of [400, 401, 422]) {
      expect(
        forgeRetryDelayMs({
          kind: "github",
          status,
          header: record(),
          attempt: 1
        })
      ).toBeNull();
    }
  });

  it("retries every 5xx, and a request that never got a status", () => {
    // No status is a DNS failure, a dropped socket or a client-side timeout —
    // transient by nature, and the case that most deserves a second try.
    expect(
      forgeRetryDelayMs({
        kind: "gitlab",
        status: undefined,
        header: fetched(),
        attempt: 1
      })
    ).toBe(1_000);
    expect(
      forgeRetryDelayMs({
        kind: "github",
        status: 500,
        header: record(),
        attempt: 2
      })
    ).toBe(2_000);
    expect(
      forgeRetryDelayMs({
        kind: "github",
        status: 503,
        header: record(),
        attempt: 4
      })
    ).toBe(8_000);
  });

  it("keeps each forge's spelling of the rate-limit headers", () => {
    // GitHub prefixes with `x-`; GitLab borrowed the IETF draft's names (though
    // not that draft's delta-seconds encoding). Read with the wrong dialect, an
    // exhausted window is simply invisible and the call falls back to the
    // exponential wait.
    expect(
      forgeRetryDelayMs({
        kind: "github",
        status: 429,
        header: record({
          "ratelimit-remaining": "0",
          "ratelimit-reset": resetAt(30_000)
        }),
        attempt: 1
      })
    ).toBe(1_000);
    expect(
      forgeRetryDelayMs({
        kind: "gitlab",
        status: 429,
        header: fetched({
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": resetAt(30_000)
        }),
        attempt: 1
      })
    ).toBe(1_000);
  });

  it("waits out a spent GitHub budget, which answers 403 as well as 429", () => {
    expect(
      forgeRetryDelayMs({
        kind: "github",
        status: 403,
        header: record({
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": resetAt(30_000)
        }),
        attempt: 1
      })
    ).toBe(30_000);
  });

  it("still refuses a GitLab 403, where forbidden means forbidden", () => {
    // GitLab rate-limits with 429 only, so waiting here would spend the budget
    // to be told the same thing again.
    expect(
      forgeRetryDelayMs({
        kind: "gitlab",
        status: 403,
        header: fetched({
          "ratelimit-remaining": "0",
          "ratelimit-reset": resetAt(30_000)
        }),
        attempt: 1
      })
    ).toBeNull();
  });

  it("treats a window with requests left as no reason to wait for a reset", () => {
    // 429 with budget remaining is a secondary/burst limit, not the primary
    // window, so its reset says nothing about when this call may go again.
    expect(
      forgeRetryDelayMs({
        kind: "github",
        status: 429,
        header: record({
          "x-ratelimit-remaining": "12",
          "x-ratelimit-reset": resetAt(30_000)
        }),
        attempt: 1
      })
    ).toBe(1_000);
  });

  it("ignores an unparseable header instead of computing a wait from NaN", () => {
    expect(
      forgeRetryDelayMs({
        kind: "github",
        status: 429,
        header: record({ "retry-after": "not-a-number" }),
        attempt: 1
      })
    ).toBe(1_000);
  });

  it("does not yet read the HTTP-date form of Retry-After", () => {
    // RFC 9110 allows either delta-seconds or an HTTP-date, and a WAF in front
    // of a self-managed instance may send the date. Both clients have always
    // dropped it and guessed instead; pinned here so the gap is a decision
    // rather than a surprise, and so one fix would cover both forges.
    expect(
      forgeRetryDelayMs({
        kind: "gitlab",
        status: 429,
        header: fetched({ "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }),
        attempt: 1
      })
    ).toBe(1_000);
  });

  it("reads a blank header as absent, not as a window with nothing left", () => {
    // `Number(" ")` is 0, exactly like `Number(null)` — so a header a proxy
    // rewrote to whitespace would otherwise read as "nothing left, refilled at
    // the epoch" and compute a zero-length wait on a plain record, which does
    // not trim its values the way `Headers` does.
    expect(
      forgeRetryDelayMs({
        kind: "github",
        status: 429,
        header: record({
          "x-ratelimit-remaining": " ",
          "x-ratelimit-reset": " "
        }),
        attempt: 1
      })
    ).toBe(1_000);
  });

  it("honours a lone reset on a 429, which means nothing else", () => {
    // One header of the pair is what a proxy forwards. The server still named
    // a time, which beats guessing — and reading the missing count as zero is
    // what the null-coercion trap above used to do for the wrong reason.
    expect(
      forgeRetryDelayMs({
        kind: "gitlab",
        status: 429,
        header: fetched({ "ratelimit-reset": resetAt(30_000) }),
        attempt: 1
      })
    ).toBe(30_000);
  });

  it("does not trust a lone reset on a 403, which means many things", () => {
    // GitHub stamps a reset on almost every response, permission errors
    // included, so a proxy that forwards the reset but drops the count would
    // otherwise park an ordinary 403 for the whole retry budget.
    expect(
      forgeRetryDelayMs({
        kind: "github",
        status: 403,
        header: record({ "x-ratelimit-reset": resetAt(30_000) }),
        attempt: 1
      })
    ).toBeNull();
  });

  it("does not wait on an ordinary GitHub 403 that named no window", () => {
    // `exhaustedOn: [403, 429]` is the riskiest row in the dialect table: the
    // only thing keeping a permissions error from stalling for the whole retry
    // budget is that it carries no reset.
    expect(
      forgeRetryDelayMs({
        kind: "github",
        status: 403,
        header: record({ "x-ratelimit-remaining": "4987" }),
        attempt: 1
      })
    ).toBeNull();
    expect(
      forgeRetryDelayMs({
        kind: "github",
        status: 403,
        header: record(),
        attempt: 1
      })
    ).toBeNull();
  });

  it("ignores an unparseable reset rather than computing a wait from NaN", () => {
    // `clampRetryDelayMs(NaN)` is NaN, and `setTimeout(NaN)` fires on the next
    // tick — so without the finite check this is a no-wait retry storm, not a
    // long wait. The Retry-After cases above cannot catch this: `NaN > 0` is
    // already false there, so they never reach the clamp.
    expect(
      forgeRetryDelayMs({
        kind: "github",
        status: 429,
        header: record({
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "soon"
        }),
        attempt: 1
      })
    ).toBe(1_000);
  });

  it("holds the 1-based attempt contract against a 0-based caller", () => {
    // Without the floor this is 500ms — half the intended first wait, silently,
    // with every other case here still green.
    expect(
      forgeRetryDelayMs({
        kind: "github",
        status: 500,
        header: record(),
        attempt: 0
      })
    ).toBe(1_000);
  });
});
