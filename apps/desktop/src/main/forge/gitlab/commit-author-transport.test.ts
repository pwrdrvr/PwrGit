import { describe, expect, it } from "vitest";
import {
  GlabCliCommitAuthorIdentityTransport,
  parseAssociatedMergeRequestAuthors,
  parseGitLabCommitResponse
} from "./commit-author-transport";
import type { ForgeRepo } from "../types";

const SHA = "f8a1919458c6151576858624c6728ce536708992";
const REPO: ForgeRepo = {
  kind: "gitlab",
  host: "gitlab.com",
  path: "pwrdrvr/qa/forge/PwrGit-Test"
};

function graphql(commit: unknown): string {
  return JSON.stringify({ data: { project: { repository: { commit } } } });
}

describe("parseGitLabCommitResponse", () => {
  it("reads the linked account out of GraphQL", () => {
    expect(
      parseGitLabCommitResponse(
        JSON.parse(
          graphql({
            sha: SHA,
            authorName: "Harold Hunt",
            authorEmail: "harold@pwrdrvr.com",
            author: {
              id: "gid://gitlab/User/35145513",
              username: "huntharo",
              avatarUrl: "https://secure.gravatar.com/avatar/abc?s=80&d=identicon"
            }
          })
        )
      )
    ).toEqual({
      sha: SHA,
      author: { name: "Harold Hunt", email: "harold@pwrdrvr.com" },
      account: {
        id: 35145513,
        login: "huntharo",
        avatarUrl: "https://secure.gravatar.com/avatar/abc?s=80&d=identicon"
      }
    });
  });

  it("treats an unlinked email as an authoritative negative", () => {
    const parsed = parseGitLabCommitResponse(
      JSON.parse(
        graphql({
          sha: SHA,
          authorName: "Nobody Atall",
          authorEmail: "nobody@example.invalid",
          author: null
        })
      )
    );
    expect(parsed.account).toBeNull();
  });

  it("treats a commit GitLab cannot see as inconclusive, not a negative", () => {
    // `account` absent — nothing may be cached from this.
    expect(parseGitLabCommitResponse(JSON.parse(graphql(null)))).toEqual({});
    expect(parseGitLabCommitResponse({})).toEqual({});
    expect(parseGitLabCommitResponse(null)).toEqual({});
  });

  it("declines an account with no username", () => {
    const parsed = parseGitLabCommitResponse(
      JSON.parse(graphql({ sha: SHA, authorName: "A", authorEmail: "a@b.c", author: { id: "gid://gitlab/User/1" } }))
    );
    expect(parsed.account).toBeUndefined();
  });
});

describe("parseAssociatedMergeRequestAuthors", () => {
  it("deduplicates authors of the associated merge requests", () => {
    expect(
      parseAssociatedMergeRequestAuthors([
        { iid: 1, author: { id: 7, username: "ada", avatar_url: "https://gitlab.com/a.png" } },
        { iid: 2, author: { id: 7, username: "ada", avatar_url: "https://gitlab.com/a.png" } }
      ])
    ).toEqual([
      { id: 7, login: "ada", avatarUrl: "https://gitlab.com/a.png" }
    ]);
  });

  it("returns nothing for a non-array or authorless payload", () => {
    expect(parseAssociatedMergeRequestAuthors(null)).toEqual([]);
    expect(parseAssociatedMergeRequestAuthors([{ iid: 1 }])).toEqual([]);
  });
});

describe("GlabCliCommitAuthorIdentityTransport", () => {
  it("passes the path and SHA as GraphQL variables, never interpolated", async () => {
    const calls: string[][] = [];
    const transport = new GlabCliCommitAuthorIdentityTransport({
      run: async (args: string[]) => {
        calls.push(args);
        return graphql({
          sha: SHA,
          authorName: "Harold Hunt",
          authorEmail: "harold@pwrdrvr.com",
          author: { id: "gid://gitlab/User/1", username: "huntharo" }
        });
      }
    });

    await transport.fetchCommit({ repo: REPO, commitSha: SHA });

    const args = calls[0]!;
    expect(args.slice(0, 4)).toEqual(["api", "--hostname", "gitlab.com", "graphql"]);
    expect(args).toContain(`path=${REPO.path}`);
    expect(args).toContain(`sha=${SHA}`);
    // The query itself must not carry the values.
    const query = args.find((arg) => arg.startsWith("query="))!;
    expect(query).not.toContain(SHA);
    expect(query).not.toContain(REPO.path);
    // Credential-opaque: glab reads its own store.
    expect(args).not.toContain("token");
    expect(args).not.toContain("auth");
  });

  it("accepts a uniquely associated MR author whose username matches the commit", async () => {
    const transport = new GlabCliCommitAuthorIdentityTransport({
      run: async (args: string[]) => {
        if (args[3] === "graphql") {
          return graphql({
            sha: SHA,
            authorName: "steipete",
            authorEmail: "steipete@macos.shared",
            author: null
          });
        }
        return JSON.stringify([
          { iid: 1, author: { id: 58493, username: "steipete" } }
        ]);
      }
    });

    await expect(
      transport.fetchCommit({ repo: REPO, commitSha: SHA })
    ).resolves.toMatchObject({
      account: { id: 58493, login: "steipete" }
    });
  });

  it("refuses an MR author whose username matches neither name nor email", async () => {
    const transport = new GlabCliCommitAuthorIdentityTransport({
      run: async (args: string[]) => {
        if (args[3] === "graphql") {
          return graphql({
            sha: SHA,
            authorName: "Harold Hunt",
            authorEmail: "harold@pwrdrvr.com",
            author: null
          });
        }
        return JSON.stringify([
          { iid: 4, author: { id: 35145513, username: "huntharo" } }
        ]);
      }
    });

    // Real case from the fixture repo: `huntharo` matches neither "harold hunt"
    // nor "harold", so the weaker claim is declined rather than guessed at.
    await expect(
      transport.fetchCommit({ repo: REPO, commitSha: SHA })
    ).resolves.toMatchObject({ account: null });
  });

  it("refuses to guess when several merge requests are associated", async () => {
    const transport = new GlabCliCommitAuthorIdentityTransport({
      run: async (args: string[]) => {
        if (args[3] === "graphql") {
          return graphql({
            sha: SHA,
            authorName: "ada",
            authorEmail: "ada@example.test",
            author: null
          });
        }
        return JSON.stringify([
          { iid: 1, author: { id: 1, username: "ada" } },
          { iid: 2, author: { id: 2, username: "grace" } }
        ]);
      }
    });

    await expect(
      transport.fetchCommit({ repo: REPO, commitSha: SHA })
    ).resolves.toMatchObject({ account: null });
  });
});
