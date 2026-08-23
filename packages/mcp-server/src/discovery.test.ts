import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findRepositoryCheckouts,
  findRepositoryDirectories
} from "./discovery.js";

const cleanup: string[] = [];

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function repository(path: string, remote: string): void {
  mkdirSync(path, { recursive: true });
  git(path, ["init", "-b", "main"]);
  git(path, ["config", "user.name", "PwrGit Test"]);
  git(path, ["config", "user.email", "pwrgit@example.test"]);
  git(path, ["remote", "add", "origin", remote]);
}

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("bounded repository discovery", () => {
  it("finds worktrees, skips symlink traversal, and reports its budget", async () => {
    const root = mkdtempSync(join(tmpdir(), "pwrgit-mcp-discovery-"));
    cleanup.push(root);
    repository(join(root, "group", "widget"), "git@github.com:acme/widget.git");
    const outside = mkdtempSync(join(tmpdir(), "pwrgit-mcp-outside-"));
    cleanup.push(outside);
    repository(join(outside, "secret"), "git@github.com:acme/secret.git");
    if (process.platform !== "win32") {
      symlinkSync(outside, join(root, "linked-outside"), "dir");
    }

    const scan = await findRepositoryDirectories(root, {
      maxDepth: 4,
      directoryBudget: 100
    });
    expect(scan.repositories).toEqual([join(root, "group", "widget")]);
    expect(scan.scannedDirectories).toBeLessThanOrEqual(100);
    expect(scan.truncated).toBe(false);
  });

  it("locates a checkout by credential-free canonical remote identity", async () => {
    const root = mkdtempSync(join(tmpdir(), "pwrgit-mcp-find-"));
    cleanup.push(root);
    const checkout = join(root, "nested", "widget");
    repository(
      checkout,
      "https://oauth2:do-not-return@github.com/acme/widget.git"
    );

    const result = await findRepositoryCheckouts({
      repository: "github.com/acme/widget",
      roots: [root],
      maxDepth: 3
    });
    const canonicalCheckout = await realpath(checkout);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({
      repositoryPath: canonicalCheckout,
      matchedPath: canonicalCheckout,
      remoteName: "origin",
      identity: { provider: "github", host: "github.com", path: "acme/widget" }
    });
    expect(JSON.stringify(result)).not.toContain("do-not-return");
  });
});
