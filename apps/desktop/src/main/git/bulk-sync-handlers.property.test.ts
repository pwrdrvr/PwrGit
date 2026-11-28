import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { openDatabase, type DB } from "../persistence/db";
import { profileRepos } from "./bulk-sync-handlers";

vi.mock("../ipc", () => ({ emitEvent: vi.fn() }));
vi.mock("../logs", () => ({ logMain: vi.fn() }));

function fixture(db: DB, repos: number, siblingWorktrees: number): void {
  db.exec(`
    INSERT INTO profiles (id, name, email) VALUES ('p', 'Mine', 'mine@example.test'),
      ('other', 'Other', 'other@example.test');
    INSERT INTO repos (id, profile_id, name, path) VALUES ('foreign', 'other', 'Alpha', '/foreign');
    INSERT INTO worktrees (id, repo_id, branch, path) VALUES ('foreign-wt', 'foreign', 'main', '/foreign');
  `);
  const repo = db.prepare("INSERT INTO repos (id, profile_id, name, path) VALUES (?, 'p', ?, ?)");
  const checkout = db.prepare(
    "INSERT INTO worktrees (id, repo_id, branch, path, is_primary, missing) VALUES (?, ?, ?, ?, ?, ?)"
  );
  db.transaction(() => {
    for (let i = 0; i < repos; i++) {
      const id = `r${i}`;
      repo.run(id, ["Zulu", "alpha", "Alpha"][i % 3], `/${id}`);
      const count = i === 0 ? 2 : i === 1 ? siblingWorktrees : 1;
      for (let j = 0; j < count; j++) {
        checkout.run(`${id}-${j}`, id, j === 0 ? "zzz" : `a-${j}`, `/${id}/${j}`, Number(j === 0), 0);
      }
      checkout.run(`${id}-missing`, id, "missing", `/${id}/missing`, 0, 1);
    }
  })();
  db.prepare("INSERT INTO hidden_repos (profile_id, path, name, hidden_at_ms) VALUES ('p', ?, 'Hidden', 1)")
    .run(`/r${repos - 1}`);
  db.exec(`
    INSERT INTO worktree_state (worktree_id, branch, has_upstream, source_ahead, source_behind)
      VALUES ('r0-1', 'a-1', 1, 0, 2);
  `);
}

function traceReads(db: DB) {
  const reads: { sql: string; bindings: unknown[]; rows: number }[] = [];
  const traced = {
    prepare(sql: string) {
      const statement = db.prepare(sql);
      return {
        get: (...bindings: unknown[]) => statement.get(...bindings),
        all: (...bindings: unknown[]) => {
          const rows = statement.all(...bindings);
          reads.push({ sql, bindings, rows: rows.length });
          return rows;
        }
      };
    }
  } as DB;
  return { traced, reads };
}

describe("scoped bulk sync planning", () => {
  it("reads only the chosen repository and its two present checkouts", () => {
    const db = openDatabase(":memory:");
    try {
      fixture(db, 3, 1);
      const { traced, reads } = traceReads(db);
      const plan = profileRepos(traced, "p", ["r0", "r0", "r2", "foreign", "absent"], { syncForks: true });
      expect(plan?.map(({ id, pullPending, worktrees }) => [id, pullPending, worktrees.map((w) => w.id)])).toEqual([
        ["r0", true, ["r0-0", "r0-1"]]
      ]);
      expect(reads.map(({ rows }) => rows)).toEqual([1, 2]);
    } finally {
      db.close();
    }
  });

  it("matches the ordered full plan filtered by membership and bounds both SQL reads", () => {
    const db = openDatabase(":memory:");
    try {
      fixture(db, 136, 408);
      // Include table statistics so the test exercises the cost-based planner.
      db.exec("ANALYZE");
      const id = fc.constantFrom<string>("r0", "r1", "r4", "r5", "r8", "r135", "foreign", "absent");
      fc.assert(fc.property(fc.array(id), fc.boolean(), (selected, syncForks) => {
        const { traced, reads } = traceReads(db);
        const expected = profileRepos(db, "p", undefined, { syncForks })!.filter((r) => selected.includes(r.id));
        const plan = profileRepos(traced, "p", selected, { syncForks });
        expect(plan).toEqual(expected);
        const worktrees = expected.reduce((total, r) => total + r.worktrees.length, 0);
        expect(reads.reduce((total, read) => total + read.rows, 0)).toBe(expected.length + worktrees);
      }), { seed: 2026112720, numRuns: 50 });

      const { traced, reads } = traceReads(db);
      profileRepos(traced, "p", ["r0", "r135", "foreign", "absent"]);
      const details = reads.map(({ sql, bindings }) =>
        (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...bindings) as { detail: string }[])
          .map(({ detail }) => detail).join("\n")
      );
      expect(details[0]).toMatch(/SEARCH r USING INDEX \S+ \(id=\?\)/);
      expect(details[0]).toMatch(/SEARCH h USING COVERING INDEX \S+ \(profile_id=\? AND path=\?\)/);
      expect(details[0]).toContain("SEARCH w USING INDEX idx_worktrees_repo (repo_id=?)");
      expect(details[0]).toMatch(/SEARCH s USING INDEX \S+ \(worktree_id=\?\)/);
      expect(details[1]).toContain("SEARCH w USING INDEX idx_worktrees_repo (repo_id=?)");
      expect(details.join("\n")).not.toMatch(/(?:SCAN|BLOOM FILTER ON) [rhws](?: |\n|$)/);
    } finally {
      db.close();
    }
  });

  it("accepts a scope above SQLite's variable limit and distinguishes empty from omitted", () => {
    const db = openDatabase(":memory:");
    try {
      fixture(db, 4, 1);
      const { traced, reads } = traceReads(db);
      expect(profileRepos(traced, "p", [])).toEqual([]);
      expect(profileRepos(traced, "unknown", [])).toBeNull();
      expect(reads).toEqual([]);
      expect(profileRepos(db, "p")?.map((r) => r.id)).toEqual(["r2", "r1", "r0"]);
      expect(profileRepos(db, "p", [
        "r2", ...Array.from({ length: 40_000 }, (_, i) => `absent-${i}`), "r0", "r2"
      ])?.map((r) => r.id)).toEqual(["r2", "r0"]);
    } finally {
      db.close();
    }
  });
});
