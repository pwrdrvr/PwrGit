import { describe, expect, it } from "vitest";
import {
  parseRemoteIdentity,
  parseRepositoryTarget,
  summarizeRemotes,
  targetMatchesRemote
} from "./remote.js";

describe("remote identity", () => {
  it("normalizes GitHub and nested GitLab remotes without credentials", () => {
    expect(
      parseRemoteIdentity("https://oauth2:super-secret@github.com/pwrdrvr/PwrGit.git")
    ).toEqual({ provider: "github", host: "github.com", path: "pwrdrvr/PwrGit" });
    expect(
      parseRemoteIdentity("git@gitlab.com:group/subgroup/project.git")
    ).toEqual({
      provider: "gitlab",
      host: "gitlab.com",
      path: "group/subgroup/project"
    });
    expect(JSON.stringify(parseRemoteIdentity("https://u:p@github.com/o/r.git"))).not.toContain(
      "u:p"
    );
  });

  it("does not guess a provider for an unknown self-hosted forge", () => {
    expect(parseRemoteIdentity("git@example.test:team/repo.git")).toEqual({
      provider: "other",
      host: "example.test",
      path: "team/repo"
    });
  });

  it("assigns canonical and upstream roles and matches flexible targets", () => {
    const remotes = summarizeRemotes([
      { name: "origin", url: "git@github.com:fork/repo.git" },
      { name: "upstream", url: "https://github.com/source/repo.git" }
    ]);
    expect(remotes.map(({ name, role }) => ({ name, role }))).toEqual([
      { name: "origin", role: "canonical" },
      { name: "upstream", role: "upstream" }
    ]);
    const target = parseRepositoryTarget("source/repo");
    expect(target).not.toBeNull();
    expect(targetMatchesRemote(target!, remotes[1]!)).toBe(true);
  });

  it("finds a checkout on a host it cannot place", () => {
    // Locating a checkout is a host + path question. Requiring a placeable
    // provider first is what made every self-managed instance unreachable when
    // the `gitlab.*` guess was dropped: the forge is unknown, the repository
    // is not. `git.acme.test` is deliberately a host no naming heuristic ever
    // covered, so this passes for the right reason.
    const remotes = summarizeRemotes([
      { name: "origin", url: "git@git.acme.test:acme/platform/api.git" }
    ]);
    expect(remotes[0]).toMatchObject({
      provider: "other",
      host: "git.acme.test",
      role: "canonical"
    });
    for (const spelling of [
      "https://git.acme.test/acme/platform/api",
      "git@git.acme.test:acme/platform/api.git",
      "git.acme.test/acme/platform/api"
    ]) {
      const target = parseRepositoryTarget(spelling);
      expect(target).toMatchObject({
        provider: null,
        host: "git.acme.test",
        path: "acme/platform/api"
      });
      expect(targetMatchesRemote(target!, remotes[0]!)).toBe(true);
    }
    // A bare slug still matches on the path alone, and a different host does
    // not match at all — the host is what keeps two same-named projects apart.
    expect(
      targetMatchesRemote(parseRepositoryTarget("acme/platform/api")!, remotes[0]!)
    ).toBe(true);
    expect(
      targetMatchesRemote(
        parseRepositoryTarget("https://gitlab.com/acme/platform/api")!,
        remotes[0]!
      )
    ).toBe(false);
  });

  it("takes a self-managed host from the env allowlist, never from its name", () => {
    // The server bundles standalone: no settings file, no `gh`/`glab`
    // enumeration. Env is the only way an instance gets *stated*, and it is the
    // app's own spelling so a user configures it once. Without it the host is
    // `other` — `gitlab.` in the name buys nothing, which is the whole point.
    const env = { PWRGIT_GITLAB_HOSTS: "gitlab.acme.test, git.acme.test" };
    expect(parseRemoteIdentity("git@gitlab.acme.test:acme/api.git")).toMatchObject({
      provider: "other"
    });
    expect(
      parseRemoteIdentity("git@gitlab.acme.test:acme/api.git", env)
    ).toMatchObject({ provider: "gitlab", host: "gitlab.acme.test" });
    expect(
      parseRemoteIdentity("git@git.acme.test:acme/api.git", env)
    ).toMatchObject({ provider: "gitlab" });
    // A GitHub Enterprise host inherits GitHub's two-segment path rule.
    const ghe = { PWRGIT_GITHUB_HOSTS: "ghe.acme.test" };
    expect(
      parseRemoteIdentity("https://ghe.acme.test/acme/api", ghe)?.provider
    ).toBe("github");
    expect(parseRemoteIdentity("https://ghe.acme.test/o/r/issues", ghe)).toBeNull();
    // An explicit provider still filters a placeable target.
    expect(parseRepositoryTarget("https://gitlab.com/a/b", "github")).toBeNull();
  });
});


it("recognizes GitCafe and its explicit host overrides", () => {
  expect(parseRemoteIdentity("git@git.cafe:sample/demo.git")).toEqual({ provider: "gitcafe", host: "git.cafe", path: "sample/demo" });
  expect(parseRemoteIdentity("https://cafe.example/sample/demo.git", { PWRGIT_GITCAFE_HOSTS: "cafe.example" })?.provider).toBe("gitcafe");
  expect(parseRemoteIdentity("https://git.cafe/sample/demo/tree/main")).toBeNull();
  expect(parseRepositoryTarget("sample/demo", "gitcafe")?.provider).toBe("gitcafe");
});
