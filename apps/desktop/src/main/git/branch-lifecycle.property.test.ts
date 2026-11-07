import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { ok } from "@pwrgit/shared";
import { deleteLocalBranch, deleteReviewedBranches, renameLocalBranch } from "./branch-lifecycle";
import { createSystemGit } from "./test-support/system-git";

const systemGit = createSystemGit();
const roots: string[] = [];
let template = "";
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}
beforeAll(() => {
  template = realpathSync(mkdtempSync(join(tmpdir(), "pwrgit-branch-template-")));
  git(template, "init", "-b", "main");
  git(template, "config", "user.name", "Test");
  git(template, "config", "user.email", "test@example.test");
  git(template, "config", "core.autocrlf", "false");
  git(template, "config", "gc.auto", "0");
  writeFileSync(join(template, "file"), "base\n");
  git(template, "add", ".");
  git(template, "commit", "-qm", "base");
  for (const branch of ["left", "right"]) {
    git(template, "switch", "-c", branch, "main");
    writeFileSync(join(template, "file"), `${branch}\n`);
    git(template, "commit", "-qam", branch);
  }
  git(template, "switch", "main");
});
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
afterAll(() => rmSync(template, { recursive: true, force: true }));

// Rule: relocating a primary repo without `worktree repair` must not change
// which unrelated refs can be mutated. Git's registered worktrees still own
// their branches, and a real conflicted merge must still block all mutations.
it("branch mutations preserve Git's worktree and operation guards after relocation", async () => {
  await fc.assert(fc.asyncProperty(
    fc.record({
      action: fc.constantFrom("rename", "delete", "force", "batch"),
      detached: fc.boolean(), busy: fc.boolean(), locked: fc.boolean(),
      packed: fc.boolean(), linkedCaller: fc.boolean()
    }),
    async ({ action, detached, busy, locked, packed, linkedCaller }) => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "pwrgit-branch-relocated-")));
      roots.push(root);
      const original = join(root, "original");
      cpSync(template, original, { recursive: true });
      git(original, "branch", "finished");
      const expectedHead = git(original, "rev-parse", "finished");
      const linked = join(root, "linked");
      git(original, "worktree", "add", ...(detached ? ["--detach"] : []), linked, "left");
      if (busy) {
        // Produce operation metadata through Git, rather than inventing it.
        expect(() => git(linked, "merge", "right")).toThrow();
        expect(git(linked, "rev-parse", "--verify", "MERGE_HEAD"))
          .toBe(git(original, "rev-parse", "right"));
      }
      if (locked) git(original, "worktree", "lock", linked);
      if (packed) git(original, "gc");
      const moved = join(root, "moved");
      renameSync(original, moved);
      let cwd = moved;
      if (linkedCaller) {
        cwd = join(root, "caller");
        git(moved, "worktree", "add", "--detach", cwd);
      }
      const listing = git(cwd, "worktree", "list", "--porcelain");
      expect(listing).not.toContain("prunable");
      const reviewed = { branch: "finished", expectedHead };
      const result = action === "rename"
        ? await renameLocalBranch(systemGit, cwd, reviewed, "renamed")
        : action === "batch"
          ? await deleteReviewedBranches(systemGit, cwd, [reviewed])
          : await deleteLocalBranch(systemGit, cwd, reviewed, action === "force");
      if (busy) {
        expect(!result.ok && result.error.code).toBe("operation_in_progress");
        expect(git(cwd, "rev-parse", "finished")).toBe(expectedHead);
      } else {
        expect(result.ok, JSON.stringify(result)).toBe(true);
        if (action === "batch" && result.ok) expect(result.value).toEqual(new Map([["finished", ok(undefined)]]));
        expect(git(cwd, "for-each-ref", "--format=%(refname)", "refs/heads/finished")).toBe("");
        if (action === "rename") expect(git(cwd, "rev-parse", "renamed")).toBe(expectedHead);
        if (!detached) {
          const held = await deleteReviewedBranches(systemGit, cwd, [{
            branch: "left", expectedHead: git(cwd, "rev-parse", "left")
          }]);
          expect(held.ok && held.value.get("left")).toMatchObject({
            ok: false, error: { code: "branch_checked_out" }
          });
        }
      }
      // No automatic repair, prune, or loss of worktree registrations.
      expect(git(cwd, "worktree", "list", "--porcelain")).toBe(listing);
    }
  ), { numRuns: process.platform === "win32" ? 10 : 25 });
});
