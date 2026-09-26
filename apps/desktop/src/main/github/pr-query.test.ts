import { describe, expect, it } from "vitest";
import {
  buildPrQuery,
  parsePrResponse,
  buildCommitPrQuery,
  buildOpenPrQuery,
  buildPrNumberQuery,
  parseCommitPrResponse,
  parseOpenPrPage,
  parsePrNumberResponse
} from "./pr-query";

describe("commit PR GraphQL query", () => {
  it("uses variables for exact commit SHAs in one aliased request", () => {
    const hashes = [
      "0123456789abcdef0123456789abcdef01234567",
      "fedcba9876543210fedcba9876543210fedcba98"
    ];
    const built = buildCommitPrQuery("pwrdrvr", "PwrGit", hashes);

    expect(built.variables).toEqual({
      owner: "pwrdrvr",
      name: "PwrGit",
      c0: hashes[0],
      c1: hashes[1]
    });
    expect(built.query).toContain("c0: object(oid: $c0)");
    expect(built.query).toContain("c1: object(oid: $c1)");
    expect(built.query).toContain("associatedPullRequests(first: 10)");
    expect(built.query).not.toContain(hashes[0]);
    expect(built.query).toContain("repository { nameWithOwner }");
  });

  it("retains an upstream PR's repository when looking up a commit through a fork", () => {
    const parsed = parseCommitPrResponse(["inherited-commit"], {
      repository: { c0: { associatedPullRequests: { nodes: [{
        number: 3,
        title: "Original upstream feature",
        url: "https://github.com/upstream/project/pull/3",
        repository: { nameWithOwner: "upstream/project" },
        state: "MERGED",
        isDraft: false
      }] } } }
    });
    expect(parsed.get("inherited-commit")).toMatchObject({
      number: 3, repoPath: "upstream/project",
      url: "https://github.com/upstream/project/pull/3"
    });
  });

  it("prefers an open associated PR, then the newest terminal PR", () => {
    const hashes = ["first", "second", "none"];
    const parsed = parseCommitPrResponse(hashes, {
      repository: {
        c0: {
          associatedPullRequests: {
            nodes: [
              {
                number: 90,
                title: "Older merged association",
                url: "https://example.test/90",
                state: "MERGED",
                isDraft: false
              },
              {
                number: 80,
                title: "Current open association",
                url: "https://example.test/80",
                state: "OPEN",
                isDraft: true
              }
            ]
          }
        },
        c1: {
          associatedPullRequests: {
            nodes: [
              {
                number: 10,
                title: "Closed",
                url: "https://example.test/10",
                state: "CLOSED",
                isDraft: false
              },
              {
                number: 11,
                title: "Merged",
                url: "https://example.test/11",
                state: "MERGED",
                isDraft: false
              }
            ]
          }
        }
      }
    });

    expect(parsed.get("first")).toMatchObject({ number: 80, state: "open" });
    expect(parsed.get("second")).toMatchObject({ number: 11, state: "merged" });
    expect(parsed.get("none")).toBeNull();
  });
});

describe("PR-number status query", () => {
  it("deduplicates status transport around exact PR numbers", () => {
    const built = buildPrNumberQuery("pwrdrvr", "PwrGit", [29, 30]);
    expect(built.variables).toEqual({
      owner: "pwrdrvr",
      name: "PwrGit",
      n0: 29,
      n1: 30
    });
    expect(built.query).toContain("n0: pullRequest(number: $n0)");
    expect(parsePrNumberResponse([29, 30], {
      repository: {
        n0: {
          number: 29,
          title: "Merged feature",
          url: "https://example.test/29",
          state: "MERGED",
          isDraft: false
        },
        n1: null
      }
    })).toEqual(new Map([
      [29, {
        number: 29,
        title: "Merged feature",
        url: "https://example.test/29",
        state: "merged",
        isDraft: false
      }],
      [30, null]
    ]));
  });
});


describe("check rollups", () => {
  it.each([
    ["SUCCESS", [], [], "passing", false],
    ["PENDING", [{ state: "FAILURE", count: 1 }, { state: "IN_PROGRESS", count: 150 }], [], "failing", true],
    ["FAILURE", [{ state: "FAILURE", count: 1 }], [{ state: "PENDING", count: 1 }], "failing", true],
    ["FAILURE", [{ state: "TIMED_OUT", count: 1 }], [], "failing", false],
    ["PENDING", [{ state: "QUEUED", count: 1 }, { state: "FAILURE", count: 0 }], [], "pending", true],
    ["ERROR", [], [], "failing", false]
  ])("normalizes %s and counts across every read path", (state, runs, contexts, checkState, checksStillRunning) => {
    const node = {
      number: 29, title: "Fixture", url: "https://example.test/29", state: "OPEN", isDraft: true,
      mergeable: "CONFLICTING",
      commits: { totalCount: 3, nodes: [{ commit: { statusCheckRollup: {
        state, contexts: { checkRunCountsByState: runs, statusContextCountsByState: contexts }
      } } }] }
    };
    for (const summary of [
      parsePrResponse(["feature"], { repository: { a0: { nodes: [node] } } }).get("feature"),
      parseCommitPrResponse(["sha"], { repository: { c0: { associatedPullRequests: { nodes: [node] } } } }).get("sha"),
      parsePrNumberResponse([29], { repository: { n0: node } }).get(29)
    ]) expect(summary).toMatchObject({ checkState, checksStillRunning, mergeState: "conflicting", commitCount: 3 });
    for (const { query } of [buildPrQuery("o", "r", ["b"]), buildCommitPrQuery("o", "r", ["s"]), buildPrNumberQuery("o", "r", [29])]) {
      expect(query).toContain("checkRunCountsByState");
      expect(query).toContain("mergeable");
      expect(query).toContain("commits(last: 1)");
    }
  });
  it("does not call a missing rollup passing", () => {
    expect(parsePrNumberResponse([1], { repository: { n0: {
      number: 1, state: "OPEN", commits: { nodes: [{ commit: { statusCheckRollup: null } }] }
    } } }).get(1)).toMatchObject({ checkState: "unknown", checksStillRunning: false });
  });
});

describe("open pull request list", () => {
  const node = (number: number, extra: Record<string, unknown> = {}) => ({
    number,
    title: `PR ${number}`,
    url: `https://github.com/octo/orbit/pull/${number}`,
    state: "OPEN",
    isDraft: false,
    headRefName: "feature",
    ...extra
  });

  it("binds a cursor only once there is one", () => {
    expect(buildOpenPrQuery("octo", "orbit", null).variables).toEqual({
      owner: "octo",
      name: "orbit",
      first: 50
    });
    const next = buildOpenPrQuery("octo", "orbit", "Y3Vyc29y");
    expect(next.variables).toMatchObject({ after: "Y3Vyc29y" });
    expect(next.query).toContain("states: [OPEN]");
    expect(next.query).toContain("orderBy: { field: UPDATED_AT, direction: DESC }");
  });

  it("reads author, update time and a fork's head repository", () => {
    const page = parseOpenPrPage({
      repository: {
        pullRequests: {
          nodes: [
            node(106, {
              author: { login: "octocat" },
              updatedAt: "2026-09-01T00:00:00Z",
              isCrossRepository: false,
              headRepository: { nameWithOwner: "octo/orbit" }
            }),
            null,
            node(121, {
              isDraft: true,
              isCrossRepository: true,
              headRepository: { nameWithOwner: "octo-contrib/orbit" }
            }),
            // A fork since deleted is still a fork.
            node(122, { isCrossRepository: true, headRepository: null })
          ],
          pageInfo: { hasNextPage: true, endCursor: "next" }
        }
      }
    });
    expect(page.hasNextPage).toBe(true);
    expect(page.endCursor).toBe("next");
    expect(page.items.map((item) => item.number)).toEqual([106, 121, 122]);
    expect(page.items[0]).toMatchObject({
      author: "octocat",
      updatedAt: Date.parse("2026-09-01T00:00:00Z")
    });
    expect(page.items[0]?.headRepoPath).toBeUndefined();
    expect(page.items[1]).toMatchObject({ isDraft: true, headRepoPath: "octo-contrib/orbit" });
    expect(page.items[2]?.headRepoPath).toBe("(fork unavailable)");
  });

  it("says whether a PR found by number came from a fork", () => {
    expect(buildPrNumberQuery("octo", "orbit", [98]).query).toContain(
      "isCrossRepository headRepository { nameWithOwner }"
    );
    const found = parsePrNumberResponse([97, 98], {
      repository: {
        n0: node(97, {
          state: "MERGED",
          headRefName: "main",
          isCrossRepository: true,
          headRepository: { nameWithOwner: "someone/orbit" }
        }),
        n1: node(98, { state: "MERGED", isCrossRepository: false })
      }
    });
    expect(found.get(97)).toMatchObject({ headRepoPath: "someone/orbit" });
    expect(found.get(98)).not.toHaveProperty("headRepoPath");
  });
});
