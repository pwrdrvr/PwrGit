import { describe, expect, it, vi } from "vitest";
import {
  GitHubRepoProvider,
  parseGhLogin,
  parseGhOrgLogins,
  parseGhRepoList,
  parseGhRestRepo,
  REPO_JSON_FIELDS
} from "./repo-provider";

describe("parseGhRepoList", () => {
  it("reads visibility and fork lineage from `gh repo list --json`", () => {
    expect(
      parseGhRepoList(
        JSON.stringify([
          {
            name: "react",
            nameWithOwner: "huntharo/react",
            description: "UI library",
            // gh reports the enum uppercased here and lowercased elsewhere.
            visibility: "PUBLIC",
            isFork: true,
            parent: { name: "react", owner: { login: "facebook" } },
            sshUrl: "git@github.com:huntharo/react.git",
            url: "https://github.com/huntharo/react",
            updatedAt: "2026-08-01T12:00:00Z"
          }
        ])
      )
    ).toEqual([
      {
        name: "react",
        owner: "huntharo",
        nameWithOwner: "huntharo/react",
        description: "UI library",
        visibility: "public",
        host: "github",
        hostname: "github.com",
        parent: {
          nameWithOwner: "facebook/react",
          url: "https://github.com/facebook/react"
        },
        sshUrl: "git@github.com:huntharo/react.git",
        httpsUrl: "https://github.com/huntharo/react",
        updatedAt: "2026-08-01T12:00:00Z",
        localPaths: []
      }
    ]);
  });

  it("reads GitHub Enterprise's internal tier", () => {
    expect(
      parseGhRepoList(
        JSON.stringify([
          { nameWithOwner: "acme/api", visibility: "INTERNAL" }
        ])
      )[0]?.visibility
    ).toBe("internal");
  });

  it("reports a missing or unrecognized visibility as unknown", () => {
    expect(
      parseGhRepoList(JSON.stringify([{ nameWithOwner: "acme/api" }]))[0]
        ?.visibility
    ).toBe("unknown");
  });

  it("survives a fork whose parent it cannot see", () => {
    // `isFork` with no `parent` is a deleted or invisible original — still a
    // fork, with an unnameable origin.
    const parsed = parseGhRepoList(
      JSON.stringify([
        { nameWithOwner: "acme/api", visibility: "PUBLIC", isFork: true }
      ])
    )[0];
    expect(parsed?.parent).toBeUndefined();
  });

  it("drops rows with no nameWithOwner, and survives bad JSON shapes", () => {
    expect(parseGhRepoList(JSON.stringify([{ name: "x" }]))).toEqual([]);
    expect(parseGhRepoList("null")).toEqual([]);
  });
});

describe("parseGhRestRepo", () => {
  const REST = {
    full_name: "huntharo/react",
    name: "react",
    description: "UI library",
    visibility: "public",
    private: false,
    fork: true,
    parent: {
      full_name: "gaearon/react",
      html_url: "https://github.com/gaearon/react"
    },
    source: {
      full_name: "facebook/react",
      html_url: "https://github.com/facebook/react"
    },
    ssh_url: "git@github.com:huntharo/react.git",
    html_url: "https://github.com/huntharo/react",
    updated_at: "2026-08-04T12:00:00Z"
  };

  it("reads both the parent and the fork-network root", () => {
    const parsed = parseGhRestRepo(JSON.stringify(REST));
    expect(parsed?.parent?.nameWithOwner).toBe("gaearon/react");
    expect(parsed?.root?.nameWithOwner).toBe("facebook/react");
  });

  it("omits root when it merely repeats the parent", () => {
    const parsed = parseGhRestRepo(
      JSON.stringify({
        ...REST,
        parent: { full_name: "facebook/react" },
        source: { full_name: "facebook/react" }
      })
    );
    expect(parsed?.root).toBeUndefined();
  });

  it("falls back to `private` on an API that omits visibility", () => {
    const parsed = parseGhRestRepo(
      JSON.stringify({ full_name: "acme/api", private: true })
    );
    expect(parsed?.visibility).toBe("private");
    expect(
      parseGhRestRepo(JSON.stringify({ full_name: "acme/api", private: false }))
        ?.visibility
    ).toBe("public");
    // Neither field present is genuinely unknown, not public.
    expect(
      parseGhRestRepo(JSON.stringify({ full_name: "acme/api" }))?.visibility
    ).toBe("unknown");
  });
});

describe("account parsing", () => {
  it("reads the login and the org list", () => {
    expect(parseGhLogin('{"login":"huntharo"}')).toBe("huntharo");
    expect(parseGhLogin("{}")).toBeNull();
    expect(
      parseGhOrgLogins(JSON.stringify([{ login: "pwr" }, { id: 2 }]))
    ).toEqual(["pwr"]);
  });
});

describe("GitHubRepoProvider", () => {
  const baseGh = (overrides: Record<string, string> = {}) =>
    vi.fn(async (args: string[]) => {
      const key = args.join(" ");
      if (key in overrides) return overrides[key]!;
      if (args[0] === "--version") return "gh version 2.92.0";
      if (key === "api user") return '{"login":"huntharo"}';
      if (key === "api user/orgs --paginate") return '[{"login":"pwr-family"}]';
      if (args[1]?.startsWith("repos/")) {
        return JSON.stringify({
          full_name: args[1].slice("repos/".length),
          visibility: "public"
        });
      }
      return "[]";
    });

  it("lists the personal account first, then organizations", async () => {
    // Availability is ForgeStatusService's job; a repo provider only answers
    // "which accounts can this user fork into".
    expect(await new GitHubRepoProvider(baseGh()).owners()).toEqual([
      { login: "huntharo", kind: "user", host: "github" },
      { login: "pwr-family", kind: "organization", host: "github" }
    ]);
  });

  it("still reports the personal target without read:org", async () => {
    const gh = vi.fn(async (args: string[]) => {
      if (args[0] === "--version") return "gh version 2.92.0";
      if (args.join(" ") === "api user") return '{"login":"huntharo"}';
      throw new Error("403 Forbidden: missing read:org");
    });
    expect(await new GitHubRepoProvider(gh).owners()).toEqual([
      { login: "huntharo", kind: "user", host: "github" }
    ]);
  });

  it("asks for the fields the identity marks need", async () => {
    const gh = baseGh();
    await new GitHubRepoProvider(gh).listRepos("huntharo", 200);
    expect(gh).toHaveBeenCalledWith([
      "repo",
      "list",
      "huntharo",
      "--limit",
      "200",
      "--json",
      REPO_JSON_FIELDS
    ]);
    for (const field of ["visibility", "isFork", "parent"]) {
      expect(REPO_JSON_FIELDS).toContain(field);
    }
  });

  it("forks into the personal account without passing --org", async () => {
    const gh = baseGh();
    await new GitHubRepoProvider(gh).fork({
      source: "facebook/react",
      targetOwner: "huntharo",
      targetOwnerKind: "user",
      targetName: "react",
      defaultBranchOnly: false
    });
    const forkCall = gh.mock.calls.find((call) => call[0]?.[1] === "fork");
    expect(forkCall?.[0]).toEqual([
      "repo",
      "fork",
      "facebook/react",
      "--clone=false"
    ]);
  });

  it("passes --org for an organization target and --fork-name when renamed", async () => {
    const gh = baseGh();
    await new GitHubRepoProvider(gh).fork({
      source: "facebook/react",
      targetOwner: "pwr-family",
      targetOwnerKind: "organization",
      targetName: "react-fork",
      defaultBranchOnly: true
    });
    const forkCall = gh.mock.calls.find((call) => call[0]?.[1] === "fork");
    expect(forkCall?.[0]).toEqual([
      "repo",
      "fork",
      "facebook/react",
      "--clone=false",
      "--org",
      "pwr-family",
      "--fork-name",
      "react-fork",
      "--default-branch-only"
    ]);
  });

  it("reads the fork back, so 'created' and 'already exists' are one path", async () => {
    // `gh repo fork` prints a human line either way and no JSON at all; the
    // read-back is what makes the two outcomes identical to callers.
    const gh = baseGh();
    const repository = await new GitHubRepoProvider(gh).fork({
      source: "facebook/react",
      targetOwner: "huntharo",
      targetOwnerKind: "user",
      targetName: "react",
      defaultBranchOnly: false
    });
    expect(repository.nameWithOwner).toBe("huntharo/react");
  });

  it("reports its fork phases in order", async () => {
    const phases: string[] = [];
    await new GitHubRepoProvider(baseGh()).fork({
      source: "facebook/react",
      targetOwner: "huntharo",
      targetOwnerKind: "user",
      targetName: "react",
      defaultBranchOnly: false,
      onPhase: (phase) => phases.push(phase)
    });
    expect(phases).toEqual(["creating", "awaiting_fork"]);
  });
});
