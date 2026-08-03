import { describe, expect, it } from "vitest";
import {
  buildCommitPrQuery,
  buildPrNumberQuery,
  parseCommitPrResponse,
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
