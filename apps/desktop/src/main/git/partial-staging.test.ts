import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { err, ok } from "@pwrgit/shared";
import type {
  GitBinaryOutput,
  GitExec,
  GitExecBinary,
  GitOutput
} from "./dugite";
import {
  applyPartialSelection,
  buildSelectedPatch,
  parseZeroContextDiff,
  partialDiffCapability,
  partialFileDiff
} from "./partial-staging";

const systemGit: GitExec = (args, cwd, options) =>
  new Promise((resolve) => {
    const proc = spawn("git", args, {
      cwd,
      env: { ...process.env, ...options?.env }
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    proc.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    proc.on("error", (cause) =>
      resolve(err({ kind: "git", code: "spawn_failed", message: cause.message }))
    );
    proc.on("close", (exitCode) =>
      resolve(ok({ stdout, stderr, exitCode: exitCode ?? 1 } satisfies GitOutput))
    );
  });

const systemGitBinary: GitExecBinary = (args, cwd) =>
  new Promise((resolve) => {
    const proc = spawn("git", args, { cwd });
    const stdout: Buffer[] = [];
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    proc.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    proc.on("error", (cause) =>
      resolve(err({ kind: "git", code: "spawn_failed", message: cause.message }))
    );
    proc.on("close", (exitCode) =>
      resolve(
        ok({
          stdout: Buffer.concat(stdout),
          stderr,
          exitCode: exitCode ?? 1
        } satisfies GitBinaryOutput)
      )
    );
  });

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" }
  }).trimEnd();
}

const allLineIds = (
  diff: Awaited<ReturnType<typeof partialFileDiff>>
): string[] =>
  diff.ok
    ? diff.value.hunks.flatMap((hunk) => hunk.lines.map((line) => line.id))
    : [];

describe("zero-context patch parsing and synthesis", () => {
  it("keeps prefix-looking content and no-newline markers inside the hunk", () => {
    const parsed = parseZeroContextDiff(
      [
        "diff --git a/odd.txt b/odd.txt",
        "--- a/odd.txt",
        "+++ b/odd.txt",
        "@@ -1,2 +1,2 @@",
        "--- looks like a header",
        "-tail",
        "\\ No newline at end of file",
        "+++ also looks like a header",
        "+new tail",
        "\\ No newline at end of file",
        ""
      ].join("\n")
    );

    expect(parsed.unsupported).toBe(false);
    expect(parsed.hunks[0]?.lines).toMatchObject([
      { kind: "delete", text: "-- looks like a header", oldLine: 1 },
      { kind: "delete", text: "tail", oldLine: 2, noNewline: true },
      { kind: "add", text: "++ also looks like a header", newLine: 1 },
      { kind: "add", text: "new tail", newLine: 2, noNewline: true }
    ]);
  });

  it("recounts every generated patch over many line-selection combinations", () => {
    const parsed = parseZeroContextDiff(
      [
        "--- a/file.txt",
        "+++ b/file.txt",
        "@@ -2,3 +2,4 @@",
        "-old one",
        "-old two",
        "-old three",
        "+new one",
        "+new two",
        "+new three",
        "+new four",
        ""
      ].join("\n")
    );
    const ids = parsed.hunks[0]?.lines.flatMap((line) =>
      line.id === null ? [] : [line.id]
    ) ?? [];

    // Property-style coverage without a test-only dependency: every non-empty
    // bitmask across this seven-line replacement is synthesized both ways,
    // reparsed, and checked against its own unified-diff counts.
    for (let mask = 1; mask < 1 << ids.length; mask += 1) {
      const selected = new Set(ids.filter((_, index) => (mask & (1 << index)) !== 0));
      for (const staged of [false, true]) {
        const built = buildSelectedPatch(parsed, staged, selected);
        expect(built.ok, `mask ${mask}, staged ${staged}`).toBe(true);
        if (!built.ok) continue;
        const reparsed = parseZeroContextDiff(built.value.patch);
        expect(reparsed.unsupported, `mask ${mask}, staged ${staged}`).toBe(false);
        expect(reparsed.hunks.length).toBe(1);
      }
    }
  });

  it("recognizes gitlink pseudo-lines as a protected entry", () => {
    const parsed = parseZeroContextDiff(
      [
        "diff --git a/vendor/lib b/vendor/lib",
        "index 1111111..2222222 160000",
        "--- a/vendor/lib",
        "+++ b/vendor/lib",
        "@@ -1 +1 @@",
        "-Subproject commit 1111111",
        "+Subproject commit 2222222",
        ""
      ].join("\n")
    );

    expect(parsed.gitlink).toBe(true);
    expect(partialDiffCapability(parsed, ["M"], true)).toMatchObject({
      available: false,
      reason: "gitlink"
    });
  });
});

describe("partial staging with a real Git index", () => {
  let root: string;
  let repo: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pwrgit-partial-stage-test-"));
    repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, "init", "-b", "main");
    git(repo, "config", "user.name", "PwrGit Test");
    git(repo, "config", "user.email", "pwrgit@example.com");
    git(repo, "config", "core.autocrlf", "false");
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const commitFile = (contents: string): void => {
    writeFileSync(join(repo, "file.txt"), contents);
    git(repo, "add", "file.txt");
    git(repo, "commit", "-m", "baseline");
  };

  it("stages one hunk, then unstages one selected replacement line", async () => {
    commitFile("one\ntwo\nthree\nfour\nfive\nsix\nseven\n");
    writeFileSync(
      join(repo, "file.txt"),
      "one\nTWO\nthree\nfour\nfive\nSIX\nseven\n"
    );

    const unstaged = await partialFileDiff(systemGit, systemGitBinary, repo, "file.txt", false);
    expect(unstaged.ok && unstaged.value.capability.available).toBe(true);
    if (!unstaged.ok) return;
    const firstHunk = unstaged.value.hunks[0];
    expect(firstHunk).toBeDefined();
    const stagedFirst = await applyPartialSelection(
      systemGit,
      systemGitBinary,
      repo,
      "file.txt",
      false,
      unstaged.value.fingerprint,
      firstHunk?.lines.map((line) => line.id) ?? []
    );
    expect(stagedFirst).toEqual(ok(undefined));
    expect(git(repo, "diff", "--cached")).toContain("TWO");
    expect(git(repo, "diff", "--cached")).not.toContain("SIX");
    expect(git(repo, "diff")).toContain("SIX");

    const staged = await partialFileDiff(systemGit, systemGitBinary, repo, "file.txt", true);
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    const deletion = staged.value.hunks
      .flatMap((hunk) => hunk.lines)
      .find((line) => line.kind === "delete");
    expect(deletion?.text).toBe("two");
    const unstagedDeletion = await applyPartialSelection(
      systemGit,
      systemGitBinary,
      repo,
      "file.txt",
      true,
      staged.value.fingerprint,
      deletion === undefined ? [] : [deletion.id]
    );
    expect(unstagedDeletion).toEqual(ok(undefined));
    expect(git(repo, "show", ":file.txt")).toBe(
      "one\ntwo\nTWO\nthree\nfour\nfive\nsix\nseven"
    );
  });

  it("stages arbitrary added lines while leaving the rest in the worktree", async () => {
    for (let seed = 0; seed < 8; seed += 1) {
      if (seed === 0) {
        commitFile(Array.from({ length: 12 }, (_, i) => `base-${i}`).join("\n") + "\n");
      } else {
        git(repo, "reset", "--hard", "HEAD");
      }
      const working: string[] = [];
      const expected: string[] = [];
      for (let i = 0; i < 12; i += 1) {
        working.push(`base-${i}`);
        expected.push(`base-${i}`);
        const inserted = `insert-${seed}-${i}`;
        working.push(inserted);
        if ((i + seed) % 3 === 0) expected.push(inserted);
      }
      writeFileSync(join(repo, "file.txt"), `${working.join("\n")}\n`);
      const diff = await partialFileDiff(systemGit, systemGitBinary, repo, "file.txt", false);
      expect(diff.ok).toBe(true);
      if (!diff.ok) continue;
      const chosen = diff.value.hunks
        .flatMap((hunk) => hunk.lines)
        .filter(
          (line) =>
            line.kind === "add" &&
            Number(line.text.split("-").at(-1)) % 3 === (3 - (seed % 3)) % 3
        )
        .map((line) => line.id);
      expect(
        await applyPartialSelection(
          systemGit,
          systemGitBinary,
          repo,
          "file.txt",
          false,
          diff.value.fingerprint,
          chosen
        )
      ).toEqual(ok(undefined));
      expect(git(repo, "show", ":file.txt")).toBe(expected.join("\n"));
    }
  });

  it("rejects a stale view before changing the index", async () => {
    commitFile("before\n");
    writeFileSync(join(repo, "file.txt"), "first edit\n");
    const diff = await partialFileDiff(systemGit, systemGitBinary, repo, "file.txt", false);
    expect(diff.ok).toBe(true);
    if (!diff.ok) return;
    writeFileSync(join(repo, "file.txt"), "external edit\n");

    const result = await applyPartialSelection(
      systemGit,
      systemGitBinary,
      repo,
      "file.txt",
      false,
      diff.value.fingerprint,
      allLineIds(diff)
    );
    expect(result).toMatchObject({
      ok: false,
      error: { kind: "validation", code: "stale_diff" }
    });
    expect(git(repo, "diff", "--cached")).toBe("");
  });

  it("refuses lossy partial staging for non-UTF-8 text bytes", async () => {
    writeFileSync(
      join(repo, "file.txt"),
      Buffer.from([0x6f, 0x6c, 0x64, 0xff, 0x0a])
    );
    git(repo, "add", "file.txt");
    git(repo, "commit", "-m", "legacy encoding");
    const indexedBefore = execFileSync("git", ["show", ":file.txt"], {
      cwd: repo
    });
    writeFileSync(
      join(repo, "file.txt"),
      Buffer.from([0x6e, 0x65, 0x77, 0xfe, 0x0a])
    );

    const diff = await partialFileDiff(
      systemGit,
      systemGitBinary,
      repo,
      "file.txt",
      false
    );
    expect(diff.ok && diff.value.capability).toMatchObject({
      available: false,
      reason: "non_utf8"
    });
    if (!diff.ok) return;
    const result = await applyPartialSelection(
      systemGit,
      systemGitBinary,
      repo,
      "file.txt",
      false,
      diff.value.fingerprint,
      allLineIds(diff)
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "partial_unavailable" }
    });
    expect(
      execFileSync("git", ["show", ":file.txt"], { cwd: repo })
    ).toEqual(indexedBefore);
  });

  it("uses the raw no-textconv representation for display and selection", async () => {
    git(repo, "config", "diff.reorder.textconv", "false");
    writeFileSync(join(repo, ".gitattributes"), "file.txt diff=reorder\n");
    writeFileSync(join(repo, "file.txt"), "one\ntwo\n");
    git(repo, "add", ".gitattributes", "file.txt");
    git(repo, "commit", "-m", "textconv fixture");
    writeFileSync(join(repo, "file.txt"), "ONE\ntwo\n");

    const diff = await partialFileDiff(
      systemGit,
      systemGitBinary,
      repo,
      "file.txt",
      false
    );
    expect(diff.ok && diff.value.capability.available).toBe(true);
    if (!diff.ok) return;
    expect(diff.value.patch).toContain("-one\n+ONE");
    expect(diff.value.hunks.flatMap((hunk) => hunk.lines)).toMatchObject([
      { kind: "delete", text: "one" },
      { kind: "add", text: "ONE" }
    ]);
  });

  it("replays nested paths when diff.noprefix is configured", async () => {
    mkdirSync(join(repo, "nested"));
    writeFileSync(join(repo, "nested", "file.txt"), "old\n");
    git(repo, "add", "nested/file.txt");
    git(repo, "commit", "-m", "nested fixture");
    git(repo, "config", "diff.noprefix", "true");
    writeFileSync(join(repo, "nested", "file.txt"), "new\n");

    const diff = await partialFileDiff(
      systemGit,
      systemGitBinary,
      repo,
      "nested/file.txt",
      false
    );
    expect(diff.ok).toBe(true);
    if (!diff.ok) return;
    expect(diff.value.patch).toContain("--- a/nested/file.txt");
    expect(
      await applyPartialSelection(
        systemGit,
        systemGitBinary,
        repo,
        "nested/file.txt",
        false,
        diff.value.fingerprint,
        allLineIds(diff)
      )
    ).toEqual(ok(undefined));
    expect(git(repo, "show", ":nested/file.txt")).toBe("new");
  });

  it("does not let temp cleanup failure mask a completed index update", async () => {
    commitFile("old\n");
    writeFileSync(join(repo, "file.txt"), "new\n");
    const diff = await partialFileDiff(
      systemGit,
      systemGitBinary,
      repo,
      "file.txt",
      false
    );
    expect(diff.ok).toBe(true);
    if (!diff.ok) return;

    const result = await applyPartialSelection(
      systemGit,
      systemGitBinary,
      repo,
      "file.txt",
      false,
      diff.value.fingerprint,
      allLineIds(diff),
      {
        removeTemp: (path) => {
          rmSync(path, { recursive: true, force: true });
          throw new Error("scanner still holds the patch");
        }
      }
    );
    expect(result).toEqual(ok(undefined));
    expect(git(repo, "show", ":file.txt")).toBe("new");
  });

  it("normalizes CRLF through Git while leaving worktree bytes untouched", async () => {
    writeFileSync(join(repo, ".gitattributes"), "file.txt text eol=crlf\n");
    writeFileSync(join(repo, "file.txt"), "one\ntwo\n");
    git(repo, "add", ".gitattributes", "file.txt");
    git(repo, "commit", "-m", "crlf baseline");
    git(repo, "checkout", "--", "file.txt");
    writeFileSync(join(repo, "file.txt"), "one\r\nTWO\r\n");

    const diff = await partialFileDiff(systemGit, systemGitBinary, repo, "file.txt", false);
    expect(diff.ok).toBe(true);
    if (!diff.ok) return;
    expect(
      await applyPartialSelection(
        systemGit,
        systemGitBinary,
        repo,
        "file.txt",
        false,
        diff.value.fingerprint,
        allLineIds(diff)
      )
    ).toEqual(ok(undefined));
    expect(git(repo, "show", ":file.txt")).toBe("one\nTWO");
    expect(readFileSync(join(repo, "file.txt"), "utf8")).toBe("one\r\nTWO\r\n");
  });

  it("requires an EOF no-newline replacement to move atomically", async () => {
    commitFile("old tail");
    writeFileSync(join(repo, "file.txt"), "new tail");
    const diff = await partialFileDiff(systemGit, systemGitBinary, repo, "file.txt", false);
    expect(diff.ok).toBe(true);
    if (!diff.ok) return;
    const ids = allLineIds(diff);
    expect(ids).toHaveLength(2);
    await expect(
      applyPartialSelection(
        systemGit,
        systemGitBinary,
        repo,
        "file.txt",
        false,
        diff.value.fingerprint,
        [ids[0] ?? ""]
      )
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "atomic_no_newline_hunk" }
    });
    expect(
      await applyPartialSelection(
        systemGit,
        systemGitBinary,
        repo,
        "file.txt",
        false,
        diff.value.fingerprint,
        ids
      )
    ).toEqual(ok(undefined));
    expect(git(repo, "show", ":file.txt")).toBe("new tail");
  });

  it.runIf(process.platform !== "win32")(
    "stages content without accidentally staging a concurrent mode change",
    async () => {
      commitFile("old content\n");
      chmodSync(join(repo, "file.txt"), 0o755);
      writeFileSync(join(repo, "file.txt"), "new content\n");
      const diff = await partialFileDiff(systemGit, systemGitBinary, repo, "file.txt", false);
      expect(diff.ok && diff.value.capability.available).toBe(true);
      if (!diff.ok) return;

      expect(
        await applyPartialSelection(
          systemGit,
          systemGitBinary,
          repo,
          "file.txt",
          false,
          diff.value.fingerprint,
          allLineIds(diff)
        )
      ).toEqual(ok(undefined));
      expect(git(repo, "show", ":file.txt")).toBe("new content");
      expect(git(repo, "diff", "--cached", "--summary")).toBe("");
      expect(git(repo, "diff", "--summary")).toContain(
        "mode change 100644 => 100755 file.txt"
      );
    }
  );

  it("refuses partial operations while the path is conflicted", async () => {
    commitFile("base\n");
    git(repo, "branch", "other");
    git(repo, "checkout", "other");
    writeFileSync(join(repo, "file.txt"), "theirs\n");
    git(repo, "add", "file.txt");
    git(repo, "commit", "-m", "theirs");
    git(repo, "checkout", "main");
    writeFileSync(join(repo, "file.txt"), "ours\n");
    git(repo, "add", "file.txt");
    git(repo, "commit", "-m", "ours");
    try {
      git(repo, "merge", "other");
    } catch {
      // The conflict is the fixture.
    }

    const conflicted = await partialFileDiff(systemGit, systemGitBinary, repo, "file.txt", false);
    expect(conflicted.ok && conflicted.value.capability).toMatchObject({
      available: false,
      reason: "conflicted"
    });
  });

  it("protects binary, rename, mode-only, new, and deleted files", async () => {
    commitFile("tracked\n");
    writeFileSync(join(repo, "binary.bin"), Buffer.from([0, 1, 2, 3]));
    git(repo, "add", "binary.bin");
    git(repo, "commit", "-m", "binary");
    writeFileSync(join(repo, "binary.bin"), Buffer.from([0, 9, 2, 3]));
    const binary = await partialFileDiff(systemGit, systemGitBinary, repo, "binary.bin", false);
    expect(binary.ok && binary.value.capability).toMatchObject({
      available: false,
      reason: "binary"
    });

    git(repo, "mv", "file.txt", "renamed.txt");
    const renamed = await partialFileDiff(systemGit, systemGitBinary, repo, "renamed.txt", true);
    expect(renamed.ok && renamed.value.capability).toMatchObject({
      available: false,
      reason: "renamed_file"
    });

    writeFileSync(join(repo, "new.txt"), "new\n");
    const added = await partialFileDiff(systemGit, systemGitBinary, repo, "new.txt", false);
    expect(added.ok && added.value.capability).toMatchObject({
      available: false,
      reason: "new_file"
    });

    git(repo, "rm", "-f", "binary.bin");
    const deleted = await partialFileDiff(systemGit, systemGitBinary, repo, "binary.bin", true);
    expect(deleted.ok && deleted.value.capability).toMatchObject({
      available: false,
      reason: "deleted_file"
    });

    if (process.platform !== "win32") {
      git(repo, "reset", "--hard", "HEAD");
      chmodSync(join(repo, "file.txt"), 0o755);
      const mode = await partialFileDiff(systemGit, systemGitBinary, repo, "file.txt", false);
      expect(mode.ok && mode.value.capability).toMatchObject({
        available: false,
        reason: "mode_only"
      });
    }
  });
});
