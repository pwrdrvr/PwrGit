import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { forkTrackingCandidates, forkTrackingRepair, type RepoIdentity } from "@pwrgit/shared";
import { createSystemGit } from "./test-support/system-git";
import { inspectForkTracking, repairForkTracking } from "./fork-tracking";
import { resolveForkStatus } from "./git-service";

const systemGit = createSystemGit();
const identity: RepoIdentity = {
  host: "github", hostname: "github.com", name: "widget", owner: "me",
  nameWithOwner: "me/widget", visibility: "public",
  parent: { nameWithOwner: "team/widget", url: "https://github.com/team/widget" }
};
let path: string;
const git = (...args: string[]) => execFileSync("git", ["-C", path, ...args], { encoding: "utf8" }).trim();
const reviewed = { branch: "main", upstream: "upstream/main" };
const repair = { ...reviewed, upstreamRemote: "upstream", target: "origin/main" };
const inspected = {
  offer: { ...repair, parent: "team/widget", targets: [{ remote: "origin", nameWithOwner: "me/widget", ref: "origin/main" }] },
  candidates: []
};

beforeEach(() => {
  path = mkdtempSync(join(tmpdir(), "pwrgit-fork-tracking-"));
  git("init", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  git("config", "core.autocrlf", "false");
  writeFileSync(join(path, "file.txt"), "base\n");
  git("add", "file.txt");
  git("commit", "-m", "base");
  git("remote", "add", "origin", "git@github.com:team/widget.git");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  git("branch", "--set-upstream-to=origin/main", "main");
  // The sequence that produced the user's setup: Git moves tracking too.
  git("remote", "rename", "origin", "upstream");
  git("remote", "add", "origin", "git@github.com:me/widget.git");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
});
afterEach(() => rmSync(path, { recursive: true, force: true }));

describe("repairing a pre-existing fork after renaming origin", () => {
  it("keeps fork status available for Pull when a remote rename made main track the parent", async () => {
    expect(git("rev-parse", "--abbrev-ref", "@{u}")).toBe("upstream/main");
    expect(await inspectForkTracking(systemGit, path, identity)).toEqual({
      ok: true, value: inspected
    });
    const status = await resolveForkStatus(systemGit, path, {
      hostname: identity.hostname, nameWithOwner: identity.parent!.nameWithOwner
    }, identity);
    expect(status).toMatchObject({ ok: true, value: {
      branch: "main", source: null,
      tracked: { label: "upstream/main" },
      trackingRepair: repair
    } });
    await repairForkTracking(systemGit, path, identity, reviewed);
    const repaired = await resolveForkStatus(systemGit, path, {
      hostname: identity.hostname, nameWithOwner: identity.parent!.nameWithOwner
    }, identity);
    expect(repaired).toMatchObject({ ok: true, value: {
      source: { remote: "upstream" }, tracked: { label: "origin/main" }
    } });
    expect(repaired.ok && repaired.value).not.toHaveProperty("trackingRepair");
  });
  it("does not offer or apply tracking repair for a confirmed read-only fork", async () => {
    const readOnly = { ...identity, viewerCanPush: false };
    const before = git("config", "--local", "--list");
    expect(await inspectForkTracking(systemGit, path, readOnly)).toEqual({ ok: true, value: null });
    expect((await repairForkTracking(systemGit, path, readOnly, reviewed)).ok).toBe(false);
    expect(git("config", "--local", "--list")).toBe(before);
  });

  it("inspects main literally when a tag is also named main", async () => {
    git("tag", "main");
    expect(await inspectForkTracking(systemGit, path, identity)).toEqual({
      ok: true, value: inspected
    });
  });

  it("repairs unchanged main when a tag is also named main", async () => {
    git("tag", "main");
    const head = git("rev-parse", "HEAD");
    expect(await repairForkTracking(systemGit, path, identity, reviewed)).toEqual({ ok: true, value: null });
    expect(git("rev-parse", "--symbolic-full-name", "@{u}")).toBe("refs/remotes/origin/main");
    expect(git("rev-parse", "HEAD")).toBe(head);
    expect(git("rev-parse", "refs/tags/main")).toBe(head);
  });

  it("restores fork tracking and sync status without moving commits or losing edits", async () => {
    writeFileSync(join(path, "file.txt"), "local edit\n");
    const head = git("rev-parse", "HEAD");
    expect(await resolveForkStatus(systemGit, path, { hostname: identity.hostname, nameWithOwner: identity.parent!.nameWithOwner })).toEqual({ ok: true, value: null });
    expect(await repairForkTracking(systemGit, path, identity, reviewed)).toEqual({ ok: true, value: null });
    expect(git("rev-parse", "--abbrev-ref", "@{u}")).toBe("origin/main");
    expect(git("rev-parse", "HEAD")).toBe(head);
    expect(git("rev-parse", "origin/main")).toBe(head);
    expect(git("rev-parse", "upstream/main")).toBe(head);
    expect(readFileSync(join(path, "file.txt"), "utf8")).toBe("local edit\n");
    const status = await resolveForkStatus(systemGit, path, { hostname: identity.hostname, nameWithOwner: identity.parent!.nameWithOwner });
    expect(status.ok && status.value?.source?.remote).toBe("upstream");
  });

  it.each(["branch", "tracking", "origin", "parent", "push", "pushDefault", "pushurl", "missing", "unknown"])("refuses a changed %s before writing config", async (change) => {
    if (change === "branch") git("switch", "-c", "other");
    if (change === "tracking") git("branch", "--set-upstream-to=origin/main", "main");
    if (change === "origin") git("remote", "set-url", "origin", "git@github.com:stranger/widget.git");
    if (change === "parent") git("remote", "set-url", "upstream", "git@another.invalid:team/widget.git");
    if (change === "push") git("config", "branch.main.pushRemote", "upstream");
    if (change === "pushDefault") git("config", "remote.pushDefault", "upstream");
    if (change === "pushurl") {
      git("config", "--add", "remote.origin.pushurl", "git@github.com:me/widget.git");
      git("config", "--add", "remote.origin.pushurl", "git@github.com:team/widget.git");
    }
    if (change === "missing") git("update-ref", "-d", "refs/remotes/origin/main");
    const before = git("config", "--local", "--list");
    const result = await repairForkTracking(systemGit, path, change === "unknown" ? undefined : identity, reviewed);
    expect(result.ok).toBe(false);
    expect(git("config", "--local", "--list")).toBe(before);
  });

  it("does not mistake a similarly named remote or stale identity for the fork", () => {
    const remotes = [
      { name: "origin", fetchUrl: "git@github.com:me/widget.git", pushUrl: "git@github.com:me/widget.git" },
      { name: "upstream", fetchUrl: "git@github.com:team/widget.git", pushUrl: "git@github.com:team/widget.git" }
    ];
    expect(forkTrackingRepair(identity, remotes, { name: "main", upstream: "upstream/main" })).toEqual(repair);
    expect(forkTrackingRepair(identity, remotes, { name: "main", upstream: "origin/main" })).toBeNull();
    expect(forkTrackingRepair(undefined, remotes, { name: "main", upstream: "upstream/main" })).toBeNull();
    remotes[0]!.pushUrl = "git@github.com:team/widget.git";
    expect(forkTrackingRepair(identity, remotes, { name: "main", upstream: "upstream/main" })).toBeNull();
  });
  describe("another fork you can push to", () => {
    beforeEach(() => {
      git("remote", "add", "lumen", "git@github.com:lumen-co/widget.git");
      git("update-ref", "refs/remotes/lumen/main", "HEAD");
    });
    const lumen = { remote: "lumen", nameWithOwner: "lumen-co/widget" };

    it("lists it as a candidate for the forge to confirm, never as a target", async () => {
      expect(await inspectForkTracking(systemGit, path, identity)).toEqual({
        ok: true,
        value: { ...inspected, candidates: [{ ...lumen, ref: "lumen/main" }] }
      });
    });

    it("tracks the chosen fork, and only the branch's tracking moves", async () => {
      const head = git("rev-parse", "HEAD");
      expect(await repairForkTracking(systemGit, path, identity, { ...reviewed, target: lumen }))
        .toEqual({ ok: true, value: null });
      expect(git("rev-parse", "--abbrev-ref", "@{u}")).toBe("lumen/main");
      expect(git("rev-parse", "HEAD")).toBe(head);
    });

    it.each(["repointed", "parent", "upstream", "pushRemote", "missing"])("refuses a %s choice before writing config", async (change) => {
      let target = lumen;
      if (change === "repointed") git("remote", "set-url", "lumen", "git@github.com:stranger/widget.git");
      if (change === "parent") {
        git("remote", "set-url", "lumen", "git@github.com:team/widget.git");
        target = { remote: "lumen", nameWithOwner: "team/widget" };
      }
      if (change === "upstream") target = { remote: "upstream", nameWithOwner: "team/widget" };
      if (change === "pushRemote") git("config", "branch.main.pushRemote", "origin");
      if (change === "missing") git("update-ref", "-d", "refs/remotes/lumen/main");
      const before = git("config", "--local", "--list");
      const result = await repairForkTracking(systemGit, path, identity, { ...reviewed, target });
      expect(result.ok).toBe(false);
      expect(git("config", "--local", "--list")).toBe(before);
      if (change === "missing") {
        expect(!result.ok && result.error.message).toContain("Fetch lumen first");
      }
    });

    it("refuses origin reviewed as some other repository", async () => {
      const result = await repairForkTracking(systemGit, path, identity, {
        ...reviewed, target: { remote: "origin", nameWithOwner: "lumen-co/widget" }
      });
      expect(result.ok).toBe(false);
      expect(git("rev-parse", "--abbrev-ref", "@{u}")).toBe("upstream/main");
    });
  });

  it("offers only remotes on the fork's host that fetch and push to one other repository", () => {
    const remote = (name: string, fetchUrl: string, pushUrl = fetchUrl) => ({ name, fetchUrl, pushUrl });
    expect(forkTrackingCandidates(identity, [
      remote("origin", "git@github.com:me/widget.git"),
      remote("upstream", "git@github.com:team/widget.git"),
      remote("lumen", "git@github.com:lumen-co/widget.git"),
      // A second nickname for the same repository is one choice.
      remote("lumen2", "https://github.com/Lumen-Co/widget.git"),
      // The parent again, under another name, is not a fork.
      remote("canonical", "git@github.com:team/widget.git"),
      remote("mirror", "git@gitlab.com:lumen-co/widget.git"),
      remote("split", "git@github.com:a/widget.git", "git@github.com:b/widget.git"),
      remote("nas", "ssh://nas.local/widget.git")
    ], repair)).toEqual([{ remote: "lumen", nameWithOwner: "lumen-co/widget", ref: "lumen/main" }]);
  });
});
