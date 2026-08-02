import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ok, type PrSummary } from "@pwrgit/shared";
import { openDatabase, type DB } from "../persistence/db";
import type { GitExec } from "../git/dugite";
import { PrService } from "./pr-service";

const REMOTE = "git@github.com:pwrdrvr/PwrGit.git\n";

const git: GitExec = async () =>
  ok({ stdout: REMOTE, stderr: "", exitCode: 0 });

function pr(overrides: Partial<PrSummary> = {}): PrSummary {
  return {
    number: 42,
    url: "https://github.com/pwrdrvr/PwrGit/pull/42",
    title: "Keep PR state fresh",
    state: "open",
    isDraft: true,
    ...overrides
  };
}

describe("PrService", () => {
  let db: DB;
  let now: number;
  let response: Map<string, PrSummary | null>;
  let fetches: string[][];
  let service: PrService;

  beforeEach(() => {
    db = openDatabase(":memory:");
    db.prepare(
      "INSERT INTO profiles (id, name, email) VALUES ('profile', 'Profile', 'profile@example.com')"
    ).run();
    db.prepare(
      "INSERT INTO repos (id, profile_id, name, path) VALUES ('repo', 'profile', 'PwrGit', '/repo')"
    ).run();
    db.prepare(
      "INSERT INTO worktrees (id, repo_id, branch, path) VALUES ('wt', 'repo', 'feature/pr-state', '/repo/wt')"
    ).run();

    now = 1_000_000;
    response = new Map([["feature/pr-state", pr()]]);
    fetches = [];
    service = new PrService(db, git, {
      getGitHubToken: async () => "token",
      fetchPrsForRepo: async (_token, _owner, _repo, branches) => {
        fetches.push(branches);
        return response;
      },
      now: () => now
    });
  });

  afterEach(() => {
    if (db) db.close();
  });

  it("broadcasts a draft-to-ready change even when the lifecycle stays open", async () => {
    const first = await service.refreshRepo("repo", {
      branches: ["feature/pr-state"],
      trigger: "user"
    });
    expect(first.get("feature/pr-state")).toMatchObject({
      state: "open",
      isDraft: true
    });

    now += 10_000;
    response = new Map([["feature/pr-state", pr({ isDraft: false })]]);
    const changed = await service.refreshRepo("repo", {
      branches: ["feature/pr-state"],
      trigger: "user"
    });

    expect(changed.get("feature/pr-state")).toMatchObject({
      state: "open",
      isDraft: false
    });
    expect(
      db
        .prepare("SELECT state, is_draft FROM branch_pr WHERE repo_id = 'repo'")
        .get()
    ).toEqual({ state: "open", is_draft: 0 });
  });

  it("limits hover refreshes to one branch and ten-second user cooldown", async () => {
    await service.refreshRepo("repo", {
      branches: ["feature/pr-state"],
      trigger: "user"
    });
    await service.refreshRepo("repo", {
      branches: ["feature/pr-state"],
      trigger: "user"
    });

    expect(fetches).toEqual([["feature/pr-state"]]);

    now += 10_000;
    await service.refreshRepo("repo", {
      branches: ["feature/pr-state"],
      trigger: "user"
    });
    expect(fetches).toEqual([
      ["feature/pr-state"],
      ["feature/pr-state"]
    ]);
  });
});
