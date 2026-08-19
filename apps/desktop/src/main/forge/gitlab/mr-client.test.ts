import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchMrsByNumbers,
  fetchMrsForBranches,
  fetchMrsForCommits
} from "./mr-client";
import type { ForgeRepo } from "../types";

const REPO: ForgeRepo = {
  kind: "gitlab",
  host: "gitlab.com",
  path: "pwrdrvr/qa/forge/PwrGit-Test"
};

type Mr = {
  iid: string;
  state?: string;
  draft?: boolean;
  sourceBranch?: string;
};

function mr({ iid, state = "opened", draft = false, sourceBranch }: Mr): unknown {
  return {
    iid,
    title: `MR ${iid}`,
    webUrl: `https://gitlab.com/${REPO.path}/-/merge_requests/${iid}`,
    state,
    draft,
    sourceBranch
  };
}

function graphqlPage(nodes: unknown[], hasNextPage = false, endCursor = "C"): unknown {
  return {
    data: { project: { mergeRequests: { nodes, pageInfo: { endCursor, hasNextPage } } } }
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => body
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("fetchMrsForBranches", () => {
  it("costs one request when every branch matches on the first page", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        graphqlPage(
          [
            mr({ iid: "1", sourceBranch: "feat-open" }),
            mr({ iid: "4", state: "merged", sourceBranch: "feat-merged" })
          ],
          true
        )
      )
    );

    const result = await fetchMrsForBranches("t", REPO, [
      "feat-open",
      "feat-merged"
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.get("feat-open")).toMatchObject({ number: 1, state: "open" });
    expect(result.get("feat-merged")).toMatchObject({ state: "merged" });
  });

  it("pages on until the last branch is found", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(graphqlPage([mr({ iid: "9", sourceBranch: "a" })], true, "C1"))
      )
      .mockResolvedValueOnce(
        jsonResponse(graphqlPage([mr({ iid: "2", sourceBranch: "b" })], true, "C2"))
      );

    const result = await fetchMrsForBranches("t", REPO, ["a", "b"]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondCall = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(secondCall.variables.after).toBe("C1");
    expect(result.get("b")).toMatchObject({ number: 2 });
  });

  it("negative-caches a branch with no MR once paging ends", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(graphqlPage([mr({ iid: "1", sourceBranch: "a" })], false))
    );

    const result = await fetchMrsForBranches("t", REPO, ["a", "no-mr"]);

    // The key must be present and null — omitting it would make the service
    // re-fetch this branch forever instead of remembering there is no MR.
    expect(result.has("no-mr")).toBe(true);
    expect(result.get("no-mr")).toBeNull();
  });

  it("upgrades to the live MR when a later page reveals it", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(
          graphqlPage([mr({ iid: "9", state: "closed", sourceBranch: "a" })], true, "C1")
        )
      )
      .mockResolvedValueOnce(
        jsonResponse(
          graphqlPage([mr({ iid: "2", state: "opened", sourceBranch: "a" })], false)
        )
      );

    const result = await fetchMrsForBranches("t", REPO, ["a", "b"]);

    expect(result.get("a")).toMatchObject({ number: 2, state: "open" });
  });

  it("gives up after the page cap rather than walking all history", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(graphqlPage([mr({ iid: "1", sourceBranch: "a" })], true, "C"))
    );

    const result = await fetchMrsForBranches("t", REPO, ["a", "never"]);

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(result.get("never")).toBeNull();
  });
});

describe("fetchMrsByNumbers", () => {
  it("returns null for an iid GitLab did not return", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(graphqlPage([mr({ iid: "4", state: "merged" })]))
    );

    const result = await fetchMrsByNumbers("t", REPO, [4, 999]);

    expect(result.get(4)).toMatchObject({ number: 4, state: "merged" });
    expect(result.get(999)).toBeNull();
  });
});

describe("fetchMrsForCommits", () => {
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  const OTHER = "fedcba9876543210fedcba9876543210fedcba98";

  it("caches an answered lookup with no association as null", async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));

    const result = await fetchMrsForCommits("t", REPO, [SHA]);

    expect(result.get(SHA)).toBeNull();
  });

  it("omits a failed lookup so a network blip is not cached as 'no MR'", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(jsonResponse([{ iid: 4, state: "merged", webUrl: "u", title: "t", draft: false }]))
      .mockRejectedValue(new TypeError("network down"));

    const pending = fetchMrsForCommits("t", REPO, [SHA, OTHER]);
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await pending;

    expect(result.get(SHA)).toMatchObject({ number: 4 });
    expect(result.has(OTHER)).toBe(false);
    // One retry, not the branch query's four — see COMMIT_MAX_RETRIES.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("encodes the nested project path into the REST route", async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));

    await fetchMrsForCommits("t", REPO, [SHA]);

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `https://gitlab.com/api/v4/projects/${encodeURIComponent(REPO.path)}/repository/commits/${SHA}/merge_requests`
    );
  });

  it("caps how many commits one refresh may cost", async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    const many = Array.from({ length: 100 }, (_, i) =>
      i.toString(16).padStart(40, "0")
    );

    const result = await fetchMrsForCommits("t", REPO, many);

    // One request per commit, unlike GitHub's batched 50-per-request.
    expect(fetchMock).toHaveBeenCalledTimes(60);
    expect(result.size).toBe(60);
  });
});

describe("backoff", () => {
  it("does not retry a 404", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: "not found" }, 404));

    await expect(fetchMrsForBranches("t", REPO, ["a"])).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a 500 and succeeds", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, 500))
      .mockResolvedValueOnce(
        jsonResponse(graphqlPage([mr({ iid: "1", sourceBranch: "a" })]))
      );

    const pending = fetchMrsForBranches("t", REPO, ["a"]);
    await vi.advanceTimersByTimeAsync(2_000);

    expect((await pending).get("a")).toMatchObject({ number: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
