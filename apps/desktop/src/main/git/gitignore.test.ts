import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addPatterns, appendToGitignore, toGitignorePattern } from "./gitignore";

describe("toGitignorePattern", () => {
  it("anchors to the repo root", () => {
    // Without the leading slash this would also ignore src/notes.md — a
    // pattern with no slash in it matches that name at any depth.
    expect(toGitignorePattern("notes.md")).toBe("/notes.md");
    expect(toGitignorePattern("design/scratch/shot.png")).toBe(
      "/design/scratch/shot.png"
    );
  });

  it("marks a directory", () => {
    expect(toGitignorePattern("dist", { directory: true })).toBe("/dist/");
  });

  // These stay pure string work on purpose: `*` and `?` are legal on POSIX but
  // reserved on Windows, so the round-trip through a real file is covered by
  // the bracket case below instead.
  it("escapes glob syntax that is legal in a filename", () => {
    expect(toGitignorePattern("report [final].pdf")).toBe(
      "/report \\[final\\].pdf"
    );
    expect(toGitignorePattern("build-*.log")).toBe("/build-\\*.log");
    expect(toGitignorePattern("what?.txt")).toBe("/what\\?.txt");
  });

  it("escapes a trailing space, which git would otherwise strip", () => {
    expect(toGitignorePattern("trailing ")).toBe("/trailing\\ ");
    // Interior spaces are literal and need nothing.
    expect(toGitignorePattern("two words.txt")).toBe("/two words.txt");
  });

  it("leaves # and ! harmless by anchoring them off the line start", () => {
    expect(toGitignorePattern("#notes.md")).toBe("/#notes.md");
    expect(toGitignorePattern("!important.txt")).toBe("/!important.txt");
  });
});

describe("addPatterns", () => {
  it("appends to a file that does not end in a newline", () => {
    // Without the inserted separator this would produce "/a/b" — silently
    // changing the pattern that was already there.
    expect(addPatterns("/a", ["/b"])).toEqual({
      text: "/a\n/b\n",
      added: ["/b"]
    });
  });

  it("starts a fresh file", () => {
    expect(addPatterns("", ["/dist/"])).toEqual({
      text: "/dist/\n",
      added: ["/dist/"]
    });
  });

  it("skips patterns already present and reports nothing added", () => {
    expect(addPatterns("/dist/\n/out/\n", ["/dist/"])).toEqual({
      text: "/dist/\n/out/\n",
      added: []
    });
  });

  it("does not add the same pattern twice in one call", () => {
    expect(addPatterns("", ["/dist/", "/dist/"]).added).toEqual(["/dist/"]);
  });

  it("matches an existing line despite surrounding whitespace", () => {
    expect(addPatterns("  /dist/  \n", ["/dist/"]).added).toEqual([]);
  });

  // A .gitignore is committed and shared, so the endings the file already uses
  // win over the ones this platform would pick.
  it("follows a CRLF file's line endings", () => {
    expect(addPatterns("/out/\r\n", ["/dist/", "/tmp/"]).text).toBe(
      "/out/\r\n/dist/\r\n/tmp/\r\n"
    );
  });

  it("separates with CRLF when a CRLF file lacks its final newline", () => {
    expect(addPatterns("/out/\r\n/a", ["/dist/"]).text).toBe(
      "/out/\r\n/a\r\n/dist/\r\n"
    );
  });

  it("dedupes against CRLF lines", () => {
    expect(addPatterns("/dist/\r\n", ["/dist/"]).added).toEqual([]);
  });
});

describe("appendToGitignore (real files + git check-ignore)", () => {
  let root: string;

  const git = (args: string[]): string =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pwrgit-ignore-"));
    git(["init", "-b", "main"]);
    git(["config", "user.name", "PwrGit Test"]);
    git(["config", "user.email", "pwrgit@example.com"]);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** Does git itself consider this path ignored? The only answer that counts. */
  const ignored = (path: string): boolean => {
    try {
      execFileSync("git", ["check-ignore", "-q", "--", path], { cwd: root });
      return true;
    } catch {
      return false;
    }
  };

  it("creates the file and makes git ignore the folder", () => {
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist", "app.js"), "x\n");

    const result = appendToGitignore(root, [
      toGitignorePattern("dist", { directory: true })
    ]);

    expect(result.ok && result.value.added).toEqual(["/dist/"]);
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe("/dist/\n");
    expect(ignored("dist/app.js")).toBe(true);
  });

  it("ignores exactly the awkward filename it was given", () => {
    // Brackets rather than the more obvious `*`: Windows forbids `*` and `?`
    // in filenames outright, so a test that needs the file to exist cannot use
    // them. This case has more teeth anyway — unescaped, `/report [final].pdf`
    // is a character class matching one of f, i, n, a, l, so it ignores
    // "report f.pdf" and leaves the file the user actually pointed at alone.
    writeFileSync(join(root, "report [final].pdf"), "x\n");
    writeFileSync(join(root, "report f.pdf"), "x\n");

    appendToGitignore(root, [toGitignorePattern("report [final].pdf")]);

    expect(ignored("report [final].pdf")).toBe(true);
    expect(ignored("report f.pdf")).toBe(false);
  });

  it("does not ignore a same-named file in a subdirectory", () => {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "notes.md"), "x\n");
    writeFileSync(join(root, "src", "notes.md"), "x\n");

    appendToGitignore(root, [toGitignorePattern("notes.md")]);

    expect(ignored("notes.md")).toBe(true);
    expect(ignored("src/notes.md")).toBe(false);
  });

  it("preserves what was already in the file", () => {
    writeFileSync(join(root, ".gitignore"), "# build output\n/out/");

    const result = appendToGitignore(root, ["/dist/"]);

    expect(result.ok && result.value.added).toEqual(["/dist/"]);
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(
      "# build output\n/out/\n/dist/\n"
    );
  });

  it("reports an unwritable .gitignore instead of throwing", () => {
    // A directory where the file should be: read and write both fail, and the
    // handler must return that as an error across the IPC boundary.
    mkdirSync(join(root, ".gitignore"));

    const result = appendToGitignore(root, ["/dist/"]);

    expect(result.ok).toBe(false);
  });
});
