import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The Octokit client `runQuery` builds with `graphql.defaults(...)`. */
const { client } = vi.hoisted(() => ({ client: vi.fn() }));

vi.mock("@octokit/graphql", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@octokit/graphql")>();
  // Only the transport is replaced: `GraphqlResponseError` stays the real
  // class, or the `instanceof` check that salvages partial data cannot fire.
  return { ...actual, graphql: { defaults: () => client } };
});

import { GraphqlResponseError } from "@octokit/graphql";
import { fetchPrsForRepo } from "./pr-client";

const REPO = { host: "github.com" };

/** What `@octokit/request` rejects with: the headers hang off `response`. */
function httpError(status: number, headers: Record<string, string> = {}): Error {
  return Object.assign(new Error(`HTTP ${status}`), {
    status,
    response: { status, headers, data: null }
  });
}

/**
 * What `@octokit/graphql` raises for an HTTP 200 carrying `errors`. The headers
 * are the 2nd constructor argument and live on the error itself; `response` is
 * the GraphQL body.
 */
function graphqlError(
  errors: { type: string; message?: string }[],
  data: unknown = null,
  headers: Record<string, string> = {}
): Error {
  return new GraphqlResponseError(
    { method: "POST", url: "/graphql" } as never,
    headers,
    { data, errors: errors as never }
  );
}

function prNode(number: number): unknown {
  return {
    number,
    title: `PR ${number}`,
    url: `https://github.com/o/r/pull/${number}`,
    state: "OPEN",
    isDraft: false
  };
}

beforeEach(() => {
  client.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GitHub backoff", () => {
  it("does not retry a 404", async () => {
    client.mockRejectedValue(httpError(404));

    await expect(
      fetchPrsForRepo("t", REPO, "o", "r", ["a"])
    ).rejects.toThrow();
    expect(client).toHaveBeenCalledTimes(1);
  });

  it("retries a 500 and succeeds", async () => {
    vi.useFakeTimers();
    client
      .mockRejectedValueOnce(httpError(500))
      .mockResolvedValueOnce({ repository: { a0: { nodes: [prNode(7)] } } });

    const pending = fetchPrsForRepo("t", REPO, "o", "r", ["a"]);
    await vi.advanceTimersByTimeAsync(1_000);

    expect((await pending).get("a")).toMatchObject({ number: 7 });
    expect(client).toHaveBeenCalledTimes(2);
  });

  it("waits the Retry-After Octokit hung off the error's response", async () => {
    vi.useFakeTimers();
    client
      .mockRejectedValueOnce(httpError(429, { "retry-after": "5" }))
      .mockResolvedValueOnce({ repository: {} });

    const pending = fetchPrsForRepo("t", REPO, "o", "r", ["a"]);
    // Not the one-second exponential wait: the server named five, and reading
    // the header off the wrong place on the error is how that gets missed.
    await vi.advanceTimersByTimeAsync(4_000);
    expect(client).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);

    expect((await pending).get("a")).toBeNull();
    expect(client).toHaveBeenCalledTimes(2);
  });

  it("retries a network failure, which carries a status but no response", async () => {
    vi.useFakeTimers();
    // `@octokit/request` stamps a synthetic 500 on a DNS failure or a dropped
    // socket and leaves `response` undefined — the one shape that exercises the
    // adapter's optional chaining before it reads a header.
    client
      .mockRejectedValueOnce(
        Object.assign(new Error("request to ... failed"), { status: 500 })
      )
      .mockResolvedValueOnce({ repository: {} });

    const pending = fetchPrsForRepo("t", REPO, "o", "r", ["a"]);
    await vi.advanceTimersByTimeAsync(1_000);

    expect((await pending).get("a")).toBeNull();
    expect(client).toHaveBeenCalledTimes(2);
  });

  it("survives a rejection that is not an object at all", async () => {
    vi.useFakeTimers();
    // Reading the status off `null` would throw from inside `runQuery`'s catch,
    // replacing the real failure with a TypeError and skipping the budget
    // entirely. With no status to read it is transient, so it spends the four
    // retries and then rethrows as itself.
    client.mockRejectedValue(null);

    const settled = fetchPrsForRepo("t", REPO, "o", "r", ["a"]).catch(
      (error: unknown) => error
    );
    await vi.advanceTimersByTimeAsync(15_000);

    expect(await settled).toBeNull();
    expect(client).toHaveBeenCalledTimes(5);
  });

  it("waits out a GraphQL rate limit, which arrives as an HTTP 200", async () => {
    vi.useFakeTimers();
    // GitHub reports a spent GraphQL budget with `errors`, not a 429, so this
    // is the one GraphQL-level error that must reach the backoff — and the
    // window it names is on the error rather than on a response.
    const reset = String(Math.floor((Date.now() + 30_000) / 1000));
    client
      .mockRejectedValueOnce(
        graphqlError([{ type: "RATE_LIMITED" }], null, {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": reset
        })
      )
      .mockResolvedValueOnce({ repository: { a0: { nodes: [prNode(7)] } } });

    const pending = fetchPrsForRepo("t", REPO, "o", "r", ["a"]);
    // Not the one-second exponential guess: the window said when it refills.
    await vi.advanceTimersByTimeAsync(29_000);
    expect(client).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);

    expect((await pending).get("a")).toMatchObject({ number: 7 });
    expect(client).toHaveBeenCalledTimes(2);
  });

  it("fails a spent rate limit rather than reporting no PR on every branch", async () => {
    vi.useFakeTimers();
    // The failure that matters: returning null here would map every branch in
    // the batch to "no PR", and `PrService` would negative-cache that for the
    // refresh TTL — blanking every chip in the sidebar for ten minutes.
    client.mockRejectedValue(graphqlError([{ type: "RATE_LIMITED" }]));

    const settled = fetchPrsForRepo("t", REPO, "o", "r", ["a", "b"]).catch(
      (error: unknown) => error
    );
    await vi.advanceTimersByTimeAsync(15_000);

    expect(await settled).toBeInstanceOf(GraphqlResponseError);
    expect(client).toHaveBeenCalledTimes(5);
  });

  it("fails an error that resolved nothing, rather than caching it as no PR", async () => {
    // A SAML-protected org, a query GitHub refused outright: there is no
    // partial data to salvage, and a retry would be answered the same way.
    client.mockRejectedValue(
      graphqlError([{ type: "FORBIDDEN", message: "Resource protected by SAML" }])
    );

    await expect(
      fetchPrsForRepo("t", REPO, "o", "r", ["a"])
    ).rejects.toBeInstanceOf(GraphqlResponseError);
    expect(client).toHaveBeenCalledTimes(1);
  });

  it("salvages a GraphQL-level error's partial data instead of retrying", async () => {
    // A missing repo or one bad alias answers 200 with `errors` alongside
    // whatever resolved. That is not backoff's business, and retrying it would
    // send the same query to the same answer four more times.
    client.mockRejectedValue(
      graphqlError(
        [{ type: "NOT_FOUND", message: "Could not resolve to a Repository" }],
        { repository: { a0: { nodes: [prNode(7)] } } }
      )
    );

    const result = await fetchPrsForRepo("t", REPO, "o", "r", ["a", "b"]);

    expect(result.get("a")).toMatchObject({ number: 7 });
    expect(result.get("b")).toBeNull();
    expect(client).toHaveBeenCalledTimes(1);
  });
});
