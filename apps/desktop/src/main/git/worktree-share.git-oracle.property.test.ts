import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { worktreeAdd } from "./git-service";
import { createSystemGit } from "./test-support/system-git";
import { WorktreeOperationQueue } from "./worktree-operation-queue";
import { worktreeAddWithSharing } from "./worktree-share";

const binary = process.env.PWRGIT_SHARE_REAL_BINARY;
const systemGit = createSystemGit();

// These are real binary + APFS oracle tests; ordinary CI runs the scheduled
// model and fake executable tests without requiring the separate Rust crate.
describe.skipIf(binary === undefined || process.platform !== "darwin")("sharing compared with Git's worktree oracle", () => {
  let root: string;
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "pwrgit-share-oracle-")));
    vi.stubEnv("CARGO_HOME", join(root, "cargo-home"));
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  function git(repo: string, args: string[]): string {
    return execFileSync("git", ["-C", repo, ...args], {
      cwd: tmpdir(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]
    }).trim();
  }
  const registrations = (repo: string) => git(repo, ["worktree", "list", "--porcelain"])
    .split("\n").filter((line) => line.startsWith("worktree ")).map((line) => line.slice(9)).sort();

  it("agrees with ordinary Git for generated repository histories and never drops an existing registration", async () => {
    const scenario = fc.record({
      unborn: fc.boolean(), detached: fc.boolean(), packed: fc.boolean(),
      dirty: fc.boolean(), invalidRef: fc.boolean(), missing: fc.boolean(),
      sharing: fc.boolean(), fallback: fc.boolean(), contents: fc.string({ maxLength: 40 })
    });
    // Each case starts Git and the CLI repeatedly. Twenty generated histories
    // keep this native-only oracle within the real-Git suite's process budget.
    await fc.assert(fc.asyncProperty(scenario, async (state) => {
      const fixture = mkdtempSync(join(root, "case-"));
      const repo = join(fixture, "repo");
      mkdirSync(repo);
      try {
        git(repo, ["init", "-b", "main"]);
        git(repo, ["config", "user.name", "Fixture"]);
        git(repo, ["config", "user.email", "fixture@example.invalid"]);
        git(repo, ["config", "core.autocrlf", "false"]);
        const committed = state.contents + "\n";
        if (!state.unborn) {
          writeFileSync(join(repo, "source.txt"), committed);
          git(repo, ["add", "."]);
          git(repo, ["commit", "-m", "fixture"]);
          if (state.detached) git(repo, ["checkout", "--detach", "HEAD"]);
          if (state.packed) git(repo, ["pack-refs", "--all"]);
          if (state.dirty) writeFileSync(join(repo, "source.txt"), "private fixture edit\n");
        }
        vi.stubEnv("PWRGIT_SHARE_FORCE_NONE", state.fallback ? "1" : undefined);
        const shared = join(fixture, "managed", "shared");
        const plain = join(fixture, "managed", "plain");
        const startPoint = state.invalidRef ? "missing-ref" : "HEAD";
        const options = { newBranch: true, startPoint };
        const settings = { worktreeReflink: state.sharing ? "on" as const : "off" as const, worktreeShareCommand: resolve(binary!) };
        const queue = new WorktreeOperationQueue();
        const actual = await queue.runRepository(repo, () => worktreeAddWithSharing(
          systemGit, repo, shared, "shared", options, settings, () => undefined
        ));
        const oracle = await worktreeAdd(systemGit, repo, plain, "plain", options);
        expect(actual.ok).toBe(oracle.ok);
        expect(registrations(repo)).toEqual([repo, ...(oracle.ok ? [plain, shared] : [])].sort());
        if (oracle.ok) {
          expect(git(shared, ["rev-parse", "HEAD"])).toBe(git(plain, ["rev-parse", "HEAD"]));
          expect(git(shared, ["status", "--porcelain"])).toBe(git(plain, ["status", "--porcelain"]));
          expect(readFileSync(join(shared, "source.txt"), "utf8")).toBe(committed);
          if (state.missing) await rm(shared, { recursive: true, force: true });
          const before = registrations(repo);
          const collision = await queue.runRepository(repo, () => worktreeAddWithSharing(
            systemGit, repo, shared, "shared", { newBranch: false }, settings, () => undefined
          ));
          expect(collision.ok).toBe(false);
          expect(registrations(repo)).toEqual(before);
        }
      } finally {
        await rm(fixture, { recursive: true, force: true });
      }
    }), { numRuns: 20 });
  });
});
