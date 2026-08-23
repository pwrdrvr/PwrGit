import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type DB } from "../persistence/db";
import {
  ProfileScanCoordinator,
  survivingActiveWorktreeId
} from "./profile-runtime";

describe("profile deletion runtime cleanup", () => {
  const databases: DB[] = [];

  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
  });

  it("does not let an old scan completion release a replacement scan", () => {
    const scans = new ProfileScanCoordinator();
    const deleted = scans.begin("acme");
    expect(deleted).not.toBeNull();
    if (deleted === null) return;

    scans.abort("acme");
    expect(deleted.aborted).toBe(true);

    const replacement = scans.begin("acme");
    expect(replacement).not.toBeNull();
    scans.finish("acme", deleted);

    // The deleted scan's finally handler must not remove the new entry.
    expect(scans.begin("acme")).toBeNull();
    if (replacement !== null) scans.finish("acme", replacement);
    expect(scans.begin("acme")).not.toBeNull();
  });

  it("preserves a surviving profile's selected worktree", () => {
    const db = openDatabase(":memory:");
    databases.push(db);
    db.prepare(
      `INSERT INTO profiles (id, name, email)
       VALUES ('deleted', 'Deleted', 'deleted@example.com'),
              ('kept', 'Kept', 'kept@example.com')`
    ).run();
    db.prepare(
      `INSERT INTO repos (id, profile_id, name, path)
       VALUES ('deleted-repo', 'deleted', 'deleted', '/deleted'),
              ('kept-repo', 'kept', 'kept', '/kept')`
    ).run();
    db.prepare(
      `INSERT INTO worktrees (id, repo_id, branch, path)
       VALUES ('deleted-wt', 'deleted-repo', 'main', '/deleted'),
              ('kept-wt', 'kept-repo', 'main', '/kept')`
    ).run();

    db.prepare("DELETE FROM profiles WHERE id = 'deleted'").run();

    expect(survivingActiveWorktreeId(db, "kept-wt")).toBe("kept-wt");
    expect(survivingActiveWorktreeId(db, "deleted-wt")).toBeNull();
  });
});
