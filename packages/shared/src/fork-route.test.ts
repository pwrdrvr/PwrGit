import { describe, expect, it } from "vitest";
import { routedRemotes, trackedRemoteName } from "./fork-route";
import type { RepoIdentity } from "./types";

const fork: RepoIdentity = {
  host: "github",
  hostname: "github.com",
  owner: "riverbend",
  name: "sparkline",
  nameWithOwner: "riverbend/sparkline",
  visibility: "public",
  viewerCanPush: true,
  parent: { nameWithOwner: "octo-labs/sparkline", url: "https://github.com/octo-labs/sparkline" }
};

const remote = (name: string, slug: string, pushSlug = slug) => ({
  name,
  fetchUrl: `git@github.com:${slug}.git`,
  pushUrl: `git@github.com:${pushSlug}.git`
});

describe("routedRemotes", () => {
  it("names the fork and its parent by URL, not by nickname", () => {
    const rows = routedRemotes(fork, [
      remote("origin", "riverbend/sparkline"),
      remote("upstream", "octo-labs/sparkline"),
      remote("lumen", "lumen-co/sparkline")
    ]);
    expect(rows).toEqual([
      { name: "origin", nameWithOwner: "riverbend/sparkline", role: "fork", canPush: true },
      { name: "upstream", nameWithOwner: "octo-labs/sparkline", role: "original" },
      { name: "lumen", nameWithOwner: "lumen-co/sparkline", role: "other" }
    ]);
  });

  it("does not call a remote the original because it is named upstream", () => {
    const rows = routedRemotes(fork, [
      remote("origin", "riverbend/sparkline"),
      remote("upstream", "someone-else/sparkline")
    ]);
    expect(rows[1]).toMatchObject({ name: "upstream", role: "other" });
  });

  it("finds the parent under any nickname", () => {
    const rows = routedRemotes(fork, [
      remote("origin", "riverbend/sparkline"),
      remote("octo", "octo-labs/sparkline")
    ]);
    expect(rows[1]).toMatchObject({ name: "octo", role: "original" });
  });

  it("calls a repository you can't push to, with no parent, the original", () => {
    const readOnly: RepoIdentity = {
      ...fork, owner: "octo-labs", nameWithOwner: "octo-labs/sparkline", viewerCanPush: false
    };
    delete (readOnly as { parent?: unknown }).parent;
    expect(routedRemotes(readOnly, [remote("origin", "octo-labs/sparkline")])).toEqual([
      { name: "origin", nameWithOwner: "octo-labs/sparkline", role: "original", canPush: false }
    ]);
  });

  it("trusts nothing once origin points somewhere else", () => {
    const rows = routedRemotes(fork, [
      remote("origin", "lumen-co/sparkline"),
      remote("upstream", "octo-labs/sparkline")
    ]);
    expect(rows.map((row) => row.role)).toEqual(["other", "other"]);
    expect(rows[0]).not.toHaveProperty("canPush");
  });

  it("withholds the push answer when pushes go somewhere else", () => {
    const rows = routedRemotes(fork, [remote("origin", "riverbend/sparkline", "lumen-co/sparkline")]);
    expect(rows[0]).toEqual({ name: "origin", nameWithOwner: "riverbend/sparkline", role: "fork" });
  });

  it("labels nothing without an identity, but still reads the slug", () => {
    expect(routedRemotes(undefined, [remote("origin", "riverbend/sparkline")])).toEqual([
      { name: "origin", nameWithOwner: "riverbend/sparkline", role: "other" }
    ]);
    expect(routedRemotes(undefined, [{ name: "nas", fetchUrl: "/srv/git/repo.git", pushUrl: "/srv/git/repo.git" }]))
      .toEqual([{ name: "nas", nameWithOwner: null, role: "other" }]);
  });
});

describe("trackedRemoteName", () => {
  it("takes the longest nickname the ref starts with", () => {
    const remotes = [{ name: "team" }, { name: "team/upstream" }, { name: "origin" }];
    expect(trackedRemoteName("team/upstream/main", remotes)).toBe("team/upstream");
    expect(trackedRemoteName("origin/main", remotes)).toBe("origin");
    expect(trackedRemoteName("gone/main", remotes)).toBeNull();
    expect(trackedRemoteName(undefined, remotes)).toBeNull();
  });
});
