import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localMachineNoun } from "@pwrgit/shared";
import { appendToIgnoreFile } from "./gitignore";
import { ignoreDestinations, patternForChoice, readIgnoredSummary, readIgnoreOptions, suggestIgnoreDestination } from "./ignore-discovery";
import { createSystemGit } from "./test-support/system-git";

const systemGit = createSystemGit();

describe("ignore discovery with linked worktrees", () => {
  let base: string;
  let root: string;
  let linked: string;
  let global: string;
  const git = (args: string[]): string => execFileSync("git", ["-C", root, ...args], { cwd: tmpdir(), encoding: "utf8" }).trim();

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "pwrgit-ignore-discovery-"));
    root = join(base, "root");
    linked = join(base, "linked");
    global = join(base, "config", "git", "ignore");
    mkdirSync(root);
    git(["init", "-b", "main"]);
    git(["config", "user.name", "PwrGit Test"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "core.autocrlf", "false"]);
    git(["config", "core.excludesFile", global]);
    writeFileSync(join(root, "README.md"), "test\n");
    git(["add", "README.md"]);
    git(["commit", "-m", "initial"]);
    git(["worktree", "add", "-b", "feature", linked]);
  });

  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it("uses the common exclude file and counts untracked pattern matches", async () => {
    mkdirSync(join(linked, ".local", "shots"), { recursive: true });
    writeFileSync(join(linked, ".local", "shots", "after.png"), "a");
    writeFileSync(join(linked, ".local", "shots", "before.png"), "b");
    writeFileSync(join(linked, "other.png"), "c");
    const result = await readIgnoreOptions(systemGit, linked, ".local/shots/after.png", false);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.worktreeCount).toBe(2);
    expect(result.value.suggested).toBe("exclude");
    expect(result.value.patterns).toEqual([
      { choice: "file", pattern: "/.local/shots/after.png", count: 1 },
      { choice: "folder", pattern: "/.local/", count: 2 },
      { choice: "extension", pattern: "*.png", count: 3 }
    ]);
    const exclude = result.value.destinations.find((item) => item.destination === "exclude")?.path;
    if (exclude === undefined) throw new Error("missing common exclude path");
    expect(realpathSync.native(exclude)).toBe(realpathSync.native(join(root, ".git", "info", "exclude")));
    expect(result.value.destinations.find((item) => item.destination === "global")?.path).toBe(global);
  });

  it("attributes only personal rules after Git actually hides files", async () => {
    const locations = await ignoreDestinations(systemGit, linked);
    if (!locations.ok) throw new Error(locations.error.message);
    const exclude = locations.value.destinations.find((item) => item.destination === "exclude")?.path;
    if (exclude === undefined) throw new Error("missing exclude");
    expect(locations.value.destinations.find((item) => item.destination === "global")?.scope).toBe(`this ${localMachineNoun(process.platform)}`);
    const onWindows = await ignoreDestinations(systemGit, linked, "win32");
    if (!onWindows.ok) throw new Error(onWindows.error.message);
    expect(onWindows.value.destinations.find((item) => item.destination === "global")?.scope).toBe("this PC");
    appendToIgnoreFile(exclude, ["/.local/"]);
    appendToIgnoreFile(global, [".DS_Store"]);
    writeFileSync(join(linked, ".gitignore"), "*.log\n");
    mkdirSync(join(linked, ".local"));
    writeFileSync(join(linked, ".local", "notes.md"), "x");
    writeFileSync(join(linked, ".DS_Store"), "x");
    writeFileSync(join(linked, "build.log"), "x");

    const summary = await readIgnoredSummary(systemGit, linked);
    expect(summary.ok).toBe(true);
    if (!summary.ok) throw new Error(summary.error.message);
    expect(summary.value.count).toBe(2);
    expect(summary.value.rules.map((rule) => rule.destination).sort()).toEqual(["exclude", "global"]);
    expect(summary.value.rules.map((rule) => rule.pattern).sort()).toEqual([".DS_Store", "/.local/"]);
  });
});

describe("ignore pattern suggestions", () => {
  it("follows the board's personal, machine and team cases", () => {
    expect(suggestIgnoreDestination(".DS_Store")).toBe("global");
    expect(suggestIgnoreDestination(".idea/workspace.xml")).toBe("global");
    expect(suggestIgnoreDestination(".idea/workspace.xml", true)).toBe("gitignore");
    expect(suggestIgnoreDestination(".claude/worktrees/session/file")).toBe("exclude");
    expect(suggestIgnoreDestination(".local/shot.png")).toBe("exclude");
    expect(suggestIgnoreDestination("dist/main.js")).toBe("gitignore");
    expect(suggestIgnoreDestination("src/app.ts")).toBe("gitignore");
  });

  it("does not offer a whole-root folder or an extension without one", () => {
    expect(patternForChoice("notes", false, "folder")).toBeNull();
    expect(patternForChoice("notes", false, "extension")).toBeNull();
    expect(patternForChoice("../outside", false, "file")).toBeNull();
  });
});
