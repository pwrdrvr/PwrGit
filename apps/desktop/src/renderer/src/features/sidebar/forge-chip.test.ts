import { describe, expect, it } from "vitest";
import type { RepoIdentity } from "@pwrgit/shared";
import { forgeChipText, remoteForgeChip, repoForgeChip } from "./forge-chip";

const NAMES = new Map([
  ["github.com", "GitHub"],
  ["gitlab.com", "GitLab"],
  ["ghe.acme.example", "Acme"]
]);

const identity = (over: Partial<RepoIdentity> = {}): RepoIdentity => ({
  host: "github",
  hostname: "github.com",
  owner: "pwrdrvr",
  name: "PwrGit",
  nameWithOwner: "pwrdrvr/PwrGit",
  visibility: "public",
  ...over
});

describe("repoForgeChip", () => {
  it("says nothing for a repo whose identity has not been read", () => {
    expect(repoForgeChip(undefined, NAMES)).toBeNull();
  });

  it("names origin's host", () => {
    expect(repoForgeChip(identity(), NAMES)).toEqual({
      name: "GitHub",
      others: 0,
      title: "origin is on github.com"
    });
  });

  it("is the two clones of one project, told apart", () => {
    // The whole reason the chip exists: same repo name, same row, two forges.
    const fromGitHub = repoForgeChip(identity(), NAMES);
    const fromGitLab = repoForgeChip(
      identity({ host: "gitlab", hostname: "gitlab.com" }),
      NAMES
    );
    expect(fromGitHub?.name).toBe("GitHub");
    expect(fromGitLab?.name).toBe("GitLab");
  });

  it("counts the other forges a repo also has remotes on", () => {
    expect(
      repoForgeChip(
        identity({
          hostname: "gitlab.com",
          host: "gitlab",
          remoteHostnames: ["github.com", "gitlab.com"]
        }),
        NAMES
      )
    ).toEqual({
      name: "GitLab",
      others: 1,
      title: "origin is on gitlab.com; also GitHub"
    });
  });

  it("counts every other host, and names them all in the title", () => {
    expect(
      repoForgeChip(
        identity({
          remoteHostnames: ["ghe.acme.example", "github.com", "gitlab.com"]
        }),
        NAMES
      )
    ).toEqual({
      name: "GitHub",
      others: 2,
      title: "origin is on github.com; also Acme, GitLab"
    });
  });

  it("adds no count when every remote is on origin's own host", () => {
    expect(
      repoForgeChip(identity({ remoteHostnames: ["github.com"] }), NAMES)
    ).toEqual({ name: "GitHub", others: 0, title: "origin is on github.com" });
  });

  it("treats an unread remote set as 'not known', never as 'no others'", () => {
    // A row stored before the column existed. It must read exactly like a repo
    // with one remote — silence — rather than claiming it has been checked.
    const unread = repoForgeChip(identity(), NAMES);
    const checked = repoForgeChip(
      identity({ remoteHostnames: ["github.com"] }),
      NAMES
    );
    expect(unread).toEqual(checked);
  });

  it("reads as one string, with the count last", () => {
    const chip = repoForgeChip(
      identity({ remoteHostnames: ["github.com", "gitlab.com"] }),
      NAMES
    );
    expect(chip).not.toBeNull();
    expect(forgeChipText(chip!)).toBe("GitHub +1");
    expect(forgeChipText(repoForgeChip(identity(), NAMES)!)).toBe("GitHub");
  });

  it("names a host that has no settings row", () => {
    // An env-allowlisted host resolves but earns no row, so the store's map
    // has never heard of it. It still gets a name.
    expect(
      repoForgeChip(
        identity({ host: "gitlab", hostname: "gitlab.acme.test" }),
        NAMES
      )
    ).toEqual({
      name: "acme",
      others: 0,
      title: "origin is on gitlab.acme.test"
    });
  });
});

describe("remoteForgeChip", () => {
  const overrides = { "ghe.acme.example": "github" } as const;

  it("names the forge a remote URL points at", () => {
    expect(
      remoteForgeChip("git@github.com:pwrdrvr/PwrGit.git", {}, NAMES)
    ).toEqual({ name: "GitHub", others: 0, title: "On github.com" });
  });

  it("resolves a self-managed instance through the host map", () => {
    expect(
      remoteForgeChip(
        "git@ghe.acme.example:acme/api.git",
        overrides,
        NAMES
      )
    ).toEqual({ name: "Acme", others: 0, title: "On ghe.acme.example" });
  });

  it("says nothing for a remote no product claims", () => {
    // A bare repo on a NAS parses fine and is not a forge — the same rule
    // host enumeration follows. Badging it would invent a forge for it.
    expect(
      remoteForgeChip("git@nas.local:backups/PwrGit.git", {}, NAMES)
    ).toBeNull();
  });

  it("says nothing for something that is not a remote at all", () => {
    expect(remoteForgeChip("", {}, NAMES)).toBeNull();
    expect(remoteForgeChip("../sibling-checkout", {}, NAMES)).toBeNull();
  });

  it("derives a name for a host with no settings row", () => {
    expect(
      remoteForgeChip(
        "https://gitlab.example.com/group/sub/project.git",
        { "gitlab.example.com": "gitlab" },
        NAMES
      )
    ).toEqual({ name: "example", others: 0, title: "On gitlab.example.com" });
  });
});
