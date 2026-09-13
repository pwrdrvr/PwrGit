import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { err, ok, RECLAIM_DEFAULT_EXCLUDES } from "@pwrgit/shared";
import type { GitExec, GitOutput } from "./dugite";
import {
  describePlan,
  parseCleanDryRun,
  previewReclaim,
  reclaimIgnored,
  spareArgs
} from "./worktree-reclaim";

// `-C` rather than a native cwd inside the repo: Git for Windows can hand
// execution to a descendant that keeps the directory busy, and these tests
// delete their tree in afterEach. Mirrors `gitProcessInvocation`.
const systemGit: GitExec = (args, cwd, options) =>
  new Promise((resolve) => {
    const proc = spawn("git", ["-C", cwd, ...args], {
      cwd: tmpdir(),
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

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

const bytes = (count: number): string => "x".repeat(count);

describe("parseCleanDryRun", () => {
  it("keeps only the removal lines, and marks directories by their slash", () => {
    const { paths, truncated } = parseCleanDryRun(
      [
        "Would remove node_modules/",
        "Would remove dist/bundle.js",
        "Skipping repository vendor/nested",
        "",
        "Would remove .env"
      ].join("\n")
    );
    expect(paths).toEqual(["node_modules/", "dist/bundle.js", ".env"]);
    expect(truncated).toBe(false);
  });

  it("tolerates CRLF, which the Windows runner produces", () => {
    expect(parseCleanDryRun("Would remove dist/\r\n").paths).toEqual(["dist/"]);
  });

  it("drops anything that is not a repository-relative path", () => {
    // Git never emits these. One appearing means the line was not what we
    // think it is, and showing fewer rows beats showing a wrong one.
    const { paths } = parseCleanDryRun(
      [
        "Would remove /etc/passwd",
        "Would remove C:\\Windows\\System32",
        "Would remove ../../sibling/secrets",
        "Would remove a/../../escape",
        "Would remove ok/keep"
      ].join("\n")
    );
    expect(paths).toEqual(["ok/keep"]);
  });
});

describe("spareArgs", () => {
  it("negates each pattern — a bare -e under -X targets, it does not spare", () => {
    expect(spareArgs([".env*", "*.local"])).toEqual([
      "-e",
      "!.env*",
      "-e",
      "!*.local"
    ]);
  });
});

describe("reclaim against real git", () => {
  let root: string;
  let repo: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pwrgit-reclaim-"));
    repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.name", "PwrGit Test"]);
    git(repo, ["config", "user.email", "pwrgit@example.com"]);
    git(repo, ["config", "core.autocrlf", "false"]);
    writeFileSync(
      join(repo, ".gitignore"),
      ["node_modules/", "dist/", ".env", "local.sqlite", "vendor/", "*.log"].join(
        "\n"
      ) + "\n"
    );
    writeFileSync(join(repo, "tracked.txt"), "tracked\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "baseline"]);

    mkdirSync(join(repo, "node_modules", "left-pad"), { recursive: true });
    writeFileSync(join(repo, "node_modules", "left-pad", "index.js"), bytes(4096));
    mkdirSync(join(repo, "dist"));
    writeFileSync(join(repo, "dist", "bundle.js"), bytes(512));
    writeFileSync(join(repo, ".env"), "SECRET=hunter2\n");
    writeFileSync(join(repo, "local.sqlite"), bytes(64));
    // Untracked but NOT ignored — uncommitted work. `-X` must never see it.
    writeFileSync(join(repo, "scratch.md"), "notes I have not committed\n");
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("previews git's own answer, biggest first, sparing the defaults", async () => {
    const plan = await previewReclaim(systemGit, {
      worktreeId: "w1",
      repoName: "demo",
      branch: "main",
      path: repo
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const paths = plan.value.entries.map((entry) => entry.path);
    expect(paths).toEqual(["node_modules/", "dist/"]);
    // Biggest first is the ordering the pruner exists for.
    expect(plan.value.entries[0]?.sizeBytes).toBeGreaterThan(
      plan.value.entries[1]?.sizeBytes ?? Infinity
    );
    expect(plan.value.entries[0]?.isDirectory).toBe(true);
    // `.env` matches `.env*` and `local.sqlite` matches `*.sqlite`: both are
    // ignored, both would be deleted, and both are spared by default.
    expect(paths).not.toContain(".env");
    expect(paths).not.toContain("local.sqlite");
    expect(plan.value.excludes).toEqual([...RECLAIM_DEFAULT_EXCLUDES]);
    expect(plan.value.pathCount).toBe(2);
    expect(plan.value.truncated).toBe(false);
    expect(describePlan(plan.value)).toMatch(/ in 2 paths$/);
  });

  it("preview deletes nothing", async () => {
    await previewReclaim(systemGit, {
      worktreeId: "w1",
      repoName: "demo",
      branch: "main",
      path: repo
    });
    expect(existsSync(join(repo, "node_modules", "left-pad", "index.js"))).toBe(
      true
    );
    expect(existsSync(join(repo, "dist", "bundle.js"))).toBe(true);
  });

  it("offers the spared files once the user clears the exclude list", async () => {
    const plan = await previewReclaim(systemGit, {
      worktreeId: "w1",
      repoName: "demo",
      branch: "main",
      path: repo
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value.entries.map((entry) => entry.path)).not.toContain(".env");

    const opened = await previewReclaim(systemGit, {
      worktreeId: "w1",
      repoName: "demo",
      branch: "main",
      path: repo,
      excludes: []
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.value.entries.map((entry) => entry.path)).toEqual(
      expect.arrayContaining([".env", "local.sqlite"])
    );
  });

  it("deletes the ignored bulk and keeps everything else", async () => {
    const cleaned = await reclaimIgnored(systemGit, repo, [
      ...RECLAIM_DEFAULT_EXCLUDES
    ]);
    expect(cleaned.ok).toBe(true);

    expect(existsSync(join(repo, "node_modules"))).toBe(false);
    expect(existsSync(join(repo, "dist"))).toBe(false);
    // The three things that make this operation safe to offer at all.
    expect(existsSync(join(repo, ".env"))).toBe(true);
    expect(existsSync(join(repo, "local.sqlite"))).toBe(true);
    expect(existsSync(join(repo, "scratch.md"))).toBe(true);
    expect(existsSync(join(repo, "tracked.txt"))).toBe(true);
    expect(git(repo, ["status", "--porcelain=v1"])).toBe("?? scratch.md");
    expect(git(repo, ["log", "-1", "--format=%s"])).toBe("baseline");
  });

  it("leaves a nested git repository inside an ignored directory alone", async () => {
    // One `-f`, not two: git refuses to delete a directory holding its own
    // `.git`, which is what keeps a vendored clone from vanishing.
    const nested = join(repo, "vendor", "dep");
    mkdirSync(nested, { recursive: true });
    git(nested, ["init", "-b", "main"]);
    writeFileSync(join(nested, "file.txt"), "vendored\n");

    const cleaned = await reclaimIgnored(systemGit, repo, []);
    expect(cleaned.ok).toBe(true);
    expect(existsSync(join(nested, ".git"))).toBe(true);
    expect(existsSync(join(nested, "file.txt"))).toBe(true);
  });

  it("reports nothing to do in a worktree with no ignored files", async () => {
    await reclaimIgnored(systemGit, repo, []);
    const plan = await previewReclaim(systemGit, {
      worktreeId: "w1",
      repoName: "demo",
      branch: "main",
      path: repo,
      excludes: []
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value.pathCount).toBe(0);
    expect(plan.value.totalBytes).toBe(0);
  });

  it("asks git in a fixed locale, and unquoted, so the output can be parsed", async () => {
    const seen: Array<{ args: string[]; env?: Record<string, string | undefined> }> =
      [];
    const recording: GitExec = (args, cwd, options) => {
      seen.push({ args, ...(options?.env === undefined ? {} : { env: options.env }) });
      return systemGit(args, cwd, options);
    };
    await previewReclaim(recording, {
      worktreeId: "w1",
      repoName: "demo",
      branch: "main",
      path: repo
    });
    const call = seen[0];
    expect(call?.args).toEqual(
      expect.arrayContaining(["clean", "-X", "-d", "--dry-run"])
    );
    // Never `-x`: that would also delete untracked files no rule covers.
    expect(call?.args).not.toContain("-x");
    expect(call?.args.slice(0, 2)).toEqual(["-c", "core.quotePath=false"]);
    expect(call?.env?.["LC_ALL"]).toBe("C");
  });

  it("parses a non-ASCII path because quoting is off", async () => {
    // `.gitignore` carries `*.log`, so this file is ignored on its own rather
    // than swallowed by an entirely-ignored directory (which git would collapse
    // to the directory name).
    writeFileSync(join(repo, "日本語.log"), bytes(32));
    const plan = await previewReclaim(systemGit, {
      worktreeId: "w1",
      repoName: "demo",
      branch: "main",
      path: repo
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value.entries.map((entry) => entry.path)).toContain(
      "日本語.log"
    );
  });

  it("spares a pattern the user adds, and stops once they remove it", async () => {
    writeFileSync(join(repo, "build.log"), bytes(128));
    const spared = await previewReclaim(systemGit, {
      worktreeId: "w1",
      repoName: "demo",
      branch: "main",
      path: repo,
      excludes: ["*.log"]
    });
    expect(spared.ok).toBe(true);
    if (!spared.ok) return;
    expect(spared.value.entries.map((entry) => entry.path)).not.toContain(
      "build.log"
    );

    const offered = await previewReclaim(systemGit, {
      worktreeId: "w1",
      repoName: "demo",
      branch: "main",
      path: repo,
      excludes: []
    });
    expect(offered.ok).toBe(true);
    if (!offered.ok) return;
    expect(offered.value.entries.map((entry) => entry.path)).toContain(
      "build.log"
    );
  });
});
