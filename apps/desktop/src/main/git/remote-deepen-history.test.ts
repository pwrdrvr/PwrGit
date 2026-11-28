import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandBus } from "../command-bus";
import { emitEvent } from "../ipc";
import { openDatabase, type DB } from "../persistence/db";
import { registerRemoteHandlers } from "./remote-handlers";
import type { WorktreeRefresher } from "./worktree-handlers";
import { WorktreeOperationQueue } from "./worktree-operation-queue";
import {
  countCommits,
  createHistorySource,
  fileUrl,
  fixtureGit,
  isShallow
} from "./test-support/shallow-fixture";

vi.mock("../ipc", () => ({ emitEvent: vi.fn() }));
vi.mock("../logs", () => ({ logMain: vi.fn() }));

let root: string;
let source: string;
let db: DB;
let bus: CommandBus;
let refresher: WorktreeRefresher;

beforeAll(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "pwrgit-deepen-")));
  source = createHistorySource(join(root, "source"));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

let n = 0;
function shallowRepo(depth: number): string {
  const clone = join(root, `clone-${(n += 1)}`);
  fixtureGit(root, "clone", "-q", `--depth=${depth}`, "--no-single-branch", fileUrl(source), clone);
  db.prepare("INSERT INTO repos (id, profile_id, name, path) VALUES ('repo-1', 'p1', 'history', ?)").run(clone);
  return clone;
}

beforeEach(() => {
  db = openDatabase(":memory:");
  db.prepare("INSERT INTO profiles (id, name, email) VALUES ('p1', 'P', 'p@example.com')").run();
  bus = new CommandBus();
  refresher = { refreshWorktree: vi.fn(async () => undefined), refreshRepoWorktrees: vi.fn() };
  registerRemoteHandlers(bus, db, refresher, new WorktreeOperationQueue());
  vi.mocked(emitEvent).mockClear();
});

function emitted(name: string): unknown[] {
  return vi.mocked(emitEvent).mock.calls.filter(([event]) => event === name).map(([, payload]) => payload);
}

describe("remote:deepenHistory", () => {
  it("deepens, then unshallows, as tracked fetches that redraw the graph", async () => {
    const clone = shallowRepo(1);
    const before = countCommits(clone, "origin/main");

    const deepened = await bus.dispatch("remote:deepenHistory", {
      repoId: "repo-1",
      remote: "origin",
      mode: { kind: "deepen", commits: 2 }
    });
    expect(deepened).toEqual({ ok: true, value: { remote: "origin", shallow: true, fetched: true } });
    expect(countCommits(clone, "origin/main")).toBeGreaterThan(before);
    expect(emitted("graph:changed")).toContainEqual({ repoId: "repo-1" });
    // Registered as a fetch activity: progress and Stop come from there.
    const activities = emitted("remote:activity") as { activities: { kind: string; repoId: string }[] }[];
    expect(activities.some((event) => event.activities.some((a) => a.kind === "fetch" && a.repoId === "repo-1"))).toBe(true);
    expect(refresher.refreshRepoWorktrees).toHaveBeenCalledWith("repo-1");

    const full = await bus.dispatch("remote:deepenHistory", {
      repoId: "repo-1",
      remote: "origin",
      mode: { kind: "unshallow" }
    });
    expect(full).toEqual({ ok: true, value: { remote: "origin", shallow: false, fetched: true } });
    expect(isShallow(clone)).toBe(false);
    expect(countCommits(clone, "origin/main")).toBe(countCommits(source, "main"));
  });

  it("asks nothing of the network for a repository that is already complete", async () => {
    db.prepare("INSERT INTO repos (id, profile_id, name, path) VALUES ('repo-1', 'p1', 'history', ?)").run(source);
    vi.mocked(emitEvent).mockClear();
    const result = await bus.dispatch("remote:deepenHistory", {
      repoId: "repo-1",
      remote: "origin",
      mode: { kind: "unshallow" }
    });
    expect(result).toEqual({ ok: true, value: { remote: "origin", shallow: false, fetched: false } });
    expect(emitted("graph:changed")).toEqual([]);
  });

  it("refuses a remote that is not configured and a malformed count", async () => {
    const clone = shallowRepo(2);
    const before = countCommits(clone, "origin/main");
    expect(
      await bus.dispatch("remote:deepenHistory", { repoId: "repo-1", remote: "--all", mode: { kind: "unshallow" } })
    ).toMatchObject({ ok: false, error: { code: "remote_missing" } });
    expect(
      await bus.dispatch("remote:deepenHistory", {
        repoId: "repo-1",
        remote: "origin",
        mode: { kind: "deepen", commits: 0 }
      })
    ).toMatchObject({ ok: false, error: { code: "invalid_history_depth" } });
    expect(countCommits(clone, "origin/main")).toBe(before);
    expect(isShallow(clone)).toBe(true);
  });

  it("refuses an unknown repository", async () => {
    expect(
      await bus.dispatch("remote:deepenHistory", { repoId: "nope", remote: "origin", mode: { kind: "unshallow" } })
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
  });
});
