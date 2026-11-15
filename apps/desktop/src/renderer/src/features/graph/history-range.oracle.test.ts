import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterEach, expect, it } from "vitest";
import type { Commit } from "@pwrgit/shared";
import { historyRangeFrom } from "./history-range";
import { dryRunRebase } from "../../../../main/git/rebase-assistant";
import { createSystemGit } from "../../../../main/git/test-support/system-git";

/**
 * Rule: the lineage's "Edit history from here" offers exactly the runs the
 * rebase assistant can rewrite. The oracle is the assistant's own isolated
 * check (`dryRunRebase`, a squash in a throwaway clone), which runs
 * `validateSelection` and then real Git cherry-picks. `validateSelection`
 * alone is not enough: it accepts a run holding a merge, which the
 * cherry-pick then refuses.
 *
 * - Sound: every run the menu offers passes the check.
 * - Complete: every top-N run of `git log` that passes it is offered when its
 *   oldest commit is right-clicked, with the same commits.
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
  | { kind: "merge"; pick: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 5, arbitrary: fc.constant({ kind: "commit" } as const) },
  { weight: 1, arbitrary: fc.constant({ kind: "branch" } as const) },
  { weight: 1, arbitrary: fc.nat(8).map((pick) => ({ kind: "switch", pick }) as const) },
  { weight: 2, arbitrary: fc.nat(8).map((pick) => ({ kind: "merge", pick }) as const) }
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
  await fc.assert(
    fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 12 }), async (ops) => {
      const repo = realpathSync(mkdtempSync(join(tmpdir(), "pwrgit-history-range-")));
      roots.push(repo);
      git(repo, "init", "-q", "-b", "main");
      git(repo, "config", "user.name", "Test");
      git(repo, "config", "user.email", "test@example.test");
      git(repo, "config", "core.autocrlf", "false");
      git(repo, "config", "gc.auto", "0");
      let n = 0;
      const commit = (): void => {
        n += 1;
        writeFileSync(join(repo, `f${n}.txt`), `${n}\n`);
        git(repo, "add", ".");
        git(repo, "commit", "-qm", `c${n}`);
      };
      commit();
      const branches = ["main"];
      for (const op of ops) {
        if (op.kind === "commit") commit();
        else if (op.kind === "branch") {
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

      const checked = new Map<string, boolean>();
      const accepts = async (hashes: string[]): Promise<boolean> => {
        const key = hashes.join(",");
        const known = checked.get(key);
        if (known !== undefined) return known;
        const result = await dryRunRebase(
          systemGit,
          repo,
          hashes.map((hash) => ({ hash, subject: hash })),
          "squash",
          { email: "test@example.test", name: "Test" }
        );
        checked.set(key, result.ok);
        return result.ok;
      };

      // Sound: whatever is offered, the assistant can rewrite.
      for (const start of commits) {
        const range = historyRangeFrom(commits, head, start.hash);
        if (range?.kind !== "range") continue;
        expect(range.hashes.length).toBeGreaterThanOrEqual(2);
        expect(range.hashes[0]).toBe(head);
        expect(range.hashes.at(-1)).toBe(start.hash);
        expect(await accepts(range.hashes), `offered ${range.hashes.join(",")}`).toBe(true);
      }

      // Complete: every run the assistant can rewrite is offered.
      const order = git(repo, "log", "--format=%H").split("\n");
      for (let count = 2; count <= order.length; count += 1) {
        const top = order.slice(0, count);
        if (!(await accepts(top))) continue;
        const range = historyRangeFrom(commits, head, top[count - 1] ?? "");
        expect(range?.kind, `top ${count} accepted but not offered`).toBe("range");
        if (range?.kind === "range") expect(new Set(range.hashes)).toEqual(new Set(top));
      }
    }),
    {
      numRuns: 15,
      // A branch that diverged and merged back, with work on top: the run
      // from below the merge holds it, and only the cherry-pick refuses it.
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
        ]
      ]
    }
  );
}, 180_000);
