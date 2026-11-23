import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterEach, expect, it } from "vitest";
import type { Commit } from "@pwrgit/shared";
import { historyRangeFrom } from "./history-range";
import { readUnpushedCommits } from "../../../../main/git/git-service";
import { dryRunRebase, validateSelection } from "../../../../main/git/rebase-assistant";
import { createSystemGit } from "../../../../main/git/test-support/system-git";

/**
 * Rule: the lineage's "Edit history from here" offers exactly the runs the
 * rebase assistant accepts. Compare every candidate with the assistant's
 * Git-backed `validateSelection`, which checks contiguity and excludes merge
 * and root commits. Replay the longest accepted range in each repository
 * through the full isolated squash to check that it can actually rewrite.
 *
 * - Sound: every run the menu offers passes the check.
 * - Complete: every top-N run of `git log` that passes it is offered when its
 *   oldest commit is right-clicked, with the same commits.
 * - Pushed: the run's "already pushed" count, from main's `readUnpushedCommits`
 *   through `historyRangeFrom`, equals the commits Git says some
 *   remote-tracking ref contains (`for-each-ref --contains`).
 *
 * The checkbox column this replaced let any set of rows be ticked, and main
 * refused all but one shape only after an operation was chosen.
 */

const systemGit = createSystemGit();
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

type Op =
  | { kind: "commit" }
  | { kind: "branch" }
  | { kind: "switch"; pick: number }
  | { kind: "merge"; pick: number }
  /** A side branch with its own commit, a commit here, then a real merge:
   *  the shape that puts a merge on HEAD's first-parent run. */
  | { kind: "diverge" }
  /** Publish HEAD~back to a bare remote under a new branch, so part of the
   *  history is on `refs/remotes/origin/*` and part is not. */
  | { kind: "push"; back: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 5, arbitrary: fc.constant({ kind: "commit" } as const) },
  { weight: 1, arbitrary: fc.constant({ kind: "branch" } as const) },
  { weight: 1, arbitrary: fc.nat(8).map((pick) => ({ kind: "switch", pick }) as const) },
  { weight: 2, arbitrary: fc.nat(8).map((pick) => ({ kind: "merge", pick }) as const) },
  { weight: 2, arbitrary: fc.constant({ kind: "diverge" } as const) },
  { weight: 2, arbitrary: fc.nat(3).map((back) => ({ kind: "push", back }) as const) }
);

/** Every commit in the repository, parsed the way the graph receives them. */
function allCommits(repo: string): Commit[] {
  return git(repo, "log", "--all", "--format=%H %P")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [hash = "", ...parents] = line.split(" ").filter((part) => part !== "");
      return {
        hash,
        shortHash: hash.slice(0, 7),
        parents,
        subject: hash,
        authorName: "Test",
        authorEmail: "test@example.test",
        committedAt: "",
        isMerge: parents.length > 1
      };
    });
}

it("offers exactly the runs the rebase assistant accepts", async () => {
  const empty = realpathSync(mkdtempSync(join(tmpdir(), "pwrgit-history-empty-")));
  roots.push(empty);
  git(empty, "init", "-q", "-b", "main", "--template=");
  git(empty, "config", "user.name", "Test");
  git(empty, "config", "user.email", "test@example.test");
  git(empty, "config", "core.autocrlf", "false");
  git(empty, "config", "gc.auto", "0");

  await fc.assert(
    fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 12 }), async (ops) => {
      const repo = realpathSync(mkdtempSync(join(tmpdir(), "pwrgit-history-range-")));
      roots.push(repo);
      cpSync(join(empty, ".git"), join(repo, ".git"), { recursive: true });
      let n = 0;
      const commit = (): void => {
        n += 1;
        writeFileSync(join(repo, `f${n}.txt`), `${n}\n`);
        git(repo, "add", ".");
        git(repo, "commit", "-qm", `c${n}`);
      };
      commit();
      const branches = ["main"];
      let pushes = 0;
      let remote = false;
      for (const op of ops) {
        if (op.kind === "commit") commit();
        else if (op.kind === "push") {
          if (!remote) {
            remote = true;
            const bare = realpathSync(mkdtempSync(join(tmpdir(), "pwrgit-history-remote-")));
            roots.push(bare);
            git(bare, "init", "-q", "--bare");
            git(repo, "remote", "add", "origin", bare);
          }
          const target = `HEAD~${op.back}`;
          try {
            git(repo, "rev-parse", "--verify", "-q", `${target}^{commit}`);
          } catch {
            continue;
          }
          pushes += 1;
          git(repo, "push", "-q", "origin", `${target}:refs/heads/p${pushes}`);
          git(repo, "fetch", "-q", "origin");
        }
        else if (op.kind === "diverge") {
          const here = git(repo, "rev-parse", "--abbrev-ref", "HEAD");
          const side = `side${branches.length}`;
          git(repo, "switch", "-q", "-c", side);
          commit();
          git(repo, "switch", "-q", here === "HEAD" ? "-" : here);
          commit();
          git(repo, "merge", "-q", "--no-ff", "--no-edit", side);
          branches.push(side);
        } else if (op.kind === "branch") {
          const name = `b${branches.length}`;
          git(repo, "switch", "-q", "-c", name);
          branches.push(name);
        } else {
          const other = branches[op.pick % branches.length] ?? "main";
          if (op.kind === "switch") git(repo, "switch", "-q", other);
          else git(repo, "merge", "-q", "--no-ff", "--no-edit", other);
        }
      }

      const commits = allCommits(repo);
      const head = git(repo, "rev-parse", "HEAD");
      const unpushedResult = await readUnpushedCommits(systemGit, repo, head, 500);
      expect(unpushedResult.ok).toBe(true);
      const unpushed = new Set(unpushedResult.ok ? unpushedResult.value : []);

      const order = git(repo, "log", "--format=%H").split("\n");
      const accepted = new Map<string, string[]>();
      let longest: string[] = [];
      for (let count = 2; count <= order.length; count += 1) {
        const hashes = order.slice(0, count);
        const selection = hashes.map((hash) => ({ hash, subject: hash }));
        if ((await validateSelection(systemGit, repo, selection)).ok) {
          accepted.set(hashes.at(-1)!, hashes);
          longest = hashes;
        }
      }

      const remoteHashes = new Set(longest.filter((hash) =>
        git(repo, "for-each-ref", "--contains", hash, "--format=%(refname)", "refs/remotes") !== ""
      ));
      for (const start of commits) {
        const range = historyRangeFrom(commits, head, start.hash, unpushed);
        const hashes = accepted.get(start.hash);
        expect(range?.kind === "range", `range offered at ${start.hash}`).toBe(hashes !== undefined);
        if (range?.kind === "range") {
          expect(range.hashes).toEqual(hashes);
          expect(range.pushed, `pushed count from ${start.hash}`).toBe(
            range.hashes.filter((hash) => remoteHashes.has(hash)).length
          );
        }
      }

      if (longest.length > 0) {
        const replay = await dryRunRebase(
          systemGit,
          repo,
          longest.map((hash) => ({ hash, subject: hash })),
          "squash",
          { email: "test@example.test", name: "Test" }
        );
        expect(replay.ok, replay.ok ? undefined : replay.error.message).toBe(true);
      }
    }),
    {
      numRuns: 15,
      // A branch that diverged and merged back, with work above the merge.
      examples: [
        [
          [
            { kind: "commit" },
            { kind: "branch" },
            { kind: "commit" },
            { kind: "switch", pick: 0 },
            { kind: "commit" },
            { kind: "merge", pick: 1 },
            { kind: "commit" }
          ]
        ],
        // Published up to HEAD~1, then two local commits on top: a run that
        // is part pushed, part not.
        [
          [
            { kind: "commit" },
            { kind: "commit" },
            { kind: "push", back: 0 },
            { kind: "commit" },
            { kind: "commit" }
          ]
        ]
      ]
    }
  );
}, 180_000);
