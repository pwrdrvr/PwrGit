import { describe, expect, it } from "vitest";
import {
  classifyHost,
  githubOwnerAndName,
  parseRemoteUrl,
  resolveForgeRepo
} from "./resolve";

describe("parseRemoteUrl", () => {
  it("keeps every path segment so nested GitLab groups survive", () => {
    expect(parseRemoteUrl("git@gitlab.com:pwrdrvr/qa/forge/PwrGit-Test.git"))
      .toEqual({ host: "gitlab.com", path: "pwrdrvr/qa/forge/PwrGit-Test" });
    expect(parseRemoteUrl("https://gitlab.com/pwrdrvr/qa/forge/PwrGit-Test"))
      .toEqual({ host: "gitlab.com", path: "pwrdrvr/qa/forge/PwrGit-Test" });
  });

  it("handles scp, url, user, port, and .git variations", () => {
    expect(parseRemoteUrl("git@github.com:pwrdrvr/PwrGit.git"))
      .toEqual({ host: "github.com", path: "pwrdrvr/PwrGit" });
    expect(parseRemoteUrl("ssh://git@gitlab.example.com:2222/g/p.git"))
      .toEqual({ host: "gitlab.example.com", path: "g/p" });
    expect(parseRemoteUrl("https://GitHub.com/pwrdrvr/PwrGit/"))
      .toEqual({ host: "github.com", path: "pwrdrvr/PwrGit" });
    expect(parseRemoteUrl("  git://github.com/pwrdrvr/PwrGit.git  "))
      .toEqual({ host: "github.com", path: "pwrdrvr/PwrGit" });
  });

  it("rejects junk, empty paths, and GitLab's /-/ route separator", () => {
    expect(parseRemoteUrl("")).toBeNull();
    expect(parseRemoteUrl("not a url")).toBeNull();
    expect(parseRemoteUrl("https://gitlab.com/")).toBeNull();
    expect(parseRemoteUrl("https://gitlab.com/g/-/p")).toBeNull();
    expect(parseRemoteUrl("https://gitlab.com/g//p")).toBeNull();
  });
});

describe("classifyHost", () => {
  it("recognizes the SaaS hosts and the gitlab.* self-managed convention", () => {
    expect(classifyHost("github.com")).toBe("github");
    expect(classifyHost("GitLab.com")).toBe("gitlab");
    expect(classifyHost("gitlab.example.internal")).toBe("gitlab");
  });

  it("returns null for hosts it cannot know, unless overridden", () => {
    expect(classifyHost("git.example.com")).toBeNull();
    expect(classifyHost("bitbucket.org")).toBeNull();
    expect(classifyHost("git.example.com", { "git.example.com": "gitlab" }))
      .toBe("gitlab");
    // An override also wins over the built-in guess.
    expect(classifyHost("gitlab.corp.com", { "gitlab.corp.com": "github" }))
      .toBe("github");
  });
});

describe("resolveForgeRepo", () => {
  it("resolves GitHub only at exactly owner/repo", () => {
    expect(resolveForgeRepo("git@github.com:pwrdrvr/PwrGit.git")).toEqual({
      kind: "github",
      host: "github.com",
      path: "pwrdrvr/PwrGit"
    });
    expect(resolveForgeRepo("https://github.com/pwrdrvr/PwrGit/tree/main"))
      .toBeNull();
  });

  it("resolves GitLab at any group depth", () => {
    expect(resolveForgeRepo("git@gitlab.com:pwrdrvr/PwrGit.git")).toEqual({
      kind: "gitlab",
      host: "gitlab.com",
      path: "pwrdrvr/PwrGit"
    });
    expect(resolveForgeRepo("git@gitlab.com:pwrdrvr/qa/forge/PwrGit-Test.git"))
      .toEqual({
        kind: "gitlab",
        host: "gitlab.com",
        path: "pwrdrvr/qa/forge/PwrGit-Test"
      });
  });

  it("no-ops for unknown hosts, matching today's behavior", () => {
    expect(resolveForgeRepo("git@bitbucket.org:team/repo.git")).toBeNull();
    expect(resolveForgeRepo("https://example.com/x/y")).toBeNull();
  });
});

describe("githubOwnerAndName", () => {
  it("splits a GitHub path back into GraphQL arguments", () => {
    expect(
      githubOwnerAndName({ kind: "github", host: "github.com", path: "a/b" })
    ).toEqual({ owner: "a", name: "b" });
  });
});
