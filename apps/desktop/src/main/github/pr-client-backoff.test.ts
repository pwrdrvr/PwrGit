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

  it("salvages a GraphQL-level error's partial data instead of retrying", async () => {
    // A missing repo or one bad alias answers 200 with `errors` alongside
    // whatever resolved. That is not backoff's business, and retrying it would
    // send the same query to the same answer four more times.
    client.mockRejectedValue(
      new GraphqlResponseError(
        { method: "POST", url: "/graphql" } as never,
        {},
        {
          data: { repository: { a0: { nodes: [prNode(7)] } } },
          errors: [{ message: "Could not resolve to a Repository" }] as never
        }
      )
    );

    const result = await fetchPrsForRepo("t", REPO, "o", "r", ["a", "b"]);

    expect(result.get("a")).toMatchObject({ number: 7 });
    expect(result.get("b")).toBeNull();
    expect(client).toHaveBeenCalledTimes(1);
  });
});
