import { describe, expect, it, vi } from "vitest";
import { capabilitiesFor } from "../capabilities";
import {
  encodeProjectPath,
  forkImportFailed,
  forkImportFinished,
  GitLabRepoProvider,
  parseGitLabGroupPaths,
  parseGitLabProject,
  parseGitLabProjects,
  parseGitLabUsername
} from "./repo-provider";

const PROJECT = {
  id: 42,
  path: "billing-api",
  name: "Billing API",
  path_with_namespace: "acme/platform/billing-api",
  description: "Invoicing service",
  visibility: "internal",
  ssh_url_to_repo: "git@gitlab.com:acme/platform/billing-api.git",
  http_url_to_repo: "https://gitlab.com/acme/platform/billing-api.git",
  web_url: "https://gitlab.com/acme/platform/billing-api",
  last_activity_at: "2026-08-01T12:00:00Z"
};

describe("parseGitLabProject", () => {
  it("reads a project, keeping the subgroup path as the owner", () => {
    expect(parseGitLabProject(PROJECT)).toEqual({
      name: "billing-api",
      owner: "acme/platform",
      nameWithOwner: "acme/platform/billing-api",
      description: "Invoicing service",
      visibility: "internal",
      host: "gitlab",
      hostname: "gitlab.com",
      sshUrl: "git@gitlab.com:acme/platform/billing-api.git",
      httpsUrl: "https://gitlab.com/acme/platform/billing-api.git",
      updatedAt: "2026-08-01T12:00:00Z",
      localPaths: []
    });
  });

  it("prefers `path` over `name` — `name` is a human title", () => {
    // A checkout folder is named from this, and GitLab's `name` may contain
    // spaces ("Billing API").
    expect(parseGitLabProject(PROJECT)?.name).toBe("billing-api");
  });

  it("names the instance a self-hosted project actually lives on", () => {
    const parsed = parseGitLabProject({
      ...PROJECT,
      web_url: "https://gitlab.acme.io/acme/platform/billing-api"
    });
    expect(parsed?.hostname).toBe("gitlab.acme.io");
  });

  it("records a fork's parent", () => {
    const parsed = parseGitLabProject({
      ...PROJECT,
      forked_from_project: {
        path_with_namespace: "upstream/billing-api",
        web_url: "https://gitlab.com/upstream/billing-api"
      }
    });
    expect(parsed?.parent).toEqual({
      nameWithOwner: "upstream/billing-api",
      url: "https://gitlab.com/upstream/billing-api"
    });
  });

  it("reports an unrecognized visibility as unknown, never as public", () => {
    expect(parseGitLabProject({ ...PROJECT, visibility: "secret" })?.visibility)
      .toBe("unknown");
    expect(parseGitLabProject({ ...PROJECT, visibility: undefined })?.visibility)
      .toBe("unknown");
  });

  it("rejects rows without a project path", () => {
    expect(parseGitLabProject({ id: 1 })).toBeNull();
    expect(parseGitLabProject(null)).toBeNull();
    expect(parseGitLabProject({ path_with_namespace: "no-owner" })).toBeNull();
  });
});

describe("parseGitLabProjects", () => {
  it("reads a list and drops unusable rows", () => {
    expect(
      parseGitLabProjects(JSON.stringify([PROJECT, { id: 2 }])).map(
        (p) => p.nameWithOwner
      )
    ).toEqual(["acme/platform/billing-api"]);
  });
});

describe("account and group parsing", () => {
  it("reads the signed-in username", () => {
    expect(parseGitLabUsername('{"username":"huntharo"}')).toBe("huntharo");
    expect(parseGitLabUsername("{}")).toBeNull();
  });

  it("prefers full_path so a subgroup stays addressable", () => {
    expect(
      parseGitLabGroupPaths(
        JSON.stringify([
          { path: "platform", full_path: "acme/platform" },
          { path: "solo" }
        ])
      )
    ).toEqual(["acme/platform", "solo"]);
  });
});

describe("fork import status", () => {
  it("treats finished and none as ready", () => {
    expect(forkImportFinished({ import_status: "finished" })).toBe(true);
    expect(forkImportFinished({ import_status: "none" })).toBe(true);
    // A response with no import_status at all is a project that was not
    // imported — nothing to wait for.
    expect(forkImportFinished({})).toBe(true);
    expect(forkImportFinished({ import_status: "started" })).toBe(false);
    expect(forkImportFinished({ import_status: "scheduled" })).toBe(false);
  });

  it("surfaces a failed import rather than waiting it out", () => {
    expect(
      forkImportFailed({ import_status: "failed", import_error: "disk full" })
    ).toBe("disk full");
    expect(forkImportFailed({ import_status: "started" })).toBeNull();
  });
});

describe("encodeProjectPath", () => {
  it("URL-encodes the path the way GitLab addresses a project", () => {
    expect(encodeProjectPath("acme/platform/billing-api")).toBe(
      "acme%2Fplatform%2Fbilling-api"
    );
    expect(encodeProjectPath("acme/api.git")).toBe("acme%2Fapi");
  });
});

describe("GitLabRepoProvider", () => {
  it("lists the user first, then groups it may create projects in", async () => {
    const provider = new GitLabRepoProvider(async (args) => {
      if (args[1] === "user") return '{"username":"huntharo"}';
      if (args[1]?.startsWith("groups?")) {
        // Developer (30) is the floor for creating a project in a group.
        expect(args[1]).toContain("min_access_level=30");
        return JSON.stringify([{ full_path: "acme/platform" }]);
      }
      return "[]";
    });
    expect(await provider.owners()).toEqual([
      { login: "huntharo", kind: "user", host: "gitlab" },
      { login: "acme/platform", kind: "organization", host: "gitlab" }
    ]);
  });

  it("keeps subgroup projects when several owners narrow an instance search", async () => {
    // The fixture is deliberately four deep: `pwrdrvr/qa/forge/PwrGit-Test`
    // has namespace `pwrdrvr/qa/forge`, so an equality check against the known
    // owner `pwrdrvr` would drop it — while the single-owner path returns it
    // through `include_subgroups=true`. The same query must not answer
    // differently depending on how many other accounts happen to be indexed.
    const provider = new GitLabRepoProvider(async (args) => {
      expect(args[1]).toContain("projects?");
      return JSON.stringify([
        { path_with_namespace: "pwrdrvr/qa/forge/PwrGit-Test", path: "PwrGit-Test" },
        { path_with_namespace: "pwrdrvr/PwrGit", path: "PwrGit" },
        { path_with_namespace: "someone-else/PwrGit", path: "PwrGit" },
        // A namespace that merely starts with the same characters is a
        // different account, not a subgroup — the `/` is what separates them.
        { path_with_namespace: "pwrdrvr-fan/PwrGit", path: "PwrGit" }
      ]);
    });

    const found = await provider.searchRepos({
      query: "PwrGit",
      owners: ["pwrdrvr", "acme"],
      limit: 40
    });

    expect(found.map((project) => project.nameWithOwner)).toEqual([
      "pwrdrvr/qa/forge/PwrGit-Test",
      "pwrdrvr/PwrGit"
    ]);
  });

  it("declines an owner-less search with no term rather than listing everything", async () => {
    const glab = vi.fn(async () => "[]");
    expect(
      await new GitLabRepoProvider(glab).searchRepos({
        query: "  ",
        owners: ["pwrdrvr", "acme"],
        limit: 40
      })
    ).toEqual([]);
    expect(glab).not.toHaveBeenCalled();
  });

  it("still reports a personal target when the group listing fails", async () => {
    const provider = new GitLabRepoProvider(async (args) => {
      if (args[1] === "user") return '{"username":"huntharo"}';
      throw new Error("403 Forbidden");
    });
    expect(await provider.owners()).toEqual([
      { login: "huntharo", kind: "user", host: "gitlab" }
    ]);
  });

  it("resolves the network root by walking the fork chain", async () => {
    const projects: Record<string, unknown> = {
      "acme%2Ffork": {
        ...PROJECT,
        path: "fork",
        path_with_namespace: "acme/fork",
        web_url: "https://gitlab.com/acme/fork",
        forked_from_project: {
          path_with_namespace: "middle/api",
          web_url: "https://gitlab.com/middle/api"
        }
      },
      "middle%2Fapi": {
        ...PROJECT,
        path: "api",
        path_with_namespace: "middle/api",
        web_url: "https://gitlab.com/middle/api",
        forked_from_project: {
          path_with_namespace: "root/api",
          web_url: "https://gitlab.com/root/api"
        }
      },
      "root%2Fapi": {
        ...PROJECT,
        path: "api",
        path_with_namespace: "root/api",
        web_url: "https://gitlab.com/root/api"
      }
    };
    const provider = new GitLabRepoProvider(async (args) => {
      const key = args[1]?.replace("projects/", "") ?? "";
      return JSON.stringify(projects[key]);
    });

    const repository = await provider.viewRepo("acme/fork");

    // GitLab only reports the immediate parent; the root is what makes
    // `upstream` unambiguous for a fork of a fork.
    expect(repository.parent?.nameWithOwner).toBe("middle/api");
    expect(repository.root?.nameWithOwner).toBe("root/api");
  });

  it("omits root when the parent is already the root", async () => {
    const provider = new GitLabRepoProvider(async (args) => {
      const key = args[1]?.replace("projects/", "") ?? "";
      if (key === "acme%2Ffork") {
        return JSON.stringify({
          ...PROJECT,
          path_with_namespace: "acme/fork",
          forked_from_project: { path_with_namespace: "root/api" }
        });
      }
      return JSON.stringify({ ...PROJECT, path_with_namespace: "root/api" });
    });
    const repository = await provider.viewRepo("acme/fork");
    expect(repository.root).toBeUndefined();
  });

  it("forks through the REST endpoint and waits for the copy to finish", async () => {
    const calls: string[][] = [];
    let polls = 0;
    const glab = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[1] === "--method") {
        return JSON.stringify({
          ...PROJECT,
          path: "billing-api",
          path_with_namespace: "huntharo/billing-api",
          web_url: "https://gitlab.com/huntharo/billing-api",
          import_status: "scheduled"
        });
      }
      polls += 1;
      return JSON.stringify({
        ...PROJECT,
        path: "billing-api",
        path_with_namespace: "huntharo/billing-api",
        web_url: "https://gitlab.com/huntharo/billing-api",
        import_status: polls >= 2 ? "finished" : "started"
      });
    });
    vi.useFakeTimers();
    const provider = new GitLabRepoProvider(glab);
    const phases: string[] = [];
    const forked = provider.fork({
      source: "acme/platform/billing-api",
      targetOwner: "huntharo",
      targetOwnerKind: "user",
      targetName: "billing-api",
      defaultBranchOnly: false,
      onPhase: (phase) => phases.push(phase)
    });
    await vi.runAllTimersAsync();
    const repository = await forked;
    vi.useRealTimers();

    expect(repository.nameWithOwner).toBe("huntharo/billing-api");
    expect(phases).toEqual(["creating", "awaiting_fork"]);
    expect(calls[0]).toEqual([
      "api",
      "--method",
      "POST",
      "projects/acme%2Fplatform%2Fbilling-api/fork",
      "--field",
      "namespace_path=huntharo",
      "--field",
      "name=billing-api",
      "--field",
      "path=billing-api"
    ]);
  });

  it("treats a name already taken as the existing fork", async () => {
    const glab = vi.fn(async (args: string[]) => {
      if (args[1] === "--method") {
        throw new Error("409 Conflict: name has already been taken");
      }
      return JSON.stringify({
        ...PROJECT,
        path: "billing-api",
        path_with_namespace: "huntharo/billing-api",
        web_url: "https://gitlab.com/huntharo/billing-api",
        import_status: "finished",
        // A real already-forked project carries its lineage; without it this
        // is indistinguishable from an unrelated repo squatting the path.
        forked_from_project: {
          path_with_namespace: "acme/platform/billing-api"
        }
      });
    });
    const provider = new GitLabRepoProvider(glab);

    const repository = await provider.fork({
      source: "acme/platform/billing-api",
      targetOwner: "huntharo",
      targetOwnerKind: "user",
      targetName: "billing-api",
      defaultBranchOnly: false
    });

    expect(repository.nameWithOwner).toBe("huntharo/billing-api");
  });

  it("does not accept an unrelated project sitting at the target path", async () => {
    // The 409 path exists for "you already forked this". Any other failure
    // can leave a project there that is nobody's fork of the source, and
    // returning it would have the caller clone a stranger's repository.
    const glab = vi.fn(async (args: string[]) => {
      if (args[1] === "--method") {
        throw new Error("403 Forbidden: forking is disabled for this group");
      }
      return JSON.stringify({
        ...PROJECT,
        path: "billing-api",
        path_with_namespace: "huntharo/billing-api",
        web_url: "https://gitlab.com/huntharo/billing-api",
        import_status: "finished"
        // note: no forked_from_project — unrelated to the source
      });
    });

    await expect(
      new GitLabRepoProvider(glab).fork({
        source: "acme/platform/billing-api",
        targetOwner: "huntharo",
        targetOwnerKind: "user",
        targetName: "billing-api",
        defaultBranchOnly: false
      })
    ).rejects.toThrow(/forking is disabled/);
  });

  it("does not swallow an authentication failure as an existing fork", async () => {
    const provider = new GitLabRepoProvider(async (args) => {
      if (args[0] === "--version") return "glab 1.42.0";
      throw new Error("401 Unauthorized: glab auth login");
    });
    await expect(
      provider.fork({
        source: "acme/api",
        targetOwner: "huntharo",
        targetOwnerKind: "user",
        targetName: "api",
        defaultBranchOnly: false
      })
    ).rejects.toThrow();
  });

  it("is declared as unable to fork just the default branch", () => {
    // GitLab's fork API has no equivalent. The claim lives in the one
    // capabilities table so Settings → Forges and the fork dialog read the
    // same answer.
    expect(capabilitiesFor("gitlab").forkDefaultBranchOnly).toBe(false);
    expect(capabilitiesFor("github").forkDefaultBranchOnly).toBe(true);
  });
});
