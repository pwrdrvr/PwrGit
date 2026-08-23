import { spawnSync } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  abortConflictOperation,
  acceptConflictSide,
  CONFLICT_TEXT_PREVIEW_LIMIT,
  continueConflictOperation,
  inspectConflict,
  parseUnmergedIndex,
  readConflictState,
  stageConflictResolution,
  writeConflictWorkingFile
} from "./conflict-service";
import {
  conflictSystemGit,
  conflictSystemGitBinary,
  createConflictTestFixture,
  type ConflictTestFixture,
  type ConflictTestOperation
} from "./conflict-test-fixture";
import type { GitExecBinary } from "./dugite";

let fixture: ConflictTestFixture | null = null;

afterEach(() => {
  fixture?.cleanup();
  fixture = null;
});

describe("conflict operation detection (real Git)", () => {
  it.each([
    "merge",
    "rebase",
    "am",
    "cherry-pick",
    "revert"
  ] satisfies ConflictTestOperation[])("detects an in-progress %s", async (kind) => {
    fixture = createConflictTestFixture();
    fixture.start(kind);

    const state = await readConflictState(conflictSystemGit, fixture.repo);

    expect(state.ok).toBe(true);
    if (!state.ok) return;
    expect(state.value.operation?.kind).toBe(kind);
    expect(state.value.conflicts.map((entry) => entry.path)).toEqual([
      "alpha.txt",
      "beta.txt"
    ]);
    expect(state.value.conflicts.every((entry) => entry.base !== null)).toBe(true);
    expect(state.value.conflicts.every((entry) => entry.ours !== null)).toBe(true);
    expect(state.value.conflicts.every((entry) => entry.theirs !== null)).toBe(true);
  });

  it("aborts an in-progress git am with git am --abort", async () => {
    fixture = createConflictTestFixture();
    fixture.start("am");

    await expect(
      abortConflictOperation(conflictSystemGit, fixture.repo, "am")
    ).resolves.toEqual({ ok: true, value: undefined });

    expect(fixture.run("rev-parse", "HEAD")).toBe(fixture.mainHead);
    await expect(readConflictState(conflictSystemGit, fixture.repo)).resolves.toEqual({
      ok: true,
      value: { operation: null, conflicts: [] }
    });
  });
});

describe("conflict resolution (real Git)", () => {
  it("aborts back to the exact pre-merge head while preserving an unrelated edit", async () => {
    fixture = createConflictTestFixture();
    writeFileSync(join(fixture.repo, "keep.txt"), "unrelated local edit\n");
    fixture.start("merge");

    await expect(
      abortConflictOperation(conflictSystemGit, fixture.repo, "merge")
    ).resolves.toEqual({ ok: true, value: undefined });

    expect(fixture.run("rev-parse", "HEAD")).toBe(fixture.mainHead);
    expect(readFileSync(join(fixture.repo, "alpha.txt"), "utf8")).toBe(
      "main alpha\n"
    );
    expect(readFileSync(join(fixture.repo, "keep.txt"), "utf8")).toBe(
      "unrelated local edit\n"
    );
    const state = await readConflictState(conflictSystemGit, fixture.repo);
    expect(state).toEqual({ ok: true, value: { operation: null, conflicts: [] } });
  });

  it("resolves only the explicitly accepted path", async () => {
    fixture = createConflictTestFixture();
    fixture.start("merge");
    const before = await readConflictState(conflictSystemGit, fixture.repo);
    if (!before.ok) throw new Error(before.error.message);
    const alpha = before.value.conflicts.find((entry) => entry.path === "alpha.txt");
    if (alpha?.ours === undefined) throw new Error("alpha conflict missing");

    await expect(
      acceptConflictSide(conflictSystemGit, fixture.repo, {
        path: "alpha.txt",
        side: "ours",
        expectedOid: alpha.ours?.oid ?? null
      })
    ).resolves.toEqual({ ok: true, value: undefined });

    expect(readFileSync(join(fixture.repo, "alpha.txt"), "utf8")).toBe(
      "main alpha\n"
    );
    const after = await readConflictState(conflictSystemGit, fixture.repo);
    expect(after.ok && after.value.conflicts.map((entry) => entry.path)).toEqual([
      "beta.txt"
    ]);
  });

  it("treats a conflicted filename as a literal path when accepting a side", async () => {
    fixture = createConflictTestFixture();
    const magicPath = "[partial].txt";
    const relatedPathspecMatch = "p.txt";
    writeFileSync(join(fixture.repo, magicPath), "base magic\n");
    writeFileSync(join(fixture.repo, relatedPathspecMatch), "keep p\n");
    fixture.run("--literal-pathspecs", "add", "--", magicPath, relatedPathspecMatch);
    fixture.run("commit", "-m", "add magic path base");
    fixture.run("switch", "-c", "magic-topic");
    writeFileSync(join(fixture.repo, magicPath), "topic magic\n");
    fixture.run("--literal-pathspecs", "add", "--", magicPath);
    fixture.run("commit", "-m", "topic edits magic path");
    fixture.run("switch", "main");
    writeFileSync(join(fixture.repo, magicPath), "main magic\n");
    fixture.run("--literal-pathspecs", "add", "--", magicPath);
    fixture.run("commit", "-m", "main edits magic path");
    expect(() => fixture?.run("merge", "magic-topic")).toThrow();
    writeFileSync(join(fixture.repo, relatedPathspecMatch), "unrelated edit\n");

    const before = await readConflictState(conflictSystemGit, fixture.repo);
    if (!before.ok) throw new Error(before.error.message);
    const conflict = before.value.conflicts.find(
      (entry) => entry.path === magicPath
    );
    if (conflict?.theirs === undefined) throw new Error("magic conflict missing");
    await expect(
      acceptConflictSide(conflictSystemGit, fixture.repo, {
        path: magicPath,
        side: "theirs",
        expectedOid: conflict.theirs?.oid ?? null
      })
    ).resolves.toEqual({ ok: true, value: undefined });

    expect(readFileSync(join(fixture.repo, magicPath), "utf8")).toBe(
      "topic magic\n"
    );
    expect(readFileSync(join(fixture.repo, relatedPathspecMatch), "utf8")).toBe(
      "unrelated edit\n"
    );
    expect(fixture.run("ls-files", "--unmerged", "--", magicPath)).toBe("");
    expect(fixture.run("diff", "--cached", "--name-only")).toBe(magicPath);
    expect(fixture.run("diff", "--name-only")).toBe(relatedPathspecMatch);
  });

  it("treats a conflicted filename as literal when accepting a deletion", async () => {
    fixture = createConflictTestFixture();
    const repo = fixture.repo;
    const magicPath = "[partial].txt";
    const relatedPathspecMatch = "p.txt";
    writeFileSync(join(fixture.repo, magicPath), "base magic\n");
    writeFileSync(join(fixture.repo, relatedPathspecMatch), "keep p\n");
    fixture.run("--literal-pathspecs", "add", "--", magicPath, relatedPathspecMatch);
    fixture.run("commit", "-m", "add delete conflict base");
    fixture.run("switch", "-c", "delete-topic");
    writeFileSync(join(fixture.repo, magicPath), "topic modifies magic\n");
    fixture.run("--literal-pathspecs", "add", "--", magicPath);
    fixture.run("commit", "-m", "topic modifies magic");
    fixture.run("switch", "main");
    fixture.run("--literal-pathspecs", "rm", "--", magicPath);
    fixture.run("commit", "-m", "main deletes magic");
    expect(() => fixture?.run("merge", "delete-topic")).toThrow();

    const before = await readConflictState(conflictSystemGit, fixture.repo);
    if (!before.ok) throw new Error(before.error.message);
    const conflict = before.value.conflicts.find(
      (entry) => entry.path === magicPath
    );
    expect(conflict?.ours).toBeNull();
    await expect(
      acceptConflictSide(conflictSystemGit, fixture.repo, {
        path: magicPath,
        side: "ours",
        expectedOid: null
      })
    ).resolves.toEqual({ ok: true, value: undefined });

    expect(() => readFileSync(join(repo, magicPath))).toThrow();
    expect(readFileSync(join(repo, relatedPathspecMatch), "utf8")).toBe(
      "keep p\n"
    );
    expect(fixture.run("ls-files", "--unmerged", "--", magicPath)).toBe("");
    expect(fixture.run("diff", "--cached", "--name-only")).toBe("");
  });

  it("accepts a genuinely missing side as an explicit staged deletion", async () => {
    fixture = createConflictTestFixture();
    const repo = fixture.repo;
    fixture.run("rm", "alpha.txt");
    fixture.run("commit", "-m", "delete alpha on main");
    fixture.start("merge");
    const before = await readConflictState(conflictSystemGit, fixture.repo);
    if (!before.ok) throw new Error(before.error.message);
    const alpha = before.value.conflicts.find((entry) => entry.path === "alpha.txt");
    expect(alpha?.kind).toBe("delete_or_rename_by_ours");
    expect(alpha?.ours).toBeNull();

    await expect(
      acceptConflictSide(conflictSystemGit, fixture.repo, {
        path: "alpha.txt",
        side: "ours",
        expectedOid: null
      })
    ).resolves.toEqual({ ok: true, value: undefined });

    const after = await readConflictState(conflictSystemGit, fixture.repo);
    expect(after.ok && after.value.conflicts.some((entry) => entry.path === "alpha.txt"))
      .toBe(false);
    expect(() => readFileSync(join(repo, "alpha.txt"))).toThrow();
  });

  it("classifies a real add/add conflict with no invented base stage", async () => {
    fixture = createConflictTestFixture();
    fixture.run("switch", "topic");
    writeFileSync(join(fixture.repo, "new-on-both.txt"), "topic addition\n");
    fixture.run("add", "new-on-both.txt");
    fixture.run("commit", "-m", "topic adds shared path");
    fixture.run("switch", "main");
    writeFileSync(join(fixture.repo, "new-on-both.txt"), "main addition\n");
    fixture.run("add", "new-on-both.txt");
    fixture.run("commit", "-m", "main adds shared path");
    fixture.start("merge");

    const state = await readConflictState(conflictSystemGit, fixture.repo);
    if (!state.ok) throw new Error(state.error.message);
    expect(
      state.value.conflicts.find((entry) => entry.path === "new-on-both.txt")
    ).toMatchObject({
      kind: "both_added",
      base: null,
      ours: { stage: 2 },
      theirs: { stage: 3 }
    });
  });

  it("reports real binary stages without decoding replacement text", async () => {
    fixture = createConflictTestFixture();
    writeFileSync(join(fixture.repo, "binary.dat"), Buffer.from([0, 1, 2, 3]));
    fixture.run("add", "binary.dat");
    fixture.run("commit", "-m", "binary base");
    fixture.run("switch", "-c", "binary-topic");
    writeFileSync(join(fixture.repo, "binary.dat"), Buffer.from([0, 4, 5, 6]));
    fixture.run("add", "binary.dat");
    fixture.run("commit", "-m", "binary topic");
    fixture.run("switch", "main");
    writeFileSync(join(fixture.repo, "binary.dat"), Buffer.from([0, 7, 8, 9]));
    fixture.run("add", "binary.dat");
    fixture.run("commit", "-m", "binary main");
    expect(() => fixture?.run("merge", "binary-topic")).toThrow();

    const inspected = await inspectConflict(
      conflictSystemGit,
      conflictSystemGitBinary,
      fixture.repo,
      "binary.dat"
    );

    expect(inspected.ok).toBe(true);
    if (!inspected.ok) return;
    expect(inspected.value.base?.content.kind).toBe("binary");
    expect(inspected.value.ours?.content.kind).toBe("binary");
    expect(inspected.value.theirs?.content.kind).toBe("binary");
    expect(inspected.value.workingTree?.content.kind).toBe("binary");
    expect(inspected.value.workingTree?.editable).toBe(false);
  });

  it("size-checks large stages and working files before reading content", async () => {
    fixture = createConflictTestFixture();
    const tail = "unchanged line\n".repeat(
      Math.ceil(CONFLICT_TEXT_PREVIEW_LIMIT / "unchanged line\n".length)
    );
    writeFileSync(join(fixture.repo, "large.txt"), `base line\n${tail}`);
    fixture.run("add", "large.txt");
    fixture.run("commit", "-m", "large conflict base");
    fixture.run("switch", "-c", "large-topic");
    writeFileSync(join(fixture.repo, "large.txt"), `topic line\n${tail}`);
    fixture.run("add", "large.txt");
    fixture.run("commit", "-m", "large topic");
    fixture.run("switch", "main");
    writeFileSync(join(fixture.repo, "large.txt"), `main line\n${tail}`);
    fixture.run("add", "large.txt");
    fixture.run("commit", "-m", "large main");
    expect(() => fixture?.run("merge", "large-topic")).toThrow();
    let binaryReads = 0;
    const guardedBinary: GitExecBinary = async (args, cwd) => {
      binaryReads += 1;
      return conflictSystemGitBinary(args, cwd);
    };

    const inspected = await inspectConflict(
      conflictSystemGit,
      guardedBinary,
      fixture.repo,
      "large.txt"
    );

    expect(inspected.ok).toBe(true);
    if (!inspected.ok) return;
    expect(inspected.value.base?.content.kind).toBe("too-large");
    expect(inspected.value.ours?.content.kind).toBe("too-large");
    expect(inspected.value.theirs?.content.kind).toBe("too-large");
    expect(inspected.value.workingTree?.content.kind).toBe("too-large");
    expect(inspected.value.workingTree?.editable).toBe(false);
    expect(binaryReads).toBe(0);
  });

  it("previews and accepts a gitlink by its reviewed index OID", async () => {
    fixture = createConflictTestFixture();
    fixture.start("merge");
    const baseOid = fixture.run("merge-base", "main", "topic");
    const path = "modules/dependency";
    const indexInfo = [
      `160000 ${baseOid} 1\t${path}\n`,
      `160000 ${fixture.mainHead} 2\t${path}\n`,
      `160000 ${fixture.topicHead} 3\t${path}\n`
    ].join("");
    const updated = spawnSync("git", ["update-index", "--index-info"], {
      cwd: fixture.repo,
      input: indexInfo,
      encoding: "utf8"
    });
    if (updated.status !== 0) {
      throw new Error(updated.stderr || "failed to add gitlink conflict");
    }

    const inspected = await inspectConflict(
      conflictSystemGit,
      conflictSystemGitBinary,
      fixture.repo,
      path
    );
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) return;
    expect(inspected.value.theirs).toMatchObject({
      mode: "160000",
      oid: fixture.topicHead,
      content: {
        kind: "unavailable",
        reason: expect.stringContaining(fixture.topicHead)
      }
    });

    await expect(
      acceptConflictSide(conflictSystemGit, fixture.repo, {
        path,
        side: "theirs",
        expectedOid: fixture.topicHead
      })
    ).resolves.toEqual({ ok: true, value: undefined });
    expect(fixture.run("ls-files", "--stage", "--", path)).toBe(
      `160000 ${fixture.topicHead} 0\t${path}`
    );
  });

  it("reports a deterministic continue failure and leaves the merge recoverable", async () => {
    fixture = createConflictTestFixture();
    fixture.start("merge");
    const state = await readConflictState(conflictSystemGit, fixture.repo);
    if (!state.ok) throw new Error(state.error.message);
    for (const conflict of state.value.conflicts) {
      const resolved = await acceptConflictSide(conflictSystemGit, fixture.repo, {
        path: conflict.path,
        side: "theirs",
        expectedOid: conflict.theirs?.oid ?? null
      });
      if (!resolved.ok) throw new Error(resolved.error.message);
    }
    fixture.run("config", "user.useConfigOnly", "true");
    fixture.run("config", "--unset", "user.name");
    fixture.run("config", "--unset", "user.email");

    const continued = await continueConflictOperation(
      conflictSystemGit,
      fixture.repo,
      "merge"
    );

    expect(continued.ok).toBe(false);
    if (continued.ok) return;
    expect(continued.error.code).toBe("continue_failed");
    expect(continued.error.message.toLowerCase()).toMatch(/identity|email|name/);
    const after = await readConflictState(conflictSystemGit, fixture.repo);
    expect(after.ok && after.value.operation?.kind).toBe("merge");
    expect(after.ok && after.value.conflicts).toEqual([]);
  });

  it("sees an external edit and stage as a complete resolution on refresh", async () => {
    fixture = createConflictTestFixture();
    fixture.start("merge");
    const before = await readConflictState(conflictSystemGit, fixture.repo);
    expect(before.ok && before.value.conflicts).toHaveLength(2);

    writeFileSync(join(fixture.repo, "alpha.txt"), "resolved externally\n");
    fixture.run("add", "alpha.txt");

    const after = await readConflictState(conflictSystemGit, fixture.repo);
    expect(after.ok && after.value.conflicts.map((entry) => entry.path)).toEqual([
      "beta.txt"
    ]);
  });

  it("refuses to overwrite a newer external edit from a stale inline preview", async () => {
    fixture = createConflictTestFixture();
    fixture.start("merge");
    const inspected = await inspectConflict(
      conflictSystemGit,
      conflictSystemGitBinary,
      fixture.repo,
      "alpha.txt"
    );
    if (!inspected.ok || inspected.value.workingTree === null) {
      throw new Error("working preview missing");
    }
    writeFileSync(join(fixture.repo, "alpha.txt"), "newer editor contents\n");

    const saved = await writeConflictWorkingFile(conflictSystemGit, fixture.repo, {
      path: "alpha.txt",
      text: "stale PwrGit edit\n",
      expectedContentHash: inspected.value.workingTree.contentHash
    });

    expect(saved.ok).toBe(false);
    if (!saved.ok) expect(saved.error.code).toBe("working_file_changed");
    expect(readFileSync(join(fixture.repo, "alpha.txt"), "utf8")).toBe(
      "newer editor contents\n"
    );
  });

  it("stages an intentional external deletion", async () => {
    fixture = createConflictTestFixture();
    fixture.start("merge");
    unlinkSync(join(fixture.repo, "alpha.txt"));

    await expect(
      stageConflictResolution(conflictSystemGit, fixture.repo, "alpha.txt")
    ).resolves.toEqual({ ok: true, value: undefined });
    const state = await readConflictState(conflictSystemGit, fixture.repo);
    expect(state.ok && state.value.conflicts.map((entry) => entry.path)).toEqual([
      "beta.txt"
    ]);
  });

  it("stages only a literal conflicted path after an external resolution", async () => {
    fixture = createConflictTestFixture();
    const magicPath = "[partial].txt";
    const relatedPathspecMatch = "p.txt";
    writeFileSync(join(fixture.repo, magicPath), "base magic\n");
    writeFileSync(join(fixture.repo, relatedPathspecMatch), "keep p\n");
    fixture.run("--literal-pathspecs", "add", "--", magicPath, relatedPathspecMatch);
    fixture.run("commit", "-m", "manual magic base");
    fixture.run("switch", "-c", "manual-topic");
    writeFileSync(join(fixture.repo, magicPath), "topic magic\n");
    fixture.run("--literal-pathspecs", "add", "--", magicPath);
    fixture.run("commit", "-m", "manual topic");
    fixture.run("switch", "main");
    writeFileSync(join(fixture.repo, magicPath), "main magic\n");
    fixture.run("--literal-pathspecs", "add", "--", magicPath);
    fixture.run("commit", "-m", "manual main");
    expect(() => fixture?.run("merge", "manual-topic")).toThrow();
    writeFileSync(join(fixture.repo, magicPath), "resolved magic\n");
    writeFileSync(join(fixture.repo, relatedPathspecMatch), "unrelated edit\n");

    await expect(
      stageConflictResolution(conflictSystemGit, fixture.repo, magicPath)
    ).resolves.toEqual({ ok: true, value: undefined });

    expect(fixture.run("diff", "--cached", "--name-only")).toBe(magicPath);
    expect(fixture.run("diff", "--name-only")).toBe(relatedPathspecMatch);
  });
});

describe("unmerged stage representation", () => {
  it("keeps add/add and rename/delete-style missing stages explicit", () => {
    const oid = (digit: string) => digit.repeat(40);
    expect(
      parseUnmergedIndex(
        [
          `100644 ${oid("2")} 2\tadded on both.txt\0`,
          `100644 ${oid("3")} 3\tadded on both.txt\0`,
          `100644 ${oid("1")} 1\trenamed.txt\0`,
          `100644 ${oid("3")} 3\trenamed.txt\0`
        ].join("")
      )
    ).toMatchObject([
      {
        path: "added on both.txt",
        kind: "both_added",
        base: null,
        ours: { stage: 2, oid: oid("2") },
        theirs: { stage: 3, oid: oid("3") }
      },
      {
        path: "renamed.txt",
        kind: "delete_or_rename_by_ours",
        base: { stage: 1, oid: oid("1") },
        ours: null,
        theirs: { stage: 3, oid: oid("3") }
      }
    ]);
  });
});
