import { afterEach, describe, expect, it, vi } from "vitest";
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
  return String((NOW + offsetMs) / 1000);
}

function freezeClock(): void {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
}

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
    freezeClock();
    // The server named its own number; a shorter guess only earns another 429.
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
    freezeClock();
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

  it("retries at once when the reset is already in the past", () => {
    freezeClock();
    // A skewed clock, or a window that refilled while the response was in
    // flight: the wait is negative, and waiting a negative time is waiting none.
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
      expect(forgeRetryDelayMs({ ...input, attempt: 1 })).toBe(0);
    }
  });

  it("never strands a refresh behind a far-future reset", () => {
    freezeClock();
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
    freezeClock();
    // GitHub prefixes with `x-`, GitLab uses the IETF draft names. Read with
    // the wrong dialect, an exhausted window is simply invisible and the call
    // falls back to the exponential wait.
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

  it("waits out GitHub's secondary limit, which answers 403 rather than 429", () => {
    freezeClock();
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
    freezeClock();
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
    freezeClock();
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
        header: record({ "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }),
        attempt: 1
      })
    ).toBe(1_000);
  });
});
