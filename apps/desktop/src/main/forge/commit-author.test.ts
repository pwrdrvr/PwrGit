import { describe, expect, it, vi } from "vitest";
import { associatedAuthorMatches, parseGitLabGlobalId } from "./commit-author";
import { ForgeCommitAuthorIdentityTransport } from "./commit-author-transport";
import type { ForgeRepo } from "./types";

describe("parseGitLabGlobalId", () => {
  it("extracts the numeric id from a GraphQL global id", () => {
    expect(parseGitLabGlobalId("gid://gitlab/User/35145513")).toBe(35145513);
    // REST hands back a plain number for the same account.
    expect(parseGitLabGlobalId(35145513)).toBe(35145513);
  });

  it("refuses anything that is not a positive integer id", () => {
    expect(parseGitLabGlobalId("gid://gitlab/User/abc")).toBeUndefined();
    expect(parseGitLabGlobalId("")).toBeUndefined();
    expect(parseGitLabGlobalId(0)).toBeUndefined();
    expect(parseGitLabGlobalId(-1)).toBeUndefined();
    expect(parseGitLabGlobalId(null)).toBeUndefined();
    expect(parseGitLabGlobalId(1.5)).toBeUndefined();
  });
});

describe("associatedAuthorMatches", () => {
  it("accepts a handle equal to the Git author name", () => {
    expect(
      associatedAuthorMatches(
        { login: "steipete" },
        { name: "SteiPete", email: "other@example.test" }
      )
    ).toBe(true);
  });

  it("accepts a handle equal to the email local part", () => {
    expect(
      associatedAuthorMatches(
        { login: "steipete" },
        { name: "Peter Steinberger", email: "steipete@macos.shared" }
      )
    ).toBe(true);
  });

  it("refuses a handle matching neither", () => {
    expect(
      associatedAuthorMatches(
        { login: "huntharo" },
        { name: "Harold Hunt", email: "harold@pwrdrvr.com" }
      )
    ).toBe(false);
  });

  it("refuses when a field is missing or the email has no local part", () => {
    expect(associatedAuthorMatches({ login: "x" }, { name: null, email: "x@y" })).toBe(false);
    expect(associatedAuthorMatches({ login: "x" }, { name: "x", email: null })).toBe(false);
    expect(associatedAuthorMatches({ login: "x" }, { name: "n", email: "@y" })).toBe(false);
  });
});

describe("ForgeCommitAuthorIdentityTransport", () => {
  const proofFor = (kind: ForgeRepo["kind"]) => ({
    repo: { kind, host: `${kind}.com`, path: "a/b" } satisfies ForgeRepo,
    commitSha: "0123456789abcdef0123456789abcdef01234567"
  });

  it("dispatches to the transport for the repo's forge", async () => {
    const github = { fetchCommit: vi.fn(async () => ({ sha: "gh" })) };
    const gitlab = { fetchCommit: vi.fn(async () => ({ sha: "gl" })) };
    const router = new ForgeCommitAuthorIdentityTransport({ github, gitlab });

    await expect(router.fetchCommit(proofFor("github"))).resolves.toEqual({ sha: "gh" });
    await expect(router.fetchCommit(proofFor("gitlab"))).resolves.toEqual({ sha: "gl" });
    expect(github.fetchCommit).toHaveBeenCalledTimes(1);
    expect(gitlab.fetchCommit).toHaveBeenCalledTimes(1);
  });

  it("batches only through a forge transport that batches", async () => {
    const shas = ["a".repeat(40), "b".repeat(40)];
    const github = {
      fetchCommit: vi.fn(async () => ({})),
      fetchCommits: vi.fn(async () => new Map([[shas[0]!, { sha: shas[0] }]])),
      commitsPerRequest: () => 50
    };
    const gitlab = { fetchCommit: vi.fn(async (proof: { commitSha: string }) => ({ sha: proof.commitSha })) };
    const router = new ForgeCommitAuthorIdentityTransport({ github, gitlab });

    expect(router.commitsPerRequest(proofFor("github").repo)).toBe(50);
    expect(router.commitsPerRequest(proofFor("gitlab").repo)).toBe(1);
    await expect(router.fetchCommits(proofFor("github").repo, shas))
      .resolves.toEqual(new Map([[shas[0], { sha: shas[0] }]]));
    expect(github.fetchCommits).toHaveBeenCalledTimes(1);
    expect(github.fetchCommit).not.toHaveBeenCalled();
    // A single-commit forge is never batched through the router.
    await expect(router.fetchCommits(proofFor("gitlab").repo, shas)).rejects.toThrow();
    expect(gitlab.fetchCommit).not.toHaveBeenCalled();
  });
});
