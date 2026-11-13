import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSystemGit } from "./test-support/system-git";
import { branchTips, listBranches, listRemoteBranchPage } from "./git-service";

/**
 * GitHub's merge queue pushes `gh-readonly-queue/<base>/pr-N-<sha>` branches
 * to the base repository and deletes them after the group merges. A fetch in
 * between brings them in as ordinary remote-tracking refs. They are the
 * queue's scratch space: never a branch to list, switch to, label or index.
 * Git is the oracle for the refs; the rule is that none of them surface.
 */
let dir: string;
const git = createSystemGit();
const sh = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
const QUEUE = "refs/remotes/origin/gh-readonly-queue/main/pr-7-0123456789abcdef0123456789abcdef01234567";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "pwrgit-mq-"));
  sh("init", "-q", "-b", "main");
  sh("config", "user.name", "t");
  sh("config", "user.email", "t@example.com");
  sh("commit", "-q", "--allow-empty", "-m", "one");
  sh("remote", "add", "origin", "https://example.invalid/o/r.git");
  const head = sh("rev-parse", "HEAD").trim();
  sh("update-ref", "refs/remotes/origin/main", head);
  sh("update-ref", "refs/remotes/origin/feature", head);
  sh("update-ref", QUEUE, head);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("merge-group refs", () => {
  it("git has the ref, and no branch list shows it", async () => {
    expect(sh("for-each-ref", "--format=%(refname)", "refs/remotes")).toContain("gh-readonly-queue");
    const branches = await listBranches(git, dir);
    expect(branches.ok && branches.value.map((b) => b.name)).toEqual(
      expect.arrayContaining(["main", "origin/main", "origin/feature"])
    );
    expect(branches.ok && branches.value.some((b) => b.name.includes("gh-readonly-queue"))).toBe(false);

    const tips = await branchTips(git, dir);
    expect(tips.ok && Object.values(tips.value.remote).flat().some((n) => n.includes("gh-readonly-queue")))
      .toBe(false);

    const page = await listRemoteBranchPage(git, dir, {});
    expect(page.ok && page.value.rows.map((b) => b.name)).not.toContain(
      "gh-readonly-queue/main/pr-7-0123456789abcdef0123456789abcdef01234567"
    );
  });
});
