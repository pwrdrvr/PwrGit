import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bulkSyncRepositories } from "./bulk-sync";
import { fetchAllRemotes, fetchNamedRemote, fetchRemote, pullFastForward } from "./git-service";
import { createSystemGit } from "./test-support/system-git";

/*
 * Git is the oracle (docs/property-model-oracle-testing.md). The rule, from
 * src/main/git/AGENTS.md: an ordinary sync never rewrites a tag. Fetch, Pull,
 * Fetch all and Bulk sync may only ADD a missing tag name, and only one whose
 * commit arrived with a branch (Git's tag following). They never move an
 * existing tag, never download history that only a tag reaches, and add no
 * tag at all for a remote with tagOpt=--no-tags.
 */

const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const systemGit = createSystemGit({ env });
let template: string;
const runs: string[] = [];

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], {
    cwd: tmpdir(), env, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"]
  }).trim();
}

function setup(repo: string): void {
  git(repo, "config", "user.name", "Tag Fixture");
  git(repo, "config", "user.email", "tags@example.test");
  git(repo, "config", "maintenance.auto", "false");
  git(repo, "config", "gc.auto", "0");
  git(repo, "config", "core.autocrlf", "false");
}

function localTags(repo: string): Map<string, string> {
  const out = git(repo, "for-each-ref", "--format=%(refname:strip=2) %(objectname)", "refs/tags");
  return new Map(out === "" ? [] : out.split("\n").map((line) => line.split(" ") as [string, string]));
}

function has(repo: string, id: string): boolean {
  try {
    git(repo, "cat-file", "-e", id);
    return true;
  } catch {
    return false;
  }
}

let counter = 0;
function commit(publisher: string): void {
  writeFileSync(join(publisher, "release.txt"), `cut ${(counter += 1)}\n`);
  git(publisher, "commit", "-qam", `cut ${counter}`);
  git(publisher, "push", "-q", "origin", "main");
}

/** origin.git with v1 (lightweight) and v2 (annotated); a publisher; the user's clone. */
beforeAll(() => {
  template = mkdtempSync(join(tmpdir(), "pwrgit-fetch-tags-"));
  git(template, "init", "-q", "--bare", "-b", "main", "origin.git");
  git(template, "config", "-f", join(template, "origin.git", "config"), "gc.auto", "0");
  git(template, "clone", "-q", "origin.git", "publisher");
  const publisher = join(template, "publisher");
  setup(publisher);
  writeFileSync(join(publisher, "release.txt"), "cut 0\n");
  git(publisher, "add", ".");
  git(publisher, "commit", "-qm", "cut 0");
  git(publisher, "tag", "v1");
  git(publisher, "tag", "-a", "-m", "v2", "v2");
  git(publisher, "push", "-q", "origin", "main", "--tags");
  git(template, "clone", "-q", "origin.git", "local");
  setup(join(template, "local"));
});

/*
 * Budget (docs/property-model-oracle-testing.md): about 0.1s per run on Linux
 * and macOS, 25 runs in ~2.4s. Real Git on the Windows runner is 6-13x slower
 * (tag-source-handlers.test.ts: 1.1s on Linux, 9-13s on Windows), so 25 runs
 * there passed the 20s test timeout. Windows runs 4: a platform smoke of the
 * same rule, which Linux and macOS search properly.
 */

/** Windows may still hold a directory a moment after Git exits; afterAll retries. */
function removeRun(root: string): void {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // Left in `runs` for afterAll.
  }
}

afterAll(() => {
  for (const root of [template, ...runs]) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

type Op =
  | { kind: "recut"; name: string; annotated: boolean; advance: boolean }
  | { kind: "orphan"; name: string }
  | { kind: "delete"; name: string }
  | { kind: "sync"; how: "fetch" | "fetchNamed" | "fetchAll" | "pull" | "bulk" };

const tagName = fc.constantFrom("v1", "v2", "v3");
const op: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant("recut" as const), name: tagName, annotated: fc.boolean(), advance: fc.boolean() }),
  fc.record({ kind: fc.constant("orphan" as const), name: fc.constantFrom("legacy/a", "legacy/b") }),
  fc.record({ kind: fc.constant("delete" as const), name: tagName }),
  fc.record({ kind: fc.constant("sync" as const), how: fc.constantFrom("fetch", "fetchNamed", "fetchAll", "pull", "bulk") })
);

/** A publisher-side change, made the way a maintainer would: with git, then pushed. */
function publish(publisher: string, change: Exclude<Op, { kind: "sync" }>, orphans: Set<string>): void {
  if (change.kind === "recut") {
    if (change.advance) commit(publisher);
    git(publisher, "tag", "-f", ...(change.annotated ? ["-a", "-m", `re-cut ${change.name}`] : []), change.name);
    git(publisher, "push", "-q", "-f", "origin", `refs/tags/${change.name}`);
  } else if (change.kind === "orphan") {
    // History reachable only from this tag, as an import or a docs branch is.
    const tree = git(publisher, "write-tree");
    const id = execFileSync("git", ["-C", publisher, "commit-tree", tree, "-m", `import ${change.name}`], {
      cwd: tmpdir(), env, encoding: "utf8"
    }).trim();
    orphans.add(id);
    git(publisher, "tag", "-f", change.name, id);
    git(publisher, "push", "-q", "-f", "origin", `refs/tags/${change.name}`);
  } else {
    // Only a tag that exists can be deleted; any other delete is a no-op.
    if (git(publisher, "tag", "-l", change.name) === "") return;
    git(publisher, "push", "-q", "origin", `:refs/tags/${change.name}`);
    git(publisher, "tag", "-d", change.name);
  }
}

async function sync(local: string, how: Extract<Op, { kind: "sync" }>["how"]): Promise<void> {
  if (how === "bulk") {
    await bulkSyncRepositories(systemGit, [
      { id: "repo", name: "local", path: local, worktrees: [{ id: "main", branch: "main", path: local }] }
    ], { operationId: "property", mode: "fetch" });
    return;
  }
  const result =
    how === "fetch" ? await fetchRemote(systemGit, local)
    : how === "fetchNamed" ? await fetchNamedRemote(systemGit, local, "origin")
    : how === "fetchAll" ? await fetchAllRemotes(systemGit, local)
    : await pullFastForward(systemGit, local);
  expect(result.ok).toBe(true);
}

describe("ordinary sync and tags (git as the oracle)", () => {
  it("only adds missing names whose commit came with a branch; never moves a tag, fetches tag-only history, or ignores --no-tags", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 6 }), fc.boolean(), async (ops, noTags) => {
        const root = mkdtempSync(join(tmpdir(), "pwrgit-fetch-tags-run-"));
        runs.push(root);
        cpSync(template, root, { recursive: true });
        const publisher = join(root, "publisher");
        const local = join(root, "local");
        git(publisher, "remote", "set-url", "origin", join(root, "origin.git"));
        git(local, "remote", "set-url", "origin", join(root, "origin.git"));
        if (noTags) git(local, "config", "remote.origin.tagOpt", "--no-tags");
        const orphans = new Set<string>();

        for (const step of ops) {
          if (step.kind !== "sync") {
            publish(publisher, step, orphans);
            continue;
          }
          const before = localTags(local);
          await sync(local, step.how);
          const after = localTags(local);
          for (const [name, objectId] of before) expect(after.get(name), `${step.how} moved ${name}`).toBe(objectId);
          for (const [name, objectId] of after) {
            if (before.has(name)) continue;
            expect(noTags, `${step.how} added ${name} under --no-tags`).toBe(false);
            // Followed from a fetched branch: the tag's commit is on origin/main.
            const target = git(local, "rev-parse", `${objectId}^{commit}`);
            expect(() => git(local, "merge-base", "--is-ancestor", target, "refs/remotes/origin/main")).not.toThrow();
          }
          for (const orphan of orphans) expect(has(local, orphan), `${step.how} downloaded tag-only history`).toBe(false);
        }
        removeRun(root);
      }),
      { numRuns: process.platform === "win32" ? 4 : 25 }
    );
  });
});
