import { describe, expect, it } from "vitest";
import type {
  FolderIdentityReport,
  FolderProfileIdentity,
  FolderRepoIdentity,
  OutsideGitIdentity
} from "@pwrgit/shared";
import { differingRepos, folderCardChip, folderRowView, folderTally } from "./folder-view";

const WORK = "rowan@northwind.example";
const PERSONAL = "rowan@vale.example";
const CONFIGURED: OutsideGitIdentity = {
  kind: "configured",
  author: { name: "Rowan Vale", email: PERSONAL },
  committer: { name: "Rowan Vale", email: PERSONAL }
};

function repo(name: string, overrides: Partial<FolderRepoIdentity> = {}): FolderRepoIdentity {
  return {
    repoId: `r-${name}`,
    name,
    path: `/Users/rowan/Work/${name}`,
    email: WORK,
    authorName: "Rowan Vale",
    source: "pwrgit",
    origin: "/Users/rowan/.gitconfig-pwrgit-work",
    matches: true,
    ...overrides
  };
}

function work(repos: FolderRepoIdentity[], overrides: Partial<FolderProfileIdentity> = {}): FolderProfileIdentity {
  return {
    profileId: "work",
    name: "Work",
    mono: "W",
    email: WORK,
    authorName: null,
    roots: ["/Users/rowan/Work"],
    overlaps: [],
    includeFile: "/Users/rowan/.gitconfig-pwrgit-work",
    repos,
    ...overrides
  };
}

const FROM_GLOBAL: Partial<FolderRepoIdentity> = {
  email: PERSONAL,
  source: "global",
  origin: "/Users/rowan/.gitconfig",
  matches: false
};

describe("the profile popup's Git row", () => {
  it("is green when every repo commits as the profile", () => {
    expect(folderRowView(work([repo("api"), repo("billing")]), CONFIGURED)).toEqual({
      tone: "ok",
      text: `${WORK} in all 2 repos`
    });
  });

  it("names the email every repo uses instead, when they agree", () => {
    expect(folderRowView(work([repo("api", FROM_GLOBAL), repo("billing", FROM_GLOBAL)]), CONFIGURED)).toEqual({
      tone: "warn",
      text: `Commits as ${PERSONAL} in all 2 repos`
    });
  });

  it("counts the ones that differ", () => {
    const view = folderRowView(
      work([repo("api"), repo("billing"), repo("infra", { ...FROM_GLOBAL, source: "local" })]),
      CONFIGURED
    );
    expect(view).toEqual({ tone: "warn", text: "1 of 3 repos commits as another email" });
  });

  it("puts a shared folder first", () => {
    const view = folderRowView(
      work([repo("api")], {
        overlaps: [
          {
            root: "/Users/rowan/Work",
            profileId: "personal",
            profileName: "Personal",
            otherRoot: "/Users/rowan/Work",
            relation: "same"
          }
        ]
      }),
      CONFIGURED
    );
    expect(view).toEqual({ tone: "warn", text: "Work is also a folder of “Personal”" });
  });

  it("says when nothing is configured at all", () => {
    const none: Partial<FolderRepoIdentity> = { email: null, source: "none", origin: null, matches: false };
    expect(folderRowView(work([repo("api", none)]), { kind: "missing", message: "x" }).tone).toBe("warn");
    expect(folderRowView(work([repo("api", none)]), { kind: "missing", message: "x" }).text).toMatch(/^No identity here/);
  });

  it("falls back to the machine identity with no repos or no email", () => {
    expect(folderRowView(work([]), CONFIGURED)).toEqual({
      tone: "neutral",
      text: `${PERSONAL} · Git’s global identity`
    });
    expect(folderRowView(work([repo("api")], { email: "" }), CONFIGURED).text).toBe(
      `Follows Git’s own identity · ${PERSONAL}`
    );
  });
});

describe("Settings › By folder", () => {
  const report = (enabled: boolean, profiles: FolderProfileIdentity[]): FolderIdentityReport => ({
    enabled,
    globalFile: "/Users/rowan/.gitconfig",
    machine: CONFIGURED,
    profiles
  });

  it("chips Off, In step, repos that differ, or what needs attention", () => {
    expect(folderCardChip(null)).toEqual({ label: "Checking", kind: "default" });
    expect(folderCardChip(report(false, [work([repo("api")])]))).toEqual({ label: "Off", kind: "default" });
    expect(folderCardChip(report(true, [work([repo("api")])]))).toEqual({ label: "In step", kind: "ok" });
    expect(folderCardChip(report(false, [work([repo("api", FROM_GLOBAL), repo("b", FROM_GLOBAL)])]))).toEqual({
      label: "2 repos differ",
      kind: "warn"
    });
    expect(folderCardChip(report(true, [work([repo("api", { ...FROM_GLOBAL, source: "local" })])]))).toEqual({
      label: "1 needs attention",
      kind: "warn"
    });
  });

  it("tallies a repo that pins its own email, and lists it either way", () => {
    const profile = work([repo("api"), repo("infra", { ...FROM_GLOBAL, source: "local" })]);
    expect(folderTally(profile)).toEqual({ tone: "warn", text: "1 of 2 repos match · 1 sets its own email" });
    expect(differingRepos(profile, false).map((r) => r.name)).toEqual(["infra"]);
  });

  it("still names a pinned repo when every repo uses the same other email", () => {
    const profile = work([repo("api", FROM_GLOBAL), repo("infra", { ...FROM_GLOBAL, source: "local" })]);
    expect(folderTally(profile).text).toBe(`All 2 repos commit as ${PERSONAL} · 1 sets its own email`);
  });

  it("leaves repos that only follow the global identity to the switch while it is off", () => {
    const profile = work([repo("api", FROM_GLOBAL)]);
    expect(folderTally(profile).text).toBe(`Its 1 repo commits as ${PERSONAL} · from /Users/rowan/.gitconfig`);
    expect(differingRepos(profile, false)).toEqual([]);
    expect(differingRepos(profile, true).map((r) => r.name)).toEqual(["api"]);
  });
});
