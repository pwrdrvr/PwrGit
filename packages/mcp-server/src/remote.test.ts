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
});
