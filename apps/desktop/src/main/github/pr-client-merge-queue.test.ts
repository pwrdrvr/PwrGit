import { beforeEach, describe, expect, it, vi } from "vitest";

/** The Octokit client `runQuery` builds with `graphql.defaults(...)`. */
const { client } = vi.hoisted(() => ({ client: vi.fn() }));

vi.mock("@octokit/graphql", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@octokit/graphql")>();
  return { ...actual, graphql: { defaults: () => client } };
});

import { GraphqlResponseError } from "@octokit/graphql";
import {
  enqueuePullRequest,
  EnqueueRefusedError,
  fetchPrsByNumbers,
  refusedMergeQueueFields,
  resetMergeQueueFieldSupport
} from "./pr-client";

const GHES = { host: "ghe.example.com" };
const DOTCOM = { host: "github.com" };

/** What GHES 3.7 answers for a field it does not have: no data at all. */
function undefinedField(field: string): Error {
  return new GraphqlResponseError(
    { method: "POST", url: "/graphql" } as never,
    {},
    {
      data: undefined,
      errors: [{
        message: `Field '${field}' doesn't exist on type 'PullRequest'`,
        extensions: { code: "undefinedField", typeName: "PullRequest", fieldName: field }
      }] as never
    }
  );
}

const node = { number: 3, title: "t", url: "u", state: "OPEN", isDraft: false };

beforeEach(() => {
  client.mockReset();
  resetMergeQueueFieldSupport();
});

describe("merge-queue fields on an older GitHub Enterprise", () => {
  it("asks again without them, and only them, after a schema refusal", async () => {
    client
      .mockRejectedValueOnce(undefinedField("isMergeQueueEnabled"))
      .mockResolvedValueOnce({ repository: { n0: node } });
    const prs = await fetchPrsByNumbers("t", GHES, "o", "r", [3]);
    expect(prs.get(3)).toMatchObject({ number: 3, state: "open" });
    // Without the fields there is no queue answer, which is "not known".
    expect(prs.get(3)?.mergeQueue).toBeUndefined();
    expect(client.mock.calls[0]?.[0]).toContain("isMergeQueueEnabled");
    expect(client.mock.calls[1]?.[0]).not.toContain("MergeQueue");
    expect(client.mock.calls[1]?.[0]).toContain("statusCheckRollup");
  });

  it("remembers the refusal per host, so the next query is not refused first", async () => {
    client
      .mockRejectedValueOnce(undefinedField("mergeQueueEntry"))
      .mockResolvedValue({ repository: { n0: node } });
    await fetchPrsByNumbers("t", GHES, "o", "r", [3]);
    await fetchPrsByNumbers("t", GHES, "o", "r", [3]);
    expect(client).toHaveBeenCalledTimes(3);
    expect(client.mock.calls[2]?.[0]).not.toContain("mergeQueueEntry");
    // Another instance's age says nothing about github.com.
    await fetchPrsByNumbers("t", DOTCOM, "o", "r", [3]);
    expect(client.mock.calls[3]?.[0]).toContain("mergeQueueEntry");
  });

  it("does not treat a refused repository as missing queue fields", () => {
    const refusal = new GraphqlResponseError(
      { method: "POST", url: "/graphql" } as never,
      {},
      { data: { repository: null }, errors: [{ type: "FORBIDDEN", message: "SAML" }] as never }
    );
    expect(refusedMergeQueueFields(refusal)).toBe(false);
    expect(refusedMergeQueueFields(undefinedField("isInMergeQueue"))).toBe(true);
    expect(refusedMergeQueueFields(undefinedField("totallyUnrelated"))).toBe(false);
  });
});

describe("enqueuePullRequest", () => {
  const read = (pr: Record<string, unknown>) => ({ repository: { pullRequest: pr } });
  const ready = { id: "PR_1", state: "OPEN", headRefOid: "a".repeat(40), isMergeQueueEnabled: true, isInMergeQueue: false };

  it("never merges a PR whose base has no merge queue", async () => {
    client.mockResolvedValueOnce(read({ ...ready, isMergeQueueEnabled: false }));
    await expect(enqueuePullRequest("t", DOTCOM, "o", "r", 1)).rejects.toMatchObject({
      code: "no_merge_queue"
    });
    // Only the read went out: no mutation of any kind.
    expect(client).toHaveBeenCalledTimes(1);
  });

  it("refuses when the head moved since the user looked", async () => {
    client.mockResolvedValueOnce(read(ready));
    await expect(enqueuePullRequest("t", DOTCOM, "o", "r", 1, "b".repeat(40)))
      .rejects.toBeInstanceOf(EnqueueRefusedError);
    expect(client).toHaveBeenCalledTimes(1);
  });

  it("enqueues with the expected head, and only through enqueuePullRequest", async () => {
    client
      .mockResolvedValueOnce(read(ready))
      .mockResolvedValueOnce({ enqueuePullRequest: { mergeQueueEntry: { position: 3, state: "QUEUED" } } });
    await expect(enqueuePullRequest("t", DOTCOM, "o", "r", 1, "a".repeat(40)))
      .resolves.toEqual({ position: 3, state: "QUEUED" });
    const mutation = String(client.mock.calls[1]?.[0]);
    expect(mutation).toContain("enqueuePullRequest");
    expect(mutation).not.toMatch(/mergePullRequest/);
    expect(client.mock.calls[1]?.[1]).toEqual({ id: "PR_1", head: "a".repeat(40) });
  });
});
