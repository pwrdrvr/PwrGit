import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { err, ok, TAG_PAGE_MAX, type Result } from "@pwrgit/shared";
import type { GitExec, GitOutput } from "./dugite";
import {
  applyRemoteTagPlan,
  createTagAt,
  deleteLocalTag,
  listTagPage,
  planRemoteTag,
  resolveTagTarget
} from "./git-service";

const roots: string[] = [];
const identity = { name: "Tag Tester", email: "tags@pwrgit.test" };

const systemGit: GitExec = (args, cwd) =>
  new Promise<Result<GitOutput>>((resolve) => {
    const proc = spawn("git", args, {
      cwd,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null"
      }
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (data: Buffer) => (stdout += data.toString()));
    proc.stderr.on("data", (data: Buffer) => (stderr += data.toString()));
    proc.on("close", (code) =>
      resolve(ok({ stdout, stderr, exitCode: code ?? 0 }))
    );
    proc.on("error", (cause) =>
      resolve(
        err({ kind: "git", code: "spawn_failed", message: cause.message })
      )
    );
  });

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function repo(): { root: string; path: string; first: string; second: string } {
  const root = mkdtempSync(join(tmpdir(), "pwrgit-tags-"));
  roots.push(root);
  const path = join(root, "repo");
  git(root, "init", "-b", "main", "repo");
  git(path, "config", "user.name", "Tag Tester");
  git(path, "config", "user.email", "tags@pwrgit.test");
  git(path, "config", "core.autocrlf", "false");
  writeFileSync(join(path, "first.txt"), "first\n");
  git(path, "add", ".");
  git(path, "commit", "-m", "first commit");
  const first = git(path, "rev-parse", "HEAD");
  writeFileSync(join(path, "second.txt"), "second\n");
  git(path, "add", ".");
  git(path, "commit", "-m", "second commit");
  return { root, path, first, second: git(path, "rev-parse", "HEAD") };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("local Git tags", () => {
  it("creates and lists lightweight and annotated tags with peeled metadata", async () => {
    const fixture = repo();
    const lightweight = await createTagAt(
      systemGit,
      fixture.path,
      {
        name: "v1.0-light",
        targetCommit: fixture.first,
        kind: "lightweight"
      },
      identity
    );
    expect(lightweight).toEqual(
      ok(
        expect.objectContaining({
          name: "v1.0-light",
          kind: "lightweight",
          objectId: fixture.first,
          objectType: "commit",
          targetId: fixture.first,
          targetType: "commit"
        })
      )
    );

    git(fixture.path, "config", "--unset-all", "user.name");
    git(fixture.path, "config", "--unset-all", "user.email");
    const annotated = await createTagAt(
      systemGit,
      fixture.path,
      {
        name: "v1.0",
        targetCommit: fixture.second,
        kind: "annotated",
        message: "Release 1.0\n\nShips the tag browser.\nWith pagination."
      },
      identity
    );
    expect(annotated.ok).toBe(true);
    if (!annotated.ok) return;
    expect(annotated.value).toMatchObject({
      name: "v1.0",
      kind: "annotated",
      objectType: "tag",
      targetId: fixture.second,
      targetType: "commit",
      annotation: {
        subject: "Release 1.0",
        body: "Ships the tag browser.\nWith pagination.",
        taggerName: "Tag Tester",
        taggerEmail: "tags@pwrgit.test"
      }
    });
    expect(annotated.value.objectId).not.toBe(fixture.second);

    const searched = await listTagPage(systemGit, fixture.path, {
      query: "pagination",
      limit: 10
    });
    expect(searched).toEqual(ok({ rows: [annotated.value], total: 1 }));
  });

  it("requires an explicit commit object id and an annotation message", async () => {
    const fixture = repo();
    const symbolic = await createTagAt(
      systemGit,
      fixture.path,
      {
        name: "symbolic",
        targetCommit: "HEAD",
        kind: "lightweight"
      },
      identity
    );
    expect(symbolic.ok).toBe(false);
    expect(!symbolic.ok && symbolic.error.code).toBe("invalid_target_commit");

    const prefix = fixture.first.slice(0, 7);
    git(fixture.path, "branch", prefix, fixture.second);
    const shadowed = await createTagAt(
      systemGit,
      fixture.path,
      {
        name: "shadowed-prefix",
        targetCommit: prefix,
        kind: "lightweight"
      },
      identity
    );
    expect(shadowed.ok && shadowed.value.targetId).toBe(fixture.first);

    const blank = await createTagAt(
      systemGit,
      fixture.path,
      {
        name: "blank",
        targetCommit: fixture.second,
        kind: "annotated",
        message: "   "
      },
      identity
    );
    expect(blank.ok).toBe(false);
    expect(!blank.ok && blank.error.code).toBe("annotation_required");
  });

  it("deletes only the exact local object that was confirmed", async () => {
    const fixture = repo();
    git(fixture.path, "tag", "release", fixture.first);
    const reviewed = git(fixture.path, "rev-parse", "refs/tags/release");
    git(fixture.path, "tag", "--force", "release", fixture.second);

    const stale = await deleteLocalTag(
      systemGit,
      fixture.path,
      "release",
      reviewed
    );
    expect(stale.ok).toBe(false);
    expect(git(fixture.path, "rev-parse", "refs/tags/release")).toBe(
      fixture.second
    );

    const deleted = await deleteLocalTag(
      systemGit,
      fixture.path,
      "release",
      fixture.second
    );
    expect(deleted).toEqual(ok(undefined));
    expect(git(fixture.path, "tag", "--list", "release")).toBe("");
  });

  it("searches and pages thousands of tags while bounding every response", async () => {
    const fixture = repo();
    const updates = Array.from(
      { length: 1_500 },
      (_, index) =>
        `create refs/tags/build/${String(index).padStart(4, "0")} ${fixture.second}`
    ).join("\n");
    execFileSync("git", ["update-ref", "--stdin"], {
      cwd: fixture.path,
      input: `${updates}\n`,
      encoding: "utf8"
    });

    const firstPage = await listTagPage(systemGit, fixture.path, {
      offset: 0,
      limit: TAG_PAGE_MAX + 500
    });
    expect(firstPage.ok).toBe(true);
    if (firstPage.ok) {
      expect(firstPage.value.total).toBe(1_500);
      expect(firstPage.value.rows).toHaveLength(TAG_PAGE_MAX);
    }
    const laterPage = await listTagPage(systemGit, fixture.path, {
      offset: 1_200,
      limit: 50
    });
    expect(laterPage.ok).toBe(true);
    if (laterPage.ok) {
      expect(laterPage.value.total).toBe(1_500);
      expect(laterPage.value.rows).toHaveLength(50);
    }

    const searched = await listTagPage(systemGit, fixture.path, {
      query: "build/1499",
      limit: 50
    });
    expect(searched.ok).toBe(true);
    if (searched.ok) {
      expect(searched.value.total).toBe(1);
      expect(searched.value.rows[0]?.name).toBe("build/1499");
    }
  });
});

describe("reviewed remote Git tag actions", () => {
  it("lease-protects creation and deletion and never overwrites a tag", async () => {
    const fixture = repo();
    const bare = join(fixture.root, "origin.git");
    git(fixture.root, "init", "--bare", "origin.git");
    git(fixture.path, "remote", "add", "origin", bare);
    git(fixture.path, "config", "push.followTags", "true");
    git(fixture.path, "tag", "release", fixture.first);
    git(
      fixture.path,
      "tag",
      "--annotate",
      "--message",
      "Must stay local",
      "unrelated",
      fixture.first
    );

    const pushPlan = await planRemoteTag(systemGit, fixture.path, {
      name: "release",
      remote: "origin",
      action: "push"
    });
    expect(pushPlan.ok).toBe(true);
    if (!pushPlan.ok) return;
    expect(pushPlan.value).toMatchObject({
      action: "push",
      status: "create",
      localObjectId: fixture.first
    });
    const pushed = await applyRemoteTagPlan(
      systemGit,
      fixture.path,
      pushPlan.value
    );
    expect(pushed).toEqual(
      ok({
        action: "push",
        remote: "origin",
        tagName: "release",
        outcome: "pushed"
      })
    );
    expect(git(fixture.path, "ls-remote", "--tags", "origin", "refs/tags/release")).toContain(
      fixture.first
    );
    expect(
      git(fixture.path, "ls-remote", "--tags", "origin", "refs/tags/unrelated")
    ).toBe("");

    const equal = await planRemoteTag(systemGit, fixture.path, {
      name: "release",
      remote: "origin",
      action: "push"
    });
    expect(equal.ok && equal.value.status).toBe("equal");

    const deletePlan = await planRemoteTag(systemGit, fixture.path, {
      name: "release",
      remote: "origin",
      action: "delete"
    });
    expect(deletePlan.ok).toBe(true);
    if (!deletePlan.ok) return;

    // Change the remote after review. Apply must stop before deleting it.
    git(fixture.path, "tag", "remote-replacement", fixture.second);
    git(
      fixture.path,
      "push",
      "--no-follow-tags",
      "--force",
      "origin",
      "refs/tags/remote-replacement:refs/tags/release"
    );
    const staleDelete = await applyRemoteTagPlan(
      systemGit,
      fixture.path,
      deletePlan.value
    );
    expect(staleDelete.ok).toBe(false);
    expect(!staleDelete.ok && staleDelete.error.code).toBe(
      "remote_tag_changed"
    );
    expect(git(fixture.path, "ls-remote", "--tags", "origin", "refs/tags/release")).toContain(
      fixture.second
    );

    const conflict = await planRemoteTag(systemGit, fixture.path, {
      name: "release",
      remote: "origin",
      action: "push"
    });
    expect(conflict.ok).toBe(false);
    expect(!conflict.ok && conflict.error.code).toBe("remote_tag_conflict");

    const freshDelete = await planRemoteTag(systemGit, fixture.path, {
      name: "release",
      remote: "origin",
      action: "delete"
    });
    expect(freshDelete.ok).toBe(true);
    if (!freshDelete.ok) return;
    const deleted = await applyRemoteTagPlan(
      systemGit,
      fixture.path,
      freshDelete.value
    );
    expect(deleted.ok && deleted.value.outcome).toBe("deleted");
    expect(git(fixture.path, "ls-remote", "--tags", "origin", "refs/tags/release")).toBe(
      ""
    );
    expect(
      git(fixture.path, "ls-remote", "--tags", "origin", "refs/tags/unrelated")
    ).toBe("");
  }, 20_000);

  it("reviews and mutates the configured push endpoint, not the fetch URL", async () => {
    const fixture = repo();
    const fetchBare = join(fixture.root, "fetch.git");
    const pushBare = join(fixture.root, "push.git");
    git(fixture.root, "init", "--bare", "fetch.git");
    git(fixture.root, "init", "--bare", "push.git");
    git(fixture.path, "remote", "add", "origin", fetchBare);
    git(fixture.path, "remote", "set-url", "--push", "origin", pushBare);
    git(fixture.path, "tag", "release", fixture.first);
    git(
      fixture.path,
      "push",
      fetchBare,
      "refs/tags/release:refs/tags/release"
    );

    const pushPlan = await planRemoteTag(systemGit, fixture.path, {
      name: "release",
      remote: "origin",
      action: "push"
    });
    expect(pushPlan.ok).toBe(true);
    if (!pushPlan.ok) return;
    expect(pushPlan.value).toMatchObject({
      pushUrl: pushBare,
      status: "create"
    });
    const pushed = await applyRemoteTagPlan(
      systemGit,
      fixture.path,
      pushPlan.value
    );
    expect(pushed.ok && pushed.value.outcome).toBe("pushed");
    expect(
      git(fixture.path, "ls-remote", "--tags", pushBare, "refs/tags/release")
    ).toContain(fixture.first);

    const deletePlan = await planRemoteTag(systemGit, fixture.path, {
      name: "release",
      remote: "origin",
      action: "delete"
    });
    expect(deletePlan.ok).toBe(true);
    if (!deletePlan.ok) return;
    const deleted = await applyRemoteTagPlan(
      systemGit,
      fixture.path,
      deletePlan.value
    );
    expect(deleted.ok && deleted.value.outcome).toBe("deleted");
    expect(
      git(fixture.path, "ls-remote", "--tags", pushBare, "refs/tags/release")
    ).toBe("");
    expect(
      git(fixture.path, "ls-remote", "--tags", fetchBare, "refs/tags/release")
    ).toContain(fixture.first);
  });
});

describe("resolveTagTarget", () => {
  it("resolves a branch to the commit it points at right now", async () => {
    const fixture = repo();
    const result = await resolveTagTarget(systemGit, fixture.path, "main");
    expect(result).toEqual(
      ok({
        commitId: fixture.second,
        shortId: fixture.second.slice(0, 7),
        subject: "second commit",
        authorName: "Tag Tester",
        committedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        resolvedFrom: "main"
      })
    );
  });

  it("resolves HEAD and revision expressions", async () => {
    const fixture = repo();
    await expect(
      resolveTagTarget(systemGit, fixture.path, "HEAD")
    ).resolves.toEqual(ok(expect.objectContaining({ commitId: fixture.second })));
    await expect(
      resolveTagTarget(systemGit, fixture.path, "HEAD~1")
    ).resolves.toEqual(ok(expect.objectContaining({ commitId: fixture.first })));
  });

  it("peels an annotated tag through to its commit", async () => {
    const fixture = repo();
    git(fixture.path, "tag", "-a", "-m", "release", "v1.0", fixture.first);
    const result = await resolveTagTarget(systemGit, fixture.path, "v1.0");
    expect(result).toEqual(
      ok(expect.objectContaining({ commitId: fixture.first }))
    );
  });

  it("omits resolvedFrom when the input was already an object id", async () => {
    const fixture = repo();
    const result = await resolveTagTarget(systemGit, fixture.path, fixture.first);
    expect(result.ok && result.value.commitId).toBe(fixture.first);
    expect(result.ok && "resolvedFrom" in result.value).toBe(false);
  });

  it("prefers the object database for a hex input, like createTagAt does", async () => {
    const fixture = repo();
    // A branch whose name is the short id of a DIFFERENT commit. Resolving the
    // input as a revision would follow the ref; both this and createTagAt must
    // read it as the object, or the dialog would confirm one commit and the
    // create would land on another.
    const decoy = fixture.second.slice(0, 8);
    git(fixture.path, "branch", decoy, fixture.first);
    const result = await resolveTagTarget(systemGit, fixture.path, decoy);
    expect(result).toEqual(
      ok(expect.objectContaining({ commitId: fixture.second }))
    );
  });

  it("rejects an unknown revision, a tree, and an option-looking input", async () => {
    const fixture = repo();
    const tree = git(fixture.path, "rev-parse", "HEAD^{tree}");
    for (const input of ["no-such-branch", tree, "--output=/tmp/x", ""]) {
      const result = await resolveTagTarget(systemGit, fixture.path, input);
      expect(result.ok).toBe(false);
    }
  });
});
