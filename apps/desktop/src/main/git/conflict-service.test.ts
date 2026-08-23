import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  abortConflictOperation,
  acceptConflictSide,
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

let fixture: ConflictTestFixture | null = null;

afterEach(() => {
  fixture?.cleanup();
  fixture = null;
});

describe("conflict operation detection (real Git)", () => {
  it.each([
    "merge",
    "rebase",
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
