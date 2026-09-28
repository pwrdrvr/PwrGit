import { describe, expect, it, vi } from "vitest";
import { providerFor, resolveForge } from "./providers";
import { connectForge, stampForge, toPrLifecycle, withNullsForMissing } from "./types";

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
  it("exposes all providers under the ForgeProvider contract", () => {
    for (const kind of ["github", "gitlab", "gitcafe", "gerrit"] as const) {
      const provider = providerFor(kind);
      expect(provider.kind).toBe(kind);
      if (provider.authentication !== "cli" && provider.authentication !== "public") expect(typeof provider.getToken).toBe("function");
      expect(typeof provider.fetchPrsForBranches).toBe("function");
      expect(typeof provider.fetchPrsForCommits).toBe("function");
      expect(typeof provider.fetchPrsByNumbers).toBe("function");
      expect(typeof provider.fetchOpenPrs).toBe("function");
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

  it("preserves the repository returned for an inherited commit association", () => {
    const stamped = stampForge(new Map([["sha", {
      number: 3, title: "Upstream feature", state: "merged" as const,
      isDraft: false, url: "https://github.com/upstream/project/pull/3",
      repoPath: "upstream/project"
    }]]), { kind: "github", host: "github.com", path: "fork/project" });
    expect(stamped.get("sha")).toMatchObject({
      forge: "github", host: "github.com", repoPath: "upstream/project"
    });
  });

  it("leaves a negative result null so it still negative-caches", () => {
    const stamped = stampForge(new Map([["b", null]]), repo);
    expect(stamped.has("b")).toBe(true);
    expect(stamped.get("b")).toBeNull();
  });
});


it("queries the project below the configured Gerrit HTTP deployment", async () => {
  const resolved = resolveForge("https://review.example/r/project.git", { "review.example": "gerrit" }, () => "https://review.example/r");
  expect(resolved).not.toBeNull();
  const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(")]}'\n[]"));
  try {
    const connection = await connectForge(resolved!.provider, resolved!.repo.host);
    await connection!.fetchOpenPrs(resolved!.repo);
    const url = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(url.origin + url.pathname).toBe("https://review.example/r/changes/");
    expect(url.searchParams.get("q")).toBe('project:"project" status:open');
  } finally { fetcher.mockRestore(); }
});
