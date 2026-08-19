import { describe, expect, it } from "vitest";
import {
  classifyHost,
  githubOwnerAndName,
  parseRemoteUrl,
  resolveForgeRepo
} from "./resolve";
import { forgeOrigin } from "./types";

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

describe("host and port canonicalization", () => {
  it("drops a www. prefix, which neither CLI nor API accepts", () => {
    // `gh api --hostname www.github.com` is not a thing.
    expect(resolveForgeRepo("https://www.github.com/pwrdrvr/PwrGit.git")).toEqual({
      kind: "github",
      host: "github.com",
      path: "pwrdrvr/PwrGit"
    });
    expect(resolveForgeRepo("https://www.gitlab.com/g/p.git")?.host).toBe("gitlab.com");
  });

  it("keeps a non-default web port so a self-managed API is reachable", () => {
    expect(resolveForgeRepo("https://gitlab.corp.example:8443/g/p.git")).toEqual({
      kind: "gitlab",
      host: "gitlab.corp.example",
      port: 8443,
      path: "g/p"
    });
  });

  it("ignores an ssh port, which says nothing about where https lives", () => {
    expect(
      resolveForgeRepo("ssh://git@gitlab.corp.example:2222/g/p.git")
    ).toEqual({
      kind: "gitlab",
      host: "gitlab.corp.example",
      path: "g/p"
    });
  });

  it("does not carry 443, which https already implies", () => {
    expect(
      resolveForgeRepo("https://gitlab.corp.example:443/g/p.git")?.port
    ).toBeUndefined();
  });
});

describe("forgeOrigin", () => {
  it("adds the port only when there is one", () => {
    expect(forgeOrigin({ host: "gitlab.com" })).toBe("https://gitlab.com");
    expect(forgeOrigin({ host: "gitlab.corp.example", port: 8443 })).toBe(
      "https://gitlab.corp.example:8443"
    );
  });
});
