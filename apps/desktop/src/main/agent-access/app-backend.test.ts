import { expect, it, vi } from "vitest";
import { ok } from "@pwrgit/shared";
import { openDatabase } from "../persistence/db";
import { ProfileService } from "../profiles/profile-service";
import { RepoIndexer } from "../git/repo-indexer";
import { CommandBus } from "../command-bus";
import { createAppBackend } from "./app-backend";

it("persists imported visits and live selections and delegates actions through app services", async () => {
  const db = openDatabase(":memory:");
  try {
    const profiles = new ProfileService(db);
    profiles.ensureSeed({ name: "Personal", email: "private@example.com", mono: "", roots: [] });
    const profileId = profiles.getActiveId()!;
    db.prepare("INSERT INTO repos(id, profile_id, name, path) VALUES (?, ?, ?, ?)").run("repo", profileId, "Widget", "/fixture/widget");
    db.prepare("INSERT INTO worktrees(id, repo_id, branch, path, is_primary) VALUES (?, ?, ?, ?, 1)").run("wt", "repo", "main", "/fixture/widget");
    const indexer = new RepoIndexer(db, vi.fn());
    const bus = new CommandBus();
    const open = vi.fn(() => ok(null));
    bus.register("profile:openWindow", open);
    const backend = createAppBackend(db, profiles, indexer, bus);
    expect((await backend.catalog()).repositories[0]!.worktrees[0]!.lastViewedAt).toBeNull();
    expect((await bus.dispatch("navigation:record", { profileId, selectedWorktreeId: null, visits: { wt: 1000, unknown: 2000 } })).ok).toBe(true);
    const imported = (await backend.catalog()).repositories[0]!;
    expect(imported.worktrees[0]!.lastViewedAt).toBe("1970-01-01T00:00:01.000Z");
    expect(JSON.stringify(await backend.catalog())).not.toContain("private@example.com");
    expect((await bus.dispatch("navigation:record", { profileId, selectedWorktreeId: "wt" })).ok).toBe(true);
    const recreated = createAppBackend(db, profiles, indexer, bus);
    expect((await recreated.catalog()).repositories[0]!.worktrees[0]!.selected).toBe(true);
    expect((await bus.dispatch("navigation:record", { profileId, selectedWorktreeId: "unknown" })).ok).toBe(false);
    await backend.open(imported, "wt");
    expect(open).toHaveBeenCalledWith({ profileId, revealRepoId: "repo", revealWorktreeId: "wt" }, {});
  } finally { db.close(); }
});

it("returns indexed repositories from every profile, regardless of the active profile", async () => {
  const db = openDatabase(":memory:");
  try {
    const profiles = new ProfileService(db);
    profiles.ensureSeed({ name: "First", email: "first@example.com", roots: [] });
    const first = profiles.getActiveId()!;
    const second = profiles.create({ name: "Second", email: "second@example.com", roots: [] }).id;
    for (const [id, profileId] of [["one", first], ["two", second]]) {
      db.prepare("INSERT INTO repos(id, profile_id, name, path) VALUES (?, ?, ?, ?)").run(id, profileId, id, `/fixture/${id}`);
      db.prepare("INSERT INTO worktrees(id, repo_id, branch, path, is_primary) VALUES (?, ?, ?, ?, 1)").run(`${id}-wt`, id, "main", `/fixture/${id}`);
    }
    const backend = createAppBackend(db, profiles, new RepoIndexer(db, vi.fn()), new CommandBus());
    expect((await backend.catalog()).repositories.map(repo => repo.profileId)).toEqual([first, second]);
    profiles.switch(second);
    expect((await backend.catalog()).repositories.map(repo => repo.profileId)).toEqual([first, second]);
  } finally { db.close(); }
});
