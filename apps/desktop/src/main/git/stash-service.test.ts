import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PWRGIT_PULL_STASH_MESSAGE,
  ok
} from "@pwrgit/shared";
import { gitProcessInvocation, type GitExec } from "./dugite";
import { createSystemGit } from "./test-support/system-git";
import {
  applyStash,
  createStash,
  dropStash,
  listStashes,
  parseStashNumstat,
  popStash,
  readStashDetails,
  readStashPatch
} from "./stash-service";

const systemGit = createSystemGit();

function git(repo: string, args: string[]): string {
  const invocation = gitProcessInvocation(args, repo);
  return execFileSync("git", invocation.args, {
    cwd: invocation.processCwd, encoding: "utf8"
  }).trim();
}

describe("stash service (system git)", () => {
  let root: string;
  let repo: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pwrgit-stashes-"));
    repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.name", "PwrGit Test"]);
    git(repo, ["config", "user.email", "pwrgit@example.com"]);
    git(repo, ["config", "core.autocrlf", "false"]);
    writeFileSync(join(repo, "README.md"), "baseline\n");
    writeFileSync(join(repo, "other.txt"), "other baseline\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "baseline"]);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  async function save(name: string, file = "README.md"): Promise<string> {
    writeFileSync(join(repo, file), name + "\n");
    git(repo, ["stash", "push", "-m", name]);
    return git(repo, ["rev-parse", "refs/stash"]);
  }

  it("drops the selected hash after a CLI push renumbers it before locking", async () => {
    const selected = await save("selected");
    let pushed = "";
    const racingGit: GitExec = async (args, cwd, options) => {
      const result = await systemGit(args, cwd, options);
      if (args.includes("--git-common-dir")) pushed = await save("CLI");
      return result;
    };
    expect(await dropStash(racingGit, repo, selected)).toEqual(ok(undefined));
    expect(git(repo, ["stash", "list", "--format=%H"])).toBe(pushed);
    expect(git(repo, ["rev-parse", "refs/stash"])).toBe(pushed);
  });

  it("refuses removal when the CLI drops the selected entry before locking", async () => {
    await save("older");
    const selected = await save("selected");
    let remaining = "";
    const racingGit: GitExec = async (args, cwd, options) => {
      const result = await systemGit(args, cwd, options);
      if (args.includes("--git-common-dir")) {
        git(repo, ["stash", "drop"]);
        remaining = git(repo, ["stash", "list", "--format=%H"]);
      }
      return result;
    };
    expect(await dropStash(racingGit, repo, selected)).toMatchObject({
      ok: false, error: { code: "not_found" }
    });
    expect(git(repo, ["stash", "list", "--format=%H"])).toBe(remaining);
  });

  it("applies the selected content even if a CLI push changes the top entry", async () => {
    const selected = await save("selected");
    const racingGit: GitExec = async (args, cwd, options) => {
      if (args[0] === "stash" && args[1] === "apply") await save("CLI");
      return systemGit(args, cwd, options);
    };
    expect(await applyStash(racingGit, repo, selected)).toEqual(ok(undefined));
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("selected\n");
    expect(git(repo, ["stash", "list", "--format=%H"]).split("\n")).toHaveLength(2);
  });

  it("updates the tip when removing the top and leaves the older stash usable by Git", async () => {
    const older = await save("older");
    const selected = await save("selected", "other.txt");
    expect(await dropStash(systemGit, repo, selected)).toEqual(ok(undefined));
    expect(git(repo, ["rev-parse", "refs/stash"])).toBe(older);
    expect(git(repo, ["stash", "list", "--format=%H"])).toBe(older);
    git(repo, ["stash", "pop"]);
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("older\n");
    expect(readFileSync(join(repo, "other.txt"), "utf8")).toBe("other baseline\n");
  });

  it("says a pop applied when only the removal failed, and releases every lock", async () => {
    const selected = await save("selected");
    const gitDir = join(repo, ".git");
    const log = join(gitDir, "logs", "refs", "stash");
    const racingGit: GitExec = async (args, cwd, options) => {
      const result = await systemGit(args, cwd, options);
      if (args[0] === "stash" && args[1] === "apply") {
        // A directory where the reflog was: committing the rewritten log fails.
        rmSync(log);
        mkdirSync(log);
        writeFileSync(join(log, "blocker"), "");
      }
      return result;
    };
    expect(await popStash(racingGit, repo, selected)).toMatchObject({
      ok: false,
      error: { code: "stash_applied_not_removed" }
    });
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("selected\n");
    for (const lock of ["refs/stash.lock", "packed-refs.lock", "logs/refs/stash.lock"]) {
      expect(existsSync(join(gitDir, lock))).toBe(false);
    }
  });

  it("holds Git's shared stash lock throughout pop from another worktree", async () => {
    const selected = await save("selected");
    const linked = join(root, "linked");
    git(repo, ["worktree", "add", "-b", "linked", linked]);
    let checkedLock = false;
    const racingGit: GitExec = async (args, cwd, options) => {
      if (args[0] === "stash" && args[1] === "apply") {
        expect(args[2]).toBe(selected);
        for (const command of [
          ["stash", "drop"],
          ["stash", "store", "-m", "concurrent", selected]
        ]) {
          const competing = await systemGit(command, repo);
          expect(competing.ok && competing.value.exitCode === 0).toBe(false);
        }
        checkedLock = true;
      }
      return systemGit(args, cwd, options);
    };
    expect(await popStash(racingGit, linked, selected)).toEqual(ok(undefined));
    expect(checkedLock).toBe(true);
    expect(readFileSync(join(linked, "README.md"), "utf8")).toBe("selected\n");
    expect(git(repo, ["stash", "list"])).toBe("");
    expect(existsSync(join(repo, ".git", "refs", "stash"))).toBe(false);
    // Ordinary Git can create and pop the next entry after the stack empties.
    await save("next");
    git(repo, ["stash", "pop"]);
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("next\n");
  });

  it("preserves foreign locks and refuses duplicate or packed stash refs", async () => {
    const selected = await save("selected");
    const lock = join(repo, ".git", "refs", "stash.lock");
    writeFileSync(lock, "foreign lock");
    expect((await dropStash(systemGit, repo, selected)).ok).toBe(false);
    expect(readFileSync(lock, "utf8")).toBe("foreign lock");
    rmSync(lock);
    await save("between", "other.txt");
    git(repo, ["stash", "store", "-m", "duplicate", selected]);
    expect(await popStash(systemGit, repo, selected)).toMatchObject({
      ok: false, error: { code: "ambiguous_stash" }
    });
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("baseline\n");
    git(repo, ["stash", "drop"]);
    git(repo, ["stash", "drop"]);
    git(repo, ["pack-refs", "--all"]);
    expect(await popStash(systemGit, repo, selected)).toMatchObject({
      ok: false, error: { code: "unsupported_stash_storage" }
    });
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("baseline\n");
    expect(git(repo, ["stash", "list", "--format=%H"])).toBe(selected);
  });

  it("lists one shared ordered stack from multiple worktrees with metadata and details", async () => {
    writeFileSync(join(repo, "README.md"), "baseline\nordinary edit\n");
    writeFileSync(join(repo, "new.txt"), "untracked\n");
    await expect(
      createStash(systemGit, repo, "ordinary named work", true)
    ).resolves.toEqual(ok(true));

    const linked = join(root, "linked");
    git(repo, ["worktree", "add", "-b", "feature/recovery", linked]);
    writeFileSync(join(linked, "other.txt"), "recovery edit\n");
    await expect(
      createStash(systemGit, linked, PWRGIT_PULL_STASH_MESSAGE, false)
    ).resolves.toEqual(ok(true));

    const fromPrimary = await listStashes(systemGit, repo);
    const fromLinked = await listStashes(systemGit, linked);
    expect(fromPrimary).toEqual(fromLinked);
    expect(fromPrimary.ok).toBe(true);
    if (!fromPrimary.ok) return;
    expect(fromPrimary.value).toHaveLength(2);
    expect(fromPrimary.value[0]).toMatchObject({
      selector: "stash@{0}",
      branch: "feature/recovery",
      name: PWRGIT_PULL_STASH_MESSAGE,
      kind: "pwrgit-pull-recovery"
    });
    expect(fromPrimary.value[1]).toMatchObject({
      selector: "stash@{1}",
      branch: "main",
      name: "ordinary named work",
      kind: "ordinary"
    });

    const ordinary = fromPrimary.value[1];
    if (ordinary === undefined) throw new Error("missing ordinary stash");
    const details = await readStashDetails(systemGit, linked, ordinary);
    expect(details).toMatchObject({
      ok: true,
      value: {
        additions: 2,
        deletions: 0,
        files: expect.arrayContaining([
          { path: "README.md", additions: 1, deletions: 0 },
          { path: "new.txt", additions: 1, deletions: 0 }
        ])
      }
    });
    const patch = await readStashPatch(systemGit, repo, ordinary.hash);
    expect(patch).toMatchObject({ ok: true });
    if (patch.ok) {
      expect(patch.value).toContain("ordinary edit");
      expect(patch.value).toContain("diff --git a/new.txt b/new.txt");
    }
  });

  it("applies and drops a selected non-top entry without touching the top entry", async () => {
    writeFileSync(join(repo, "README.md"), "first stash\n");
    await createStash(systemGit, repo, "older", false);
    writeFileSync(join(repo, "other.txt"), "second stash\n");
    await createStash(systemGit, repo, "newer", false);
    const before = await listStashes(systemGit, repo);
    if (!before.ok) throw new Error(before.error.message);
    const newerHash = before.value[0]?.hash;
    const older = before.value[1];
    if (newerHash === undefined || older === undefined) {
      throw new Error("expected two stashes");
    }

    await expect(
      applyStash(systemGit, repo, older.hash)
    ).resolves.toEqual(ok(undefined));
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("first stash\n");
    expect((await listStashes(systemGit, repo))).toEqual(before);

    git(repo, ["reset", "--hard", "HEAD"]);
    await expect(
      dropStash(systemGit, repo, older.hash)
    ).resolves.toEqual(ok(undefined));
    const after = await listStashes(systemGit, repo);
    expect(after).toMatchObject({
      ok: true,
      value: [{ selector: "stash@{0}", hash: newerHash }]
    });
  });

  it("marks repeated reflog occurrences of the same stash commit", async () => {
    writeFileSync(join(repo, "README.md"), "repeated stash\n");
    await createStash(systemGit, repo, "original", false);
    const original = await listStashes(systemGit, repo);
    if (!original.ok || original.value[0] === undefined) {
      throw new Error("expected original stash");
    }
    const repeatedHash = original.value[0].hash;

    writeFileSync(join(repo, "other.txt"), "different stash\n");
    await createStash(systemGit, repo, "between", false);
    git(repo, ["stash", "store", "-m", "stored again", repeatedHash]);

    const listed = await listStashes(systemGit, repo);
    expect(listed).toMatchObject({
      ok: true,
      value: [
        { selector: "stash@{0}", hash: repeatedHash, occurrenceCount: 2 },
        { selector: "stash@{1}", occurrenceCount: 1 },
        { selector: "stash@{2}", hash: repeatedHash, occurrenceCount: 2 }
      ]
    });
  });

  it("keeps a PwrGit pull recovery stash when pop conflicts", async () => {
    writeFileSync(join(repo, "README.md"), "stashed side\n");
    await createStash(systemGit, repo, PWRGIT_PULL_STASH_MESSAGE, false);
    writeFileSync(join(repo, "README.md"), "upstream side\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "conflicting upstream"]);

    const listed = await listStashes(systemGit, repo);
    if (!listed.ok || listed.value[0] === undefined) {
      throw new Error("expected recovery stash");
    }
    const popped = await popStash(systemGit, repo, listed.value[0].hash);
    expect(popped.ok).toBe(false);
    expect(git(repo, ["diff", "--name-only", "--diff-filter=U"])).toBe(
      "README.md"
    );
    const kept = await listStashes(systemGit, repo);
    expect(kept).toMatchObject({
      ok: true,
      value: [
        {
          hash: listed.value[0].hash,
          kind: "pwrgit-pull-recovery"
        }
      ]
    });
  });

  it("makes untracked inclusion explicit", async () => {
    const untracked = join(repo, "only-untracked.txt");
    writeFileSync(untracked, "new\n");
    await expect(
      createStash(systemGit, repo, "tracked only", false)
    ).resolves.toEqual(ok(false));
    expect(existsSync(untracked)).toBe(true);
    await expect(
      createStash(systemGit, repo, "include new files", true)
    ).resolves.toEqual(ok(true));
    expect(existsSync(untracked)).toBe(false);
  });
});

describe("parseStashNumstat", () => {
  it("preserves tabs in NUL-delimited paths and marks binary files", () => {
    expect(
      parseStashNumstat("2\t1\tdocs/a\tb.md\0-\t-\timage.png\0")
    ).toEqual([
      { path: "docs/a\tb.md", additions: 2, deletions: 1 },
      { path: "image.png", additions: null, deletions: null }
    ]);
  });
});
