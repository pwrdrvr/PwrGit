import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { err, ok, type Result } from "@pwrgit/shared";
import type { GitBinaryOutput, GitExec, GitExecBinary, GitOutput } from "./dugite";
import { readImagePreview } from "./image-preview";

const systemGit: GitExec = (args, cwd) =>
  new Promise<Result<GitOutput>>((resolve) => {
    const proc = spawn("git", args, { cwd });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    proc.on("close", (code) =>
      resolve(ok({ stdout, stderr, exitCode: code ?? 0 }))
    );
    proc.on("error", (e) =>
      resolve(err({ kind: "git", code: "spawn_failed", message: e.message }))
    );
  });

const systemGitBinary: GitExecBinary = (args, cwd) =>
  new Promise<Result<GitBinaryOutput>>((resolve) => {
    const proc = spawn("git", args, { cwd });
    const chunks: Buffer[] = [];
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => chunks.push(d));
    proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    proc.on("close", (code) =>
      resolve(
        ok({ stdout: Buffer.concat(chunks), stderr, exitCode: code ?? 0 })
      )
    );
    proc.on("error", (e) =>
      resolve(err({ kind: "git", code: "spawn_failed", message: e.message }))
    );
  });

const read = (cwd: string, path: string, rev: Parameters<typeof readImagePreview>[4]) =>
  readImagePreview(systemGit, systemGitBinary, cwd, path, rev);

/** A one-pixel GIF: real bytes, and every byte matters — a utf8 round-trip
 *  through the exec layer mangles it, which is exactly what we're guarding. */
const GIF_V1 = Buffer.from(
  "R0lGODlhAQABAIAAAP8AAAAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==",
  "base64"
);
/** Same header, different palette byte — a second revision to diff against. */
const GIF_V2 = Buffer.from(
  "R0lGODlhAQABAIAAAAAA/wAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==",
  "base64"
);

let repo: string;
let head = "";

beforeAll(() => {
  repo = join(mkdtempSync(join(tmpdir(), "pwrgit-image-")), "repo");
  mkdirSync(join(repo, "art"), { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
  writeFileSync(join(repo, "art", "dot.gif"), GIF_V1);
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  execFileSync(
    "git",
    [
      "-c",
      "user.email=t@example.com",
      "-c",
      "user.name=T",
      "commit",
      "-m",
      "add dot"
    ],
    { cwd: repo, stdio: "ignore" }
  );
  head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repo,
    encoding: "utf8"
  }).trim();
  // Working tree now holds v2, index still holds v1.
  writeFileSync(join(repo, "art", "dot.gif"), GIF_V2);
});

describe("readImagePreview", () => {
  it("returns committed bytes intact rather than utf8-mangled", async () => {
    const result = await read(repo, "art/dot.gif", { kind: "commit", hash: head });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      kind: "image",
      mediaType: "image/gif",
      base64: GIF_V1.toString("base64"),
      bytes: GIF_V1.byteLength
    });
  });

  it("reads the working tree for the after side of an unstaged change", async () => {
    const before = await read(repo, "art/dot.gif", { kind: "index" });
    const after = await read(repo, "art/dot.gif", { kind: "worktree" });
    expect(before.ok && before.value.kind === "image" && before.value.base64).toBe(
      GIF_V1.toString("base64")
    );
    expect(after.ok && after.value.kind === "image" && after.value.base64).toBe(
      GIF_V2.toString("base64")
    );
  });

  it("reports the parent side of a root commit's add as missing", async () => {
    const result = await read(repo, "art/dot.gif", {
      kind: "commitParent",
      hash: head
    });
    expect(result).toEqual(ok({ kind: "missing" }));
  });

  it("reports a path absent from the working tree as missing", async () => {
    const result = await read(repo, "art/gone.png", { kind: "worktree" });
    expect(result).toEqual(ok({ kind: "missing" }));
  });

  it("recognises a Git LFS pointer instead of rendering the pointer text", async () => {
    const pointer = join(repo, "art", "big.png");
    writeFileSync(
      pointer,
      "version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 12\n"
    );
    const result = await read(repo, "art/big.png", { kind: "worktree" });
    expect(result).toEqual(ok({ kind: "lfsPointer" }));
    rmSync(pointer);
  });

  it("refuses a path that is not a previewable image", async () => {
    const result = await read(repo, "notes.txt", { kind: "worktree" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("not_an_image");
  });

  it("refuses a path that escapes the worktree", async () => {
    const result = await read(repo, "../outside.png", { kind: "worktree" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("path_outside_worktree");
  });
});
