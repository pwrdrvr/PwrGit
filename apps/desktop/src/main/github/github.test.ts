import { describe, expect, it } from "vitest";
import { parseGitHubRemote } from "./remote";
import { buildPrQuery, parsePrResponse } from "./pr-query";

describe("parseGitHubRemote", () => {
  it("parses scp, https, ssh, and .git/trailing-slash variants", () => {
    const want = { owner: "pwrdrvr", repo: "PwrGit" };
    expect(parseGitHubRemote("git@github.com:pwrdrvr/PwrGit.git")).toEqual(want);
    expect(parseGitHubRemote("git@github.com:pwrdrvr/PwrGit")).toEqual(want);
    expect(parseGitHubRemote("https://github.com/pwrdrvr/PwrGit.git")).toEqual(
      want
    );
    expect(parseGitHubRemote("https://github.com/pwrdrvr/PwrGit/")).toEqual(want);
    expect(parseGitHubRemote("ssh://git@github.com/pwrdrvr/PwrGit.git")).toEqual(
      want
    );
  });

  it("returns null for non-github or unparseable remotes", () => {
    expect(parseGitHubRemote("git@gitlab.com:foo/bar.git")).toBeNull();
    expect(parseGitHubRemote("https://example.com/x/y")).toBeNull();
    expect(parseGitHubRemote("not a url")).toBeNull();
  });
});

describe("buildPrQuery", () => {
  it("passes branch names as variables (never interpolated) with aliases", () => {
    const { query, variables } = buildPrQuery("o", "r", [
      "feature/x",
      'weird"name'
    ]);
    expect(variables).toEqual({
      owner: "o",
      name: "r",
      b0: "feature/x",
      b1: 'weird"name'
    });
    expect(query).toContain("a0: pullRequests(headRefName: $b0");
    expect(query).toContain("a1: pullRequests(headRefName: $b1");
    expect(query).toContain("states: [OPEN, MERGED, CLOSED]");
    // The raw branch name must not appear in the query body.
    expect(query).not.toContain("feature/x");
  });
});

describe("parsePrResponse", () => {
  const branches = ["a", "b", "c"];
  const data = {
    repository: {
      a0: { nodes: [{ number: 12, title: "Feat", url: "u12", state: "MERGED", isDraft: false }] },
      a1: { nodes: [{ number: 34, title: null, url: "u34", state: "OPEN", isDraft: true }] },
      a2: { nodes: [] }
    }
  };

  it("maps each branch to its most-recent PR, lowercasing lifecycle", () => {
    const map = parsePrResponse(branches, data);
    expect(map.get("a")).toEqual({
      number: 12,
      url: "u12",
      title: "Feat",
      state: "merged",
      isDraft: false
    });
    expect(map.get("b")).toEqual({
      number: 34,
      url: "u34",
      title: "",
      state: "open",
      isDraft: true
    });
    expect(map.get("c")).toBeNull();
  });
});
