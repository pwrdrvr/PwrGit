import { describe, expect, it } from "vitest";
import { resolveForgeHostDisplays, type RepoIdentity } from "@pwrgit/shared";
import { remoteForgeChip, repoForgeChip } from "./forge-chip";

/** One host per product: each mark is unambiguous, so neither needs words. */
const DISPLAYS = resolveForgeHostDisplays([
  { hostname: "github.com", host: "github" },
  { hostname: "gitlab.com", host: "gitlab" }
]);

/** Two GitHub hosts: the Octocat can no longer say which, so both get names. */
const TWO_GITHUBS = resolveForgeHostDisplays([
  { hostname: "github.com", host: "github" },
  { hostname: "ghe.acme.example", host: "github" },
  { hostname: "gitlab.com", host: "gitlab" }
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
    expect(repoForgeChip(undefined, DISPLAYS)).toBeNull();
  });

  it("is a bare mark when the mark alone answers", () => {
    expect(repoForgeChip(identity(), DISPLAYS)).toEqual({
      kind: "github",
      name: null,
      others: 0,
      title: "origin is on github.com"
    });
  });

  it("is the two clones of one project, told apart", () => {
    // The whole reason the chip exists: same repo name, same row, two forges.
    // Two different marks, and not a word between them.
    const fromGitHub = repoForgeChip(identity(), DISPLAYS);
    const fromGitLab = repoForgeChip(
      identity({ host: "gitlab", hostname: "gitlab.com" }),
      DISPLAYS
    );
    expect(fromGitHub).toMatchObject({ kind: "github", name: null });
    expect(fromGitLab).toMatchObject({ kind: "gitlab", name: null });
  });

  it("names the host when one mark covers two of them", () => {
    // A second GitHub host makes the Octocat ambiguous; the name comes back on
    // BOTH, because it is the pair that is ambiguous, not one of them.
    expect(repoForgeChip(identity(), TWO_GITHUBS)).toMatchObject({
      kind: "github",
      name: "GitHub"
    });
    expect(
      repoForgeChip(identity({ hostname: "ghe.acme.example" }), TWO_GITHUBS)
    ).toMatchObject({ kind: "github", name: "acme" });
    // The GitLab host is unaffected — its own mark is still unique.
    expect(
      repoForgeChip(
        identity({ host: "gitlab", hostname: "gitlab.com" }),
        TWO_GITHUBS
      )
    ).toMatchObject({ kind: "gitlab", name: null });
  });

  it("always draws a name the user typed", () => {
    // Typing one is a request to see that word. Replacing it with a glyph
    // reads as the field not having worked.
    const named = resolveForgeHostDisplays([
      { hostname: "github.com", host: "github", label: "Wile E." },
      { hostname: "gitlab.com", host: "gitlab" }
    ]);
    expect(repoForgeChip(identity(), named)).toMatchObject({
      kind: "github",
      name: "Wile E."
    });
  });

  it("counts the other forges a repo also has remotes on", () => {
    expect(
      repoForgeChip(
        identity({
          hostname: "gitlab.com",
          host: "gitlab",
          remoteHostnames: ["github.com", "gitlab.com"]
        }),
        DISPLAYS
      )
    ).toEqual({
      kind: "gitlab",
      name: null,
      others: 1,
      title: "origin is on gitlab.com; also GitHub"
    });
  });

  it("spells the other hosts out in the title, never as marks", () => {
    // The tooltip is where the chip's abbreviation is cashed back in, so it
    // uses full names even for hosts whose chip would be a bare glyph.
    expect(
      repoForgeChip(
        identity({
          remoteHostnames: ["ghe.acme.example", "github.com", "gitlab.com"]
        }),
        TWO_GITHUBS
      )
    ).toMatchObject({
      others: 2,
      title: "origin is on github.com; also acme, GitLab"
    });
  });

  it("adds no count when every remote is on origin's own host", () => {
    expect(
      repoForgeChip(identity({ remoteHostnames: ["github.com"] }), DISPLAYS)
    ).toMatchObject({ others: 0 });
  });

  it("treats an unread remote set as 'not known', never as 'no others'", () => {
    // A row stored before the column existed. It must read exactly like a repo
    // with one remote — silence — rather than claiming it has been checked.
    const unread = repoForgeChip(identity(), DISPLAYS);
    const checked = repoForgeChip(
      identity({ remoteHostnames: ["github.com"] }),
      DISPLAYS
    );
    expect(unread).toEqual(checked);
  });

  it("resolves a host that has no settings row", () => {
    // An env-allowlisted host resolves but earns no row, so the store's map
    // has never heard of it. Named alone, it is the only host of its product
    // in that set of one — so it still gets its mark.
    expect(
      repoForgeChip(
        identity({ host: "gitlab", hostname: "gitlab.acme.test" }),
        DISPLAYS
      )
    ).toEqual({
      kind: "gitlab",
      name: null,
      others: 0,
      title: "origin is on gitlab.acme.test"
    });
  });

  it("falls back to words for a host no product claims", () => {
    // There is no mark to draw for `other`, so the chip is text or nothing.
    expect(
      repoForgeChip(
        identity({ host: "other", hostname: "git.acme.test" }),
        DISPLAYS
      )
    ).toMatchObject({ kind: null, name: "acme" });
  });
});

describe("remoteForgeChip", () => {
  const overrides = { "ghe.acme.example": "github" } as const;

  it("marks the forge a remote URL points at", () => {
    expect(
      remoteForgeChip("git@github.com:pwrdrvr/PwrGit.git", {}, DISPLAYS)
    ).toEqual({
      kind: "github",
      name: null,
      others: 0,
      title: "On github.com"
    });
  });

  it("names the instance when one mark covers two hosts", () => {
    expect(
      remoteForgeChip("git@ghe.acme.example:acme/api.git", overrides, TWO_GITHUBS)
    ).toEqual({
      kind: "github",
      name: "acme",
      others: 0,
      title: "On ghe.acme.example"
    });
  });

  it("says nothing for a remote no product claims", () => {
    // A bare repo on a NAS parses fine and is not a forge — the same rule
    // host enumeration follows. Badging it would invent a forge for it.
    expect(
      remoteForgeChip("git@nas.local:backups/PwrGit.git", {}, DISPLAYS)
    ).toBeNull();
  });

  it("says nothing for something that is not a remote at all", () => {
    expect(remoteForgeChip("", {}, DISPLAYS)).toBeNull();
    expect(remoteForgeChip("../sibling-checkout", {}, DISPLAYS)).toBeNull();
  });

  it("resolves a host with no settings row", () => {
    expect(
      remoteForgeChip(
        "https://gitlab.example.com/group/sub/project.git",
        { "gitlab.example.com": "gitlab" },
        DISPLAYS
      )
    ).toMatchObject({ kind: "gitlab", title: "On gitlab.example.com" });
  });
});
