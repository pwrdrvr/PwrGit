import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../persistence/db";
import { ProfileService } from "./profile-service";

describe("profile deletion persistence", () => {
  it("clears owned indexes and selections without touching repositories on disk", () => {
    const root = mkdtempSync(join(tmpdir(), "pwrgit-profile-delete-"));
    const deletedRepoPath = join(root, "deleted-profile-repo");
    mkdirSync(deletedRepoPath);
    const sentinel = join(deletedRepoPath, "keep-me.txt");
    writeFileSync(sentinel, "repository data stays on disk\n");

    const db = openDatabase(":memory:");
    try {
      const profiles = new ProfileService(db);
      const removed = profiles.create({
        name: "Remove me",
        email: "remove@example.com",
        roots: [root]
      });
      const kept = profiles.create({ name: "Keep me", email: "keep@example.com" });

      db.prepare(
        `INSERT INTO repos (id, profile_id, name, path, source)
         VALUES (?, ?, ?, ?, 'manual'), (?, ?, ?, ?, 'manual')`
      ).run(
        "repo-removed",
        removed.id,
        "removed",
        deletedRepoPath,
        "repo-kept",
        kept.id,
        "kept",
        join(root, "kept-profile-repo")
      );
      db.prepare(
        `INSERT INTO worktrees (id, repo_id, branch, path, is_primary)
         VALUES ('wt-removed', 'repo-removed', 'main', ?, 1),
                ('wt-kept', 'repo-kept', 'main', ?, 1)`
      ).run(deletedRepoPath, join(root, "kept-profile-repo"));
      db.prepare(
        `INSERT INTO branch_pr (repo_id, branch, number, title)
         VALUES ('repo-removed', 'main', 41, 'removed PR'),
                ('repo-kept', 'main', 42, 'kept PR')`
      ).run();
      db.prepare(
        `INSERT INTO commit_pr (repo_id, commit_sha, number, title)
         VALUES ('repo-removed', 'aaa', 41, 'removed commit PR')`
      ).run();
      db.prepare(
        `INSERT INTO remote_branches (id, repo_id, name, full_name, remote_name)
         VALUES ('remote-removed', 'repo-removed', 'topic', 'origin/topic', 'origin')`
      ).run();
      db.prepare(
        `INSERT INTO local_branches (id, repo_id, name, full_name)
         VALUES ('local-removed', 'repo-removed', 'local', 'refs/heads/local')`
      ).run();
      db.prepare(
        `INSERT INTO clone_destinations (profile_id, path)
         VALUES (?, ?)`
      ).run(removed.id, root);
      db.prepare(
        `INSERT INTO profile_scan_state (profile_id, scanned_at_ms)
         VALUES (?, 123)`
      ).run(removed.id);
      db.prepare(
        `INSERT INTO remote_branch_index_state (repo_id)
         VALUES ('repo-removed')`
      ).run();
      db.prepare(
        `INSERT INTO repo_identity
           (repo_id, host, hostname, owner, name, visibility)
         VALUES ('repo-removed', 'github', 'github.com', 'acme', 'removed', 'private')`
      ).run();
      db.prepare("INSERT INTO app_meta (key, value) VALUES (?, ?), (?, ?)").run(
        `profile:${removed.id}:selected_repo_id`,
        "repo-removed",
        `profile:${kept.id}:selected_repo_id`,
        "repo-kept"
      );

      const result = profiles.delete({
        profileId: removed.id,
        expectedName: removed.name
      });

      expect(result.ok).toBe(true);
      expect(profiles.getActiveId()).toBe(kept.id);
      expect(profiles.get(removed.id)).toBeNull();
      for (const [table, column, id] of [
        ["repos", "id", "repo-removed"],
        ["worktrees", "id", "wt-removed"],
        ["branch_pr", "repo_id", "repo-removed"],
        ["commit_pr", "repo_id", "repo-removed"],
        ["remote_branches", "repo_id", "repo-removed"],
        ["local_branches", "repo_id", "repo-removed"],
        ["remote_branch_index_state", "repo_id", "repo-removed"],
        ["repo_identity", "repo_id", "repo-removed"],
        ["clone_destinations", "profile_id", removed.id],
        ["profile_scan_state", "profile_id", removed.id]
      ] as const) {
        const row = db
          .prepare(`SELECT 1 FROM ${table} WHERE ${column} = ?`)
          .get(id);
        expect(row, `${table} row`).toBeUndefined();
      }
      expect(
        db
          .prepare(
            `SELECT 1 FROM search_fts
             WHERE entity_id IN ('repo-removed', 'wt-removed', 'remote-removed', 'local-removed')`
          )
          .get()
      ).toBeUndefined();

      // Another profile's rows and scoped selection remain intact.
      expect(db.prepare("SELECT id FROM repos WHERE id = 'repo-kept'").get()).toEqual({
        id: "repo-kept"
      });
      expect(
        db.prepare("SELECT repo_id FROM branch_pr WHERE repo_id = 'repo-kept'").get()
      ).toEqual({ repo_id: "repo-kept" });
      expect(
        db
          .prepare("SELECT value FROM app_meta WHERE key = ?")
          .get(`profile:${kept.id}:selected_repo_id`)
      ).toEqual({ value: "repo-kept" });
      expect(
        db
          .prepare("SELECT value FROM app_meta WHERE key = ?")
          .get(`profile:${removed.id}:selected_repo_id`)
      ).toBeUndefined();

      expect(existsSync(deletedRepoPath)).toBe(true);
      expect(existsSync(sentinel)).toBe(true);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
