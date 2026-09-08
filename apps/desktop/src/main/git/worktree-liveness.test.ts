import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../persistence/db";
import {
  checkoutExists,
  liveWorktreePath,
  missingWorktreeError,
  WORKTREE_MISSING_CODE
} from "./worktree-liveness";

describe("checkoutExists", () => {
  it("is git's own test: the .git link inside the worktree", () => {
    const root = mkdtempSync(join(tmpdir(), "pwrgit-liveness-"));
    const linked = join(root, "linked");
    mkdirSync(linked);
    expect(checkoutExists(linked)).toBe(false);
    writeFileSync(join(linked, ".git"), "gitdir: /repo/.git/worktrees/linked\n");
    expect(checkoutExists(linked)).toBe(true);
    rmSync(linked, { recursive: true, force: true });
    expect(checkoutExists(linked)).toBe(false);
  });
});

describe("the worktree_missing guard", () => {
  const seed = () => {
    const db = openDatabase(":memory:");
    db.prepare(
      "INSERT INTO profiles (id, name, email) VALUES ('p', 'P', 'p@x.com')"
    ).run();
    db.prepare(
      "INSERT INTO repos (id, profile_id, name, path) VALUES ('r', 'p', 'r', '/repos/r')"
    ).run();
    const insert = db.prepare(
      `INSERT INTO worktrees (id, repo_id, branch, path, is_primary, missing)
       VALUES (?, 'r', ?, ?, ?, ?)`
    );
    insert.run("live", "main", "/repos/r", 1, 0);
    insert.run("gone", "feat", "/repos/r-wt/feat", 0, 1);
    return db;
  };

  it("reads only the index flag, so a stubbed path is never mistaken for a deleted checkout", () => {
    const db = seed();
    expect(missingWorktreeError(db, "live")).toBeNull();
    expect(missingWorktreeError(db, "gone")).toMatchObject({
      kind: "repo",
      code: WORKTREE_MISSING_CODE
    });
    expect(missingWorktreeError(db, "gone")?.message).toContain(
      "/repos/r-wt/feat"
    );
    // An unknown id is the handler's own not-found answer, not this guard's.
    expect(missingWorktreeError(db, "nope")).toBeNull();
  });

  it("resolves a path for git only while the checkout is there", () => {
    const db = seed();
    expect(liveWorktreePath(db, "live")).toEqual({ ok: true, value: "/repos/r" });
    const gone = liveWorktreePath(db, "gone");
    expect(gone.ok).toBe(false);
    if (gone.ok) return;
    expect(gone.error.code).toBe(WORKTREE_MISSING_CODE);
    const unknown = liveWorktreePath(db, "nope");
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.error.code).toBe("not_found");
  });
});
