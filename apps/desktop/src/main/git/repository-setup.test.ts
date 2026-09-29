import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSystemGit } from "./test-support/system-git";
import { readRepositorySetup, recordHookReceipts, saveSetupExclude, testSetupIgnorePath } from "./repository-setup";

const systemGit = createSystemGit();

describe("repository setup in linked worktrees", () => {
  let base: string;
  let root: string;
  let linked: string;
  const git = (args: string[]): string => execFileSync("git", ["-C", root, ...args], { cwd: tmpdir(), encoding: "utf8" }).trim();

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "pwrgit-setup-"));
    root = join(base, "root");
    linked = join(base, "linked");
    mkdirSync(root);
    git(["init", "-b", "main"]);
    git(["config", "user.name", "PwrGit Test"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "core.autocrlf", "false"]);
    git(["config", "core.excludesFile", join(base, "global-ignore")]);
    writeFileSync(join(root, "README.md"), "hello\n");
    git(["add", "README.md"]);
    git(["commit", "-m", "initial"]);
    git(["worktree", "add", "-b", "feature", linked]);
  });

  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it("resolves active and shadowed hooks from the shared common directory", async () => {
    mkdirSync(join(root, ".husky", "_"), { recursive: true });
    const active = join(root, ".husky", "_", "pre-commit");
    writeFileSync(active, "#!/bin/sh\npnpm lint\n");
    chmodSync(active, 0o755);
    writeFileSync(join(root, ".husky", "_", "h"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(root, ".husky", "_", "h"), 0o755);
    git(["config", "core.hooksPath", join(root, ".husky", "_")]);
    const defaultHooks = join(root, ".git", "hooks");
    writeFileSync(join(defaultHooks, "pre-push"), "#!/bin/sh\ncommand -v git-lfs >/dev/null 2>&1 || exit 2\ngit lfs pre-push \"$@\"\n");
    chmodSync(join(defaultHooks, "pre-push"), 0o755);
    writeFileSync(join(defaultHooks, "post-merge.sample"), "sample\n");
    await recordHookReceipts(systemGit, root, [{ name: "pre-commit", path: active, exitCode: 0, elapsedMs: 251 }]);

    const result = await readRepositorySetup(systemGit, linked);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.hooks.worktreeCount).toBe(2);
    expect(result.value.hooks.origin).toContain("config");
    expect(result.value.hooks.active[0]).toMatchObject({ name: "pre-commit", calls: "pnpm lint", lastRun: { elapsedMs: 251 } });
    expect(result.value.hooks.active).toHaveLength(1);
    expect(result.value.hooks.shadowed[0]).toMatchObject({ name: "pre-push", displayPath: ".git/hooks/pre-push" });
    expect(result.value.hooks.lfsShadowed).toBe(true);
    expect(result.value.hooks.sampleCount).toBeGreaterThan(0);
  });

  it("shows the three layers and uses Git to test precedence and tracked paths", async () => {
    writeFileSync(join(root, ".gitignore"), "*.log\n");
    writeFileSync(join(root, ".git", "info", "exclude"), "notes.md\n");
    writeFileSync(join(base, "global-ignore"), ".DS_Store\n");
    const setup = await readRepositorySetup(systemGit, root);
    if (!setup.ok) throw new Error(setup.error.message);
    expect(setup.value.ignore.map((layer) => layer.destination)).toEqual(["gitignore", "exclude", "global"]);
    expect(setup.value.ignore[1]?.lines).toEqual([{ number: 1, text: "notes.md" }]);
    const hit = await testSetupIgnorePath(systemGit, linked, "notes.md");
    expect(hit).toMatchObject({ ok: true, value: { ignored: true, line: 1, pattern: "notes.md" } });
    const miss = await testSetupIgnorePath(systemGit, linked, "README.md");
    expect(miss).toMatchObject({ ok: true, value: { ignored: false } });
    const invalid = await testSetupIgnorePath(systemGit, linked, "../outside");
    expect(invalid.ok).toBe(false);
  });

  it("edits the common exclude file only when the previewed content still matches", () => {
    const path = join(root, ".git", "info", "exclude");
    const before = readFileSync(path, "utf8");
    expect(saveSetupExclude(path, before, "notes.md\n")).toEqual({ ok: true, value: { content: "notes.md\n" } });
    expect(readFileSync(path, "utf8")).toBe("notes.md\n");
    expect(saveSetupExclude(path, before, "other.md\n")).toMatchObject({ ok: false, error: { code: "changed_on_disk" } });
  });
});
