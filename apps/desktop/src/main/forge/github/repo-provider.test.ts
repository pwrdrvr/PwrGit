import { describe, expect, it, vi } from "vitest";
import {
  GitHubRepoProvider,
  parseGhLogin,
  parseGhOrgLogins,
  parseGhRestRepo,
  parseGhSearchRepos,
  SEARCH_JSON_FIELDS
} from "./repo-provider";

describe("parseGhSearchRepos", () => {
  it("reads one `gh search repos --json` row", () => {
    expect(
      parseGhSearchRepos(
        JSON.stringify([
          {
            name: "react",
            fullName: "huntharo/react",
            description: "UI library",
            visibility: "public",
            isPrivate: false,
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
        // Search returns no clone URLs; both are derived from the slug.
        sshUrl: "git@github.com:huntharo/react.git",
        httpsUrl: "https://github.com/huntharo/react",
        updatedAt: "2026-08-01T12:00:00Z",
        localPaths: []
      }
    ]);
  });

  it("reads GitHub Enterprise's internal tier", () => {
    expect(
      parseGhSearchRepos(
        JSON.stringify([{ fullName: "acme/api", visibility: "internal" }])
      )[0]?.visibility
    ).toBe("internal");
  });

  it("falls back to isPrivate, and reports neither as unknown", () => {
    expect(
      parseGhSearchRepos(
        JSON.stringify([{ fullName: "acme/api", isPrivate: true }])
      )[0]?.visibility
    ).toBe("private");
    expect(
      parseGhSearchRepos(JSON.stringify([{ fullName: "acme/api" }]))[0]
        ?.visibility
    ).toBe("unknown");
  });

  it("carries no fork lineage — search does not report a parent", () => {
    // Absent, not guessed. `viewRepo` fills it in once a row is picked.
    expect(
      parseGhSearchRepos(
        JSON.stringify([{ fullName: "acme/api", visibility: "public" }])
      )[0]?.parent
    ).toBeUndefined();
  });

  it("drops rows with no fullName, and survives bad JSON shapes", () => {
    // `nameWithOwner` is `gh repo list`'s key, not search's — a parser that
    // accepted both would quietly return nothing if the field were renamed.
    expect(
      parseGhSearchRepos(JSON.stringify([{ nameWithOwner: "acme/api" }]))
    ).toEqual([]);
    expect(parseGhSearchRepos("null")).toEqual([]);
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

  it("searches every scoped owner in ONE call, not one call per owner", async () => {
    // The whole point of replacing the per-owner listing: a profile with
    // sixteen owners cost sixteen round trips before the dialog could paint.
    const gh = baseGh();
    await new GitHubRepoProvider(gh).searchRepos({
      query: "micro",
      owners: ["pwrdrvr", "huntharo"],
      limit: 40
    });
    expect(gh).toHaveBeenCalledTimes(1);
    expect(gh).toHaveBeenCalledWith([
      "search",
      "repos",
      "micro",
      "--owner=pwrdrvr",
      "--owner=huntharo",
      "--limit",
      "40",
      "--json",
      SEARCH_JSON_FIELDS
    ]);
    for (const field of ["fullName", "visibility"]) {
      expect(SEARCH_JSON_FIELDS).toContain(field);
    }
  });

  it("sorts by recency when an owner is named with no term to rank on", async () => {
    const gh = baseGh();
    await new GitHubRepoProvider(gh).searchRepos({
      query: "  ",
      owners: ["pwrdrvr"],
      limit: 40
    });
    expect(gh.mock.calls[0]?.[0]).toEqual([
      "search",
      "repos",
      "--owner=pwrdrvr",
      "--sort",
      "updated",
      "--limit",
      "40",
      "--json",
      SEARCH_JSON_FIELDS
    ]);
  });

  it("refuses a search with neither a term nor an owner", async () => {
    // That is a request for all of GitHub, which is the enumeration this
    // seam exists to prevent — decline it rather than let `gh` reject it.
    const gh = baseGh();
    expect(
      await new GitHubRepoProvider(gh).searchRepos({
        query: "",
        owners: [],
        limit: 40
      })
    ).toEqual([]);
    expect(gh).not.toHaveBeenCalled();
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
