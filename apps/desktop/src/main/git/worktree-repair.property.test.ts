import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { CommandBus } from "../command-bus";
import { openDatabase } from "../persistence/db";
import type { RepoIndexer } from "./repo-indexer";
import { registerMaintenanceHandlers } from "./maintenance-handlers";
import { WorktreeOperationQueue } from "./worktree-operation-queue";
import { createSystemGit } from "./test-support/system-git";

vi.mock("../ipc", () => ({ emitEvent: vi.fn() }));
vi.mock("../logs", () => ({ logMain: vi.fn() }));
const systemGit = createSystemGit();
let template = "";
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}
beforeAll(() => {
  template = realpathSync(mkdtempSync(join(tmpdir(), "pwrgit-repair-template-")));
  git(template, "init", "-b", "main");
  git(template, "config", "user.name", "Test");
  git(template, "config", "user.email", "test@example.test");
  git(template, "config", "core.autocrlf", "false");
  git(template, "config", "gc.auto", "0");
  writeFileSync(join(template, "tracked"), "base\n");
  writeFileSync(join(template, ".gitignore"), "ignored\n");
  git(template, "add", ".");
  git(template, "commit", "-qm", "base");
});
afterAll(() => rmSync(template, { recursive: true, force: true }));

// Oracle: after a primary repo moves, every surviving registered checkout
// resolves back to its own object store. Repair preserves refs, checkout
// contents, index bytes, missing/locked registrations, and the other profile.
// Repeating repair must leave all of those observations unchanged.
it("maintenance repair reconnects moved repositories without changing work or another profile", async () => {
  await fc.assert(fc.asyncProperty(fc.record({
    detached: fc.boolean(), locked: fc.boolean(), packed: fc.boolean(),
    missing: fc.boolean(), linkedCaller: fc.boolean()
  }), async ({ detached, locked, packed, missing, linkedCaller }) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "pwrgit-repair-oracle-")));
    const db = openDatabase(":memory:");
    try {
      const repos: { moved: string; linked: string; status: string; index: Buffer; refs: string; listing: string }[] = [];
      for (const profile of ["one", "two"]) {
        const original = join(root, profile);
        cpSync(template, original, { recursive: true });
        const linked = join(root, `${profile}-linked`);
        git(original, "branch", "topic");
        git(original, "worktree", "add", ...(detached ? ["--detach"] : []), linked, "topic");
        writeFileSync(join(linked, "tracked"), "staged\n");
        git(linked, "add", "tracked");
        writeFileSync(join(linked, "tracked"), "unstaged\n");
        writeFileSync(join(linked, "untracked"), "keep untracked\n");
        writeFileSync(join(linked, "ignored"), "keep ignored\n");
        if (locked) git(original, "worktree", "lock", linked);
        if (packed) git(original, "gc");
        const status = git(linked, "status", "--porcelain", "--ignored");
        const index = readFileSync(join(git(linked, "rev-parse", "--absolute-git-dir"), "index"));
        if (missing) {
          const gone = join(root, `${profile}-gone`);
          git(original, "worktree", "add", "--detach", gone);
          rmSync(gone, { recursive: true, force: true });
        }
        const moved = join(root, `${profile}-moved`);
        renameSync(original, moved);
        db.prepare("INSERT INTO profiles (id, name, email) VALUES (?, ?, ?)").run(profile, profile, `${profile}@example.test`);
        let cwd = moved;
        if (linkedCaller && profile === "one") {
          cwd = join(root, "caller");
          git(moved, "worktree", "add", "--detach", cwd);
        }
        db.prepare("INSERT INTO repos (id, profile_id, name, path) VALUES (?, ?, ?, ?)").run(profile, profile, profile, cwd);
        repos.push({ moved, linked, status, index, refs: git(moved, "show-ref"), listing: git(moved, "worktree", "list", "--porcelain") });
      }
      const [selected, other] = repos as [typeof repos[number], typeof repos[number]];
      const otherLink = readFileSync(join(other.linked, ".git"), "utf8");
      const bus = new CommandBus();
      registerMaintenanceHandlers(bus, db, systemGit, new WorktreeOperationQueue(), {} as RepoIndexer);
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await bus.dispatch("maintenance:run", {
          operationId: `repair-${attempt}`, profileId: "one",
          action: { kind: "repair-worktrees" }
        });
        expect(result.ok && result.value.results.map((row) => row.outcome), JSON.stringify(result)).toEqual(["success"]);
        expect(git(selected.linked, "rev-parse", "--path-format=absolute", "--git-common-dir"))
          .toBe(join(selected.moved, ".git").replaceAll("\\", "/"));
        expect(readFileSync(join(git(selected.linked, "rev-parse", "--absolute-git-dir"), "index"))).toEqual(selected.index);
        expect(git(selected.linked, "status", "--porcelain", "--ignored")).toBe(selected.status);
        for (const [file, content] of [["tracked", "unstaged\n"], ["untracked", "keep untracked\n"], ["ignored", "keep ignored\n"]])
          expect(readFileSync(join(selected.linked, file!), "utf8")).toBe(content);
        expect(git(selected.moved, "show-ref")).toBe(selected.refs);
        expect(git(selected.moved, "worktree", "list", "--porcelain")).toBe(selected.listing);
        expect(readFileSync(join(other.linked, ".git"), "utf8")).toBe(otherLink);
        expect(git(other.moved, "show-ref")).toBe(other.refs);
        expect(git(other.moved, "worktree", "list", "--porcelain")).toBe(other.listing);
      }
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  }), { numRuns: process.platform === "win32" ? 5 : 12 });
});
