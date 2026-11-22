import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import type { ChangeRequestList, Repo } from "@pwrgit/shared";
import { CommandBus } from "../command-bus";
import { openDatabase } from "../persistence/db";
import { ProfileService } from "../profiles/profile-service";
import { RepoIndexer } from "./repo-indexer";
import { registerStackReadHandlers } from "./stack-read-handlers";
import { StackReader } from "./stack-reader";
import { NativeStackLocks } from "./stack-catalog-store";
import { commit, git, runner, withStack } from "./stack-engine/fixture.test-support";

test("read health follows real common-dir refs, scoped to the requesting profile", () => withStack(async ({ cwd, initial, commonDir, base, top }) => {
  const db = openDatabase(":memory:");
  try {
    const profiles = new ProfileService(db);
    profiles.ensureSeed({ name: "First", email: "first@example.invalid", roots: [] });
    const first = profiles.getActiveId()!;
    const second = profiles.create({ name: "Second", email: "second@example.invalid", roots: [] }).id;
    const insert = db.prepare("INSERT INTO repos(id, profile_id, name, path) VALUES (?, ?, ?, ?)");
    insert.run("here", first, "Orbit", cwd);
    insert.run("elsewhere", second, "Other", join(cwd, "other"));
    const indexer = new RepoIndexer(db, vi.fn());
    await writeFile(join(commonDir, "gh-stack"), JSON.stringify(initial));
    const next = await commit(cwd, "trunk.txt", "advance");
    const linked = join(cwd, "linked");
    await git(cwd, "worktree", "add", "-q", linked, "top");
    const open: ChangeRequestList = { forge: "github", fetchedAt: null, truncated: false, remotes: [], entries: [] };
    const reader = new StackReader(runner, new NativeStackLocks(() => { throw new Error("read-only view invoked the helper"); }),
      async () => open, () => undefined);
    const bus = new CommandBus();
    registerStackReadHandlers(bus, id => indexer.getRepo(id), reader);
    expect((await bus.dispatch("stack:list", { profileId: first, repoId: "elsewhere" })).ok).toBe(false);
    expect((await bus.dispatch("stack:list", { profileId: second, repoId: "here" })).ok).toBe(false);
    const view = await bus.dispatch("stack:list", { profileId: first, repoId: "here" });
    const repo: Repo = { ...indexer.getRepo("here")!, path: linked };
    expect(view).toMatchObject({ ok: true, value: { stacks: [{
      source: "tracked", trunk: { branch: "main", head: next },
      layers: [{ base, health: { needsRestack: true } }, { head: top, health: { inSync: true } }],
    }] } });
    if (view.ok) expect(await reader.list(repo)).toEqual(view.value);
  } finally { db.close(); }
}));
