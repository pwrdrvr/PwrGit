import { describe, expect, it, vi } from "vitest";
import {
  GitHubContributionProvider,
  CONTRIBUTION_REPOS_QUERY,
  CONTRIBUTION_PULLS_QUERY,
  CONTRIBUTION_AUTHORED_QUERY
} from "./contribution-provider";
import type { ContributionRepo } from "@pwrgit/shared";
import { GhCliError, type runGh } from "../../github/gh-cli";

const identity = { id: "U1", login: "sample-user", host: "ghe.example.test" };
const repo: ContributionRepo = {
  id: "R1",
  path: "sample-org/widget",
  ownerId: "O1",
  owner: "sample-org",
  ownerKind: "organization",
  archived: true,
  fork: true,
  visibility: "PRIVATE"
};
const info = { hasNextPage: false, endCursor: null };
const response = (extra: Record<string, unknown>) =>
  JSON.stringify({
    data: {
      viewer: { id: "U1", login: "sample-user" },
      rateLimit: { remaining: 4000, resetAt: "2026-10-11T15:00:00Z" },
      ...extra
    }
  });
const signal = new AbortController().signal;
describe("GitHub contribution read adapter", () => {
  it.each(["cli failure", "resolved response"])(
    "identifies SAML SSO refusals in a %s without exposing partial data or private diagnostics",
    async (transport) => {
      const raw = JSON.stringify({
        data: { viewer: { pullRequests: { nodes: [null] } } },
        errors: [
          {
            type: "FORBIDDEN",
            path: ["viewer", "pullRequests", "nodes", 0],
            message:
              "Resource protected by organization SAML enforcement. You must grant your OAuth token access to private-org. private-payload ghp_secret12345678"
          }
        ]
      });
      let calls = 0;
      const provider = new GitHubContributionProvider(identity.host, async () => {
        calls++;
        if (transport === "cli failure")
          throw new GhCliError(
            "private stderr",
            "command_failed",
            raw,
            "private stderr"
          );
        return raw;
      });
      await expect(provider.authored(identity, "PAGE_3", signal)).rejects.toThrow(
        /SAML SSO.*GitHub CLI.*resume/
      );
      await expect(
        provider.authored(identity, "PAGE_3", signal)
      ).rejects.not.toThrow(/private|ghp_/);
      expect(calls).toBe(2); // Access refusals are not retried.
    }
  );
  it("distinguishes ordinary GraphQL access refusals from SSO requirements", async () => {
    const provider = new GitHubContributionProvider(identity.host, async () => {
      throw new GhCliError(
        "private stderr",
        "command_failed",
        JSON.stringify({
          errors: [{ type: "FORBIDDEN", message: "private-org access denied" }]
        }),
        "private stderr"
      );
    });
    await expect(provider.authored(identity, null, signal)).rejects.toThrow(
      /denied access.*repository permissions/
    );
    await expect(provider.authored(identity, null, signal)).rejects.not.toThrow(
      /SAML|private-org/
    );
  });
  it("still retries transient HTTP failures carrying a GraphQL error envelope", async () => {
    vi.useFakeTimers();
    try {
      const run = vi
        .fn<typeof runGh>()
        .mockRejectedValueOnce(
          new GhCliError(
            "HTTP 502",
            "command_failed",
            JSON.stringify({ errors: [{ type: "INTERNAL", message: "private" }] }),
            "HTTP 502"
          )
        )
        .mockResolvedValue(response({}));
      const result = new GitHubContributionProvider(identity.host, run).verify(
        signal
      );
      await vi.runAllTimersAsync();
      await expect(result).resolves.toEqual(identity);
      expect(run).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
  it("pins both inventory affiliation filters, includes forks/archived and uses native pagination rather than unsupported search", async () => {
    const calls: string[][] = [];
    const run: typeof runGh = async (args) => {
      calls.push(args);
      return response({
        viewer: {
          id: "U1",
          login: "sample-user",
          repositories: {
            totalCount: 2,
            nodes: [
              {
                id: "R1",
                nameWithOwner: repo.path,
                owner: {
                  id: "O1",
                  login: "sample-org",
                  __typename: "Organization"
                },
                isFork: true,
                isArchived: true,
                visibility: "PRIVATE"
              }
            ],
            pageInfo: { hasNextPage: true, endCursor: "NEXT" }
          }
        }
      });
    };
    const page = await new GitHubContributionProvider(
      identity.host,
      run
    ).repositories(identity, "CURSOR", signal);
    expect(page.nodes).toEqual([repo]);
    expect(page.cursor).toBe("NEXT");
    expect(CONTRIBUTION_REPOS_QUERY).toContain(
      "ownerAffiliations:[OWNER,ORGANIZATION_MEMBER,COLLABORATOR]"
    );
    expect(CONTRIBUTION_REPOS_QUERY).toContain(
      "affiliations:[OWNER,ORGANIZATION_MEMBER,COLLABORATOR]"
    );
    expect(calls[0]).toContain("ghe.example.test");
    expect(calls[0]).toContain("cursor=CURSOR");
    expect(CONTRIBUTION_PULLS_QUERY).not.toContain("search");
    expect(CONTRIBUTION_PULLS_QUERY).not.toContain("merged-by");
    expect(CONTRIBUTION_PULLS_QUERY).toContain("UPDATED_AT");
  });
  it("preserves stable bot IDs regardless of REST [bot] suffix, null/deleted actors and distinct authors", async () => {
    const run: typeof runGh = async () =>
      response({
        node: {
          id: "R1",
          openPullRequests: { totalCount: 0 },
          pullRequests: {
            pageInfo: info,
            nodes: [
              {
                id: "P1",
                number: 1,
                createdAt: "2026-04-01T00:00:00Z",
                closedAt: "2026-05-01T00:00:00Z",
                state: "MERGED",
                mergedAt: "2026-05-01T00:00:00Z",
                updatedAt: "2026-06-01T00:00:00Z",
                mergedBy: { id: "BOT1", login: "samplebot", __typename: "Bot" },
                author: { id: "U1", login: "sample-user" }
              },
              {
                id: "P2",
                number: 2,
                createdAt: "2026-04-01T00:00:00Z",
                closedAt: "2026-05-01T00:00:00Z",
                state: "MERGED",
                mergedAt: "2026-05-01T00:00:00Z",
                updatedAt: "2026-05-01T00:00:00Z",
                mergedBy: null,
                author: null
              }
            ]
          }
        }
      });
    const page = await new GitHubContributionProvider(identity.host, run).pulls(
      identity,
      repo,
      null,
      signal
    );
    expect(page.nodes.map((p) => p.mergedBy)).toEqual(["BOT1", null]);
    expect(page.nodes[0]?.author).toBe("U1");
    expect(page.oldestUpdatedAt).toBe("2026-05-01T00:00:00Z");
  });
  it("fails closed for switched accounts, null repositories, partial GraphQL errors and missing fields", async () => {
    for (const raw of [
      response({ viewer: { id: "U2", login: "another-user" } }),
      response({ node: null }),
      JSON.stringify({
        errors: [{ message: "private payload should never appear" }],
        data: {}
      }),
      response({
        node: {
          id: "R1",
          pullRequests: {
            nodes: [],
            pageInfo: { hasNextPage: true, endCursor: null }
          }
        }
      })
    ]) {
      const provider = new GitHubContributionProvider(
        identity.host,
        async () => raw
      );
      await expect(
        provider.pulls(identity, repo, null, signal)
      ).rejects.toThrow();
      try {
        await provider.pulls(identity, repo, null, signal);
      } catch (error) {
        expect(String(error)).not.toContain("private payload");
      }
    }
  });
  it("stops before spending the remaining rate budget", async () => {
    const provider = new GitHubContributionProvider(identity.host, async () =>
      JSON.stringify({
        data: {
          viewer: identity,
          rateLimit: { remaining: 199, resetAt: "2026-10-11T15:00:00Z" }
        }
      })
    );
    await expect(provider.verify(signal)).rejects.toMatchObject({
      retryAt: "2026-10-11T15:00:00Z"
    });
  });
  it("uses the direct lifetime authored connection and verifies the author of every node", async () => {
    const pull = {
      id: "A1",
      number: 1,
      createdAt: "2026-04-01T00:00:00Z",
      updatedAt: "2026-06-01T00:00:00Z",
      closedAt: null,
      mergedAt: null,
      mergedBy: null,
      state: "OPEN",
      author: { id: "U1" },
      repository: {
        id: "EXT",
        nameWithOwner: "demo-user/notes",
        owner: { id: "EXT_OWNER", login: "demo-user", __typename: "User" },
        isArchived: false,
        isFork: false,
        visibility: "PUBLIC"
      }
    };
    const run: typeof runGh = async () =>
      response({
        viewer: {
          id: "U1",
          login: "sample-user",
          pullRequests: { totalCount: 1, nodes: [pull], pageInfo: info }
        }
      });
    const provider = new GitHubContributionProvider(identity.host, run);
    const result = await provider.authored(identity, null, signal);
    expect(result.nodes[0]?.repo.ownerKind).toBe("user");
    expect(result.nodes[0]?.mergedAt).toBeNull();
    expect(CONTRIBUTION_AUTHORED_QUERY).toContain("CREATED_AT");
    expect(CONTRIBUTION_AUTHORED_QUERY).not.toContain("search");
    pull.author.id = "U2";
    await expect(provider.authored(identity, null, signal)).rejects.toThrow(
      "another actor"
    );
  });
  it.each([0, 54])(
    "uses filteredCount %s rather than misleading timeline totalCount 29",
    async (filteredCount) => {
      let query = "";
      const run: typeof runGh = async (args) => {
        query = args.find((arg) => arg.startsWith("query="))!;
        return response({
          p0: {
            id: "A1",
            timelineItems: {
              totalCount: 29,
              filteredCount,
              nodes: Array.from({ length: filteredCount }, (_, i) => ({
                id: `E${i}`,
                __typename: "ReopenedEvent",
                createdAt: "2026-09-02T12:00:00Z"
              })),
              pageInfo: info
            }
          }
        });
      };
      const result = await new GitHubContributionProvider(
        identity.host,
        run
      ).timelines(
        identity,
        [
          {
            id: "A1",
            repo,
            author: "U1",
            mergedBy: null,
            mergedAt: null,
            number: 1
          }
        ],
        signal
      );
      expect(result[0]?.filteredCount).toBe(filteredCount);
      expect(result[0]?.events).toHaveLength(filteredCount);
      expect(query).toContain(
        "itemTypes:[CLOSED_EVENT,REOPENED_EVENT,MERGED_EVENT]"
      );
      expect(query).not.toContain("totalCount");
      expect(query).not.toMatch(/\b(body|title|comments)\b/);
    }
  );
});
