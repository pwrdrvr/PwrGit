import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import type { Profile } from "@pwrgit/shared";
import { openDatabase } from "../persistence/db";
import { ProfileService } from "../profiles/profile-service";
import { RepoIndexer } from "./repo-indexer";
import { createRootDiscovery, ROOT_DISCOVERY_INTERVAL_MS } from "./root-discovery";
import { createSystemGit } from "./test-support/system-git";

// The rule: while PwrGit runs, a checkout that appears under a profile's
// root is listed after the next routine look at the roots, however recently
// the daily full scan ran. The oracle is this test's own record of the
// checkouts it put on disk, not the indexer's walker. Before the fix the only
// routine scan was the daily one, so a clone made an hour after launch stayed
// out of the sidebar (and ⌘K) for up to a day.
//
// Real Git, real folders: what is listed is what `rescanProfile` resolved.

const systemGit = createSystemGit();
const DAY_MS = 24 * 60 * 60 * 1000;
const scratch = mkdtempSync(join(tmpdir(), "pwrgit-root-discovery-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function git(dir: string, args: string[]): void {
  execFileSync("git", args, { cwd: dir, stdio: "ignore" });
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@t.com"]);
  git(dir, ["config", "user.name", "Tester"]);
  git(dir, ["config", "maintenance.auto", "false"]);
  writeFileSync(join(dir, "README.md"), "# repo\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "init"]);
}

type Op =
  | { kind: "clone"; nested: boolean }
  | { kind: "worktree"; of: number }
  | { kind: "plain" }
  | { kind: "advance"; ms: number }
  | { kind: "tick" }
  | { kind: "sync" };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  { arbitrary: fc.record({ kind: fc.constant("clone" as const), nested: fc.boolean() }), weight: 3 },
  { arbitrary: fc.record({ kind: fc.constant("worktree" as const), of: fc.nat(5) }), weight: 1 },
  { arbitrary: fc.constant({ kind: "plain" as const }), weight: 1 },
  {
    arbitrary: fc.record({
      kind: fc.constant("advance" as const),
      // Never as far as the daily scan: that would prove nothing.
      ms: fc.integer({ min: 0, max: 30 * 60_000 })
    }),
    weight: 2
  },
  { arbitrary: fc.constant({ kind: "tick" as const }), weight: 2 },
  { arbitrary: fc.constant({ kind: "sync" as const }), weight: 1 }
);

let runNo = 0;

async function runScenario(ops: Op[]): Promise<void> {
  const root = join(scratch, `run-${(runNo += 1)}`);
  mkdirSync(root, { recursive: true });
  initRepo(join(root, "launch-repo"));

  const db = openDatabase(":memory:");
  const profile: Profile = new ProfileService(db).create({
    name: "Discovery",
    email: "d@example.com",
    roots: [root]
  });
  let clock = 1_000_000;
  const indexer = new RepoIndexer(db, systemGit, {
    now: () => clock,
    profileRescanIntervalMs: DAY_MS
  });
  // Launch: the profile window opened and ran its daily scan.
  await indexer.rescanProfile(profile);

  const pending: Promise<unknown>[] = [];
  let scanning = false;
  let forcedScans = 0;
  const discovery = createRootDiscovery({
    profiles: () => [profile],
    indexer,
    now: () => clock,
    rescan: (p, { force }) => {
      if (scanning) return false;
      scanning = true;
      if (force) forcedScans += 1;
      pending.push(
        indexer.rescanProfile(p).finally(() => {
          scanning = false;
        })
      );
      return true;
    }
  });
  const settle = async (): Promise<void> => {
    while (pending.length > 0) await pending.shift();
  };

  // Every checkout this scenario made, and when.
  const checkouts: string[] = [join(root, "launch-repo")];
  const primaries: string[] = [join(root, "launch-repo")];
  let made = 0;
  let newSinceLastTick = false;

  const listed = (): Set<string> => {
    const paths = new Set<string>();
    for (const repo of indexer.listRepos(profile.id)) {
      paths.add(realpathSync(repo.path));
      for (const wt of repo.worktrees) paths.add(realpathSync(wt.path));
    }
    return paths;
  };

  for (const op of ops) {
    switch (op.kind) {
      case "clone": {
        made += 1;
        const dir = op.nested
          ? join(root, "group", `repo-${made}`)
          : join(root, `repo-${made}`);
        initRepo(dir);
        checkouts.push(dir);
        primaries.push(dir);
        newSinceLastTick = true;
        break;
      }
      case "worktree": {
        made += 1;
        const of = primaries[op.of % primaries.length]!;
        const dir = join(root, `wt-${made}`);
        git(of, ["worktree", "add", "-q", dir, "-b", `wt-${made}`]);
        checkouts.push(dir);
        newSinceLastTick = true;
        break;
      }
      case "plain": {
        made += 1;
        mkdirSync(join(root, `notes-${made}`), { recursive: true });
        break;
      }
      case "advance":
        clock += op.ms;
        break;
      // The timer's look, or the one a Fetch/Pull run starts with.
      case "tick":
      case "sync": {
        const scansBefore = forcedScans;
        if (op.kind === "tick") clock += ROOT_DISCOVERY_INTERVAL_MS;
        await discovery.check();
        await settle();
        // The rule.
        const now = listed();
        for (const dir of checkouts) {
          expect(now, `${dir} is listed after a routine check`).toContain(
            realpathSync(dir)
          );
        }
        // And its price: a quiet root starts no Git-heavy scan.
        if (!newSinceLastTick) expect(forcedScans).toBe(scansBefore);
        newSinceLastTick = false;
        break;
      }
    }
  }
  db.close();
}

describe("root discovery while the app runs", () => {
  it("lists a checkout that appears under a root after the next routine check", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 8 }), (ops) =>
        runScenario([...ops, { kind: "tick" }])
      ),
      { numRuns: 12 }
    );
  }, 120_000);

  it("finds rgit: a clone made the evening after a morning scan", async () => {
    // The reported case, pinned: scanned 19:01, cloned the next day at
    // 22:48 — over a day later, but the app never closed, so no window
    // opened to run the daily scan.
    await runScenario([
      { kind: "advance", ms: 27 * 60 * 60 * 1000 - 2 * ROOT_DISCOVERY_INTERVAL_MS },
      { kind: "clone", nested: false },
      { kind: "tick" }
    ]);
  }, 60_000);
});
