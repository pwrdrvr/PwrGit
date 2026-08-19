import { describe, expect, it } from "vitest";
import {
  classifyForgeHost,
  forgeWebUrl,
  parseForgeRemote
} from "./forge-remote";

describe("parseForgeRemote", () => {
  it("reads scp, https, ssh and git:// remotes", () => {
    for (const url of [
      "git@github.com:pwrdrvr/PwrGit.git",
      "git@github.com:pwrdrvr/PwrGit",
      "https://github.com/pwrdrvr/PwrGit.git",
      "https://github.com/pwrdrvr/PwrGit/",
      "ssh://git@github.com/pwrdrvr/PwrGit.git",
      "git://github.com/pwrdrvr/PwrGit.git"
    ]) {
      expect(parseForgeRemote(url)).toMatchObject({
        host: "github",
        hostname: "github.com",
        owner: "pwrdrvr",
        repo: "PwrGit",
        nameWithOwner: "pwrdrvr/PwrGit"
      });
    }
  });

  it("keeps a GitLab subgroup path in the owner", () => {
    expect(
      parseForgeRemote("git@gitlab.com:acme/platform/team/billing-api.git")
    ).toMatchObject({
      host: "gitlab",
      owner: "acme/platform/team",
      repo: "billing-api",
      nameWithOwner: "acme/platform/team/billing-api"
    });
  });

  it("does not read a port as the project path", () => {
    expect(parseForgeRemote("ssh://git@gitlab.com:22/acme/api.git")).toMatchObject(
      { host: "gitlab", hostname: "gitlab.com", nameWithOwner: "acme/api" }
    );
  });

  it("recognizes a self-hosted GitLab, and admits it cannot know otherwise", () => {
    // `gitlab.*` is a real deployment convention, so it is inferable. GitHub
    // Enterprise has no equivalent — its hostnames are arbitrary
    // (`git.acme.com`) — so `github.acme.io` stays `other` rather than being
    // guessed, which would aim API calls at the wrong product. A self-hosted
    // GitHub needs an explicit override; see classifyForgeHost.
    expect(parseForgeRemote("git@gitlab.acme.io:acme/api.git")?.host).toBe(
      "gitlab"
    );
    expect(parseForgeRemote("https://github.acme.io/acme/api")?.host).toBe(
      "other"
    );
    const other = parseForgeRemote("https://code.acme.io/acme/api");
    expect(other?.host).toBe("other");
    expect(other?.hostname).toBe("code.acme.io");
  });

  it("takes an explicit override for a host no heuristic can place", () => {
    expect(
      classifyForgeHost("git.acme.com", { "git.acme.com": "github" })
    ).toBe("github");
    expect(classifyForgeHost("git.acme.com")).toBe("other");
  });

  it("lowercases the hostname but preserves project-path case", () => {
    expect(parseForgeRemote("git@GitHub.COM:PwrDrvr/PwrGit.git")).toMatchObject({
      hostname: "github.com",
      nameWithOwner: "PwrDrvr/PwrGit"
    });
  });

  it("returns null for things that are not remotes", () => {
    expect(parseForgeRemote("not a url")).toBeNull();
    expect(parseForgeRemote("")).toBeNull();
    expect(parseForgeRemote("   ")).toBeNull();
    // A local path names no forge, and must not be read as host:path.
    expect(parseForgeRemote("/srv/git/repo.git")).toBeNull();
    expect(parseForgeRemote("C:\\repos\\thing")).toBeNull();
    // One path segment is an owner with no repository.
    expect(parseForgeRemote("https://github.com/pwrdrvr")).toBeNull();
  });

  it("refuses a deeper github.com path, which is never a project", () => {
    // `.../issues` and `.../wiki` are pages, not repositories, and GitHub has
    // no subgroups for them to be mistaken for. This only applies where the
    // host is known to be GitHub — on an unclassified host we cannot know the
    // path depth rules, so the path is returned as given.
    expect(parseForgeRemote("https://github.com/o/r/issues")).toBeNull();
    // The same shape on GitLab is a real project in a subgroup.
    expect(parseForgeRemote("https://gitlab.com/o/r/p")?.nameWithOwner).toBe(
      "o/r/p"
    );
  });
});

describe("forgeWebUrl", () => {
  it("builds the browser URL for either forge", () => {
    expect(forgeWebUrl("github.com", "a/b")).toBe("https://github.com/a/b");
    expect(forgeWebUrl("gitlab.acme.io", "g/s/p")).toBe(
      "https://gitlab.acme.io/g/s/p"
    );
  });
});
