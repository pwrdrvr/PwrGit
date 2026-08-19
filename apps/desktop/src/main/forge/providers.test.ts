import { describe, expect, it } from "vitest";
import { providerFor, resolveForge } from "./providers";
import { stampForge, toPrLifecycle, withNullsForMissing } from "./types";

describe("resolveForge", () => {
  it("routes a GitHub origin to the GitHub provider", () => {
    const resolved = resolveForge("git@github.com:pwrdrvr/PwrGit.git");
    expect(resolved?.provider.kind).toBe("github");
    expect(resolved?.repo).toEqual({
      kind: "github",
      host: "github.com",
      path: "pwrdrvr/PwrGit"
    });
  });

  it("routes a nested GitLab origin to the GitLab provider", () => {
    const resolved = resolveForge(
      "git@gitlab.com:pwrdrvr/qa/forge/PwrGit-Test.git"
    );
    expect(resolved?.provider.kind).toBe("gitlab");
    expect(resolved?.repo.path).toBe("pwrdrvr/qa/forge/PwrGit-Test");
  });

  it("honors a host override for a self-managed instance", () => {
    expect(resolveForge("git@git.corp.example:g/p.git")).toBeNull();
    expect(
      resolveForge("git@git.corp.example:g/p.git", {
        "git.corp.example": "gitlab"
      })?.provider.kind
    ).toBe("gitlab");
  });

  it("returns null for an unrecognized host, so the feature no-ops", () => {
    expect(resolveForge("git@bitbucket.org:team/repo.git")).toBeNull();
    expect(resolveForge("")).toBeNull();
  });
});

describe("providerFor", () => {
  it("exposes both providers under the ForgeProvider contract", () => {
    for (const kind of ["github", "gitlab"] as const) {
      const provider = providerFor(kind);
      expect(provider.kind).toBe(kind);
      expect(typeof provider.getToken).toBe("function");
      expect(typeof provider.fetchPrsForBranches).toBe("function");
      expect(typeof provider.fetchPrsForCommits).toBe("function");
      expect(typeof provider.fetchPrsByNumbers).toBe("function");
    }
  });
});

describe("toPrLifecycle", () => {
  it("normalizes both forges' vocabularies", () => {
    expect(toPrLifecycle("MERGED")).toBe("merged");
    expect(toPrLifecycle("merged")).toBe("merged");
    expect(toPrLifecycle("CLOSED")).toBe("closed");
    expect(toPrLifecycle("closed")).toBe("closed");
    expect(toPrLifecycle("OPEN")).toBe("open");
    expect(toPrLifecycle("opened")).toBe("open");
    // GitLab-only state: still live, so it must not read as terminal.
    expect(toPrLifecycle("locked")).toBe("open");
    expect(toPrLifecycle("something-new")).toBe("open");
  });
});

describe("withNullsForMissing", () => {
  it("fills every requested key so absences negative-cache", () => {
    const found = new Map([
      ["a", { number: 1, url: "u", title: "t", state: "open" as const, isDraft: false }]
    ]);
    const filled = withNullsForMissing(["a", "b"], found);
    expect(filled.get("a")?.number).toBe(1);
    expect(filled.has("b")).toBe(true);
    expect(filled.get("b")).toBeNull();
  });
});

describe("stampForge", () => {
  const repo = {
    kind: "gitlab" as const,
    host: "gitlab.com",
    path: "pwrdrvr/qa/forge/PwrGit-Test"
  };

  it("attaches the identity that makes a number unambiguous", () => {
    const stamped = stampForge(
      new Map([
        [
          "b",
          {
            number: 4,
            url: "u",
            title: "t",
            state: "merged" as const,
            isDraft: false
          }
        ]
      ]),
      repo
    );
    expect(stamped.get("b")).toMatchObject({
      number: 4,
      forge: "gitlab",
      host: "gitlab.com",
      repoPath: "pwrdrvr/qa/forge/PwrGit-Test"
    });
  });

  it("leaves a negative result null so it still negative-caches", () => {
    const stamped = stampForge(new Map([["b", null]]), repo);
    expect(stamped.has("b")).toBe(true);
    expect(stamped.get("b")).toBeNull();
  });
});
