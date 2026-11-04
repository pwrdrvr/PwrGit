import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ok, type MaintenanceRepo } from "@pwrgit/shared";
import type { GitExec } from "./dugite";
import { createSystemGit } from "./test-support/system-git";
import {
  parseReflinkPorcelain,
  refreshRepositoryClones,
  reshareResultFromPorcelain,
  softPullMainCheckout,
  type ReshareWorktreeRow
} from "./worktree-reshare";

const record = (...fields: string[]): string => `${fields.join("\0")}\0\0`;

const SAMPLE =
  record("reflink 1", "worktree /w", "dry-run 0", "backend clone-replace") +
  record("path a.txt", "status skipped", "reason target-dirty", "error-code 0") +
  record("path b.bin", "status reshared", "reason fully-shared", "error-code 0") +
  record("path c.bin", "status skipped", "reason no-donor", "error-code 0") +
  record("path d.bin", "status skipped", "reason target-dirty", "error-code 0") +
  record(
    "summary",
    "scanned 4",
    "eligible 1",
    "already-shared 0",
    "reshared 1",
    "skipped 3",
    "failed 0",
    "observed-private-reduction 303104"
  );

const worktree = { id: "wt", path: "/w", branch: "feature" };

describe("git worktree reflink porcelain", () => {
  it("splits header, paths and summary", () => {
    const parsed = parseReflinkPorcelain(SAMPLE);
    expect(parsed.header.get("backend")).toBe("clone-replace");
    expect(parsed.paths.map((path) => path.get("path"))).toEqual(["a.txt", "b.bin", "c.bin", "d.bin"]);
    expect(parsed.summary?.get("observed-private-reduction")).toBe("303104");
  });

  it("keeps a path with spaces whole", () => {
    const parsed = parseReflinkPorcelain(record("path dir/with space.txt", "status skipped"));
    expect(parsed.paths[0]?.get("path")).toBe("dir/with space.txt");
  });

  it("counts what was shared and says why the rest was left", () => {
    const result = reshareResultFromPorcelain(worktree, parseReflinkPorcelain(SAMPLE), 0, "");
    expect(result).toMatchObject({ outcome: "reshared", reshared: 1, skipped: 3, sharedBytes: 303104 });
    expect(result.message).toBe("1 file re-shared · 3 left as they are (2 changed, 1 differ from the main checkout).");
  });

  it("reports an unmeasured reduction as unknown, not zero", () => {
    const parsed = parseReflinkPorcelain(
      record("reflink 1", "backend native-dedupe") +
        record("summary", "reshared 2", "observed-private-reduction unknown")
    );
    expect(reshareResultFromPorcelain(worktree, parsed, 0, "").sharedBytes).toBeNull();
  });

  it("calls an unsupported volume a skip", () => {
    const parsed = parseReflinkPorcelain(record("reflink 1", "backend unsupported") + record("summary", "skipped 3"));
    expect(reshareResultFromPorcelain(worktree, parsed, 0, "").outcome).toBe("skipped");
  });

  it("fails without a summary, with Git's words", () => {
    const result = reshareResultFromPorcelain(worktree, parseReflinkPorcelain(""), 128, "fatal: not a git repository");
    expect(result).toMatchObject({ outcome: "failed", message: "fatal: not a git repository" });
  });

  it("leaves symlinks and submodules out of the count, not only the reasons", () => {
    const parsed = parseReflinkPorcelain(
      record("reflink 1", "backend clone-replace") +
        record("path link", "status skipped", "reason index-entry") +
        record("path sub", "status skipped", "reason index-entry") +
        record("path a.txt", "status skipped", "reason target-dirty") +
        record("path b.bin", "status reshared") +
        record("summary", "reshared 1", "skipped 3", "failed 0", "observed-private-reduction 4096")
    );
    const result = reshareResultFromPorcelain(worktree, parsed, 0, "");
    expect(result).toMatchObject({ skipped: 1 });
    expect(result.message).toBe("1 file re-shared · 1 left as they are (1 changed).");
  });
});

describe("refreshRepositoryClones without Git", () => {
  const repo: MaintenanceRepo = { id: "r", name: "fixture", path: "/m", profileId: "p", profileName: "P" };
  const row = (id: string, extra: Partial<ReshareWorktreeRow> = {}): ReshareWorktreeRow => ({
    id, path: `/${id}`, branch: id, isPrimary: false, missing: false, locked: false, ...extra
  });
  const porcelain = record("reflink 1", "backend clone-replace") + record("summary", "reshared 1", "skipped 0", "failed 0");
  const fake = (calls: string[]): GitExec => async (args, cwd) => {
    calls.push(`${args[0]} ${cwd}`);
    return ok({ stdout: args[0] === "worktree" ? porcelain : "", stderr: "", exitCode: 0 });
  };

  it("numbers worktrees as they start and refreshes the donor index inside its lock", async () => {
    const calls: string[] = [];
    const reports: string[] = [];
    const locks: string[] = [];
    await refreshRepositoryClones({
      git: fake(calls),
      repo,
      worktrees: [row("main", { isPrimary: true, path: "/m" }), row("a"), row("b"), row("c")],
      updateMain: false,
      signal: new AbortController().signal,
      report: (detail) => reports.push(detail),
      defaultBranch: async () => "main",
      softPull: async () => { throw new Error("not asked"); },
      runWorktree: async (id, operation) => {
        locks.push(id);
        const value = await operation();
        if (id === "main") expect(calls.at(-1)).toBe("status /m");
        return value;
      },
      concurrency: 2
    });
    expect(locks[0]).toBe("main");
    expect(reports).toEqual(["Worktree 1 of 3 · a", "Worktree 2 of 3 · b", "Worktree 3 of 3 · c"]);
  });

  it("calls a repository whose worktrees all went unrun skipped, not a success", async () => {
    const calls: string[] = [];
    const result = await refreshRepositoryClones({
      git: fake(calls),
      repo,
      worktrees: [row("main", { isPrimary: true }), row("gone", { missing: true }), row("held", { locked: true })],
      updateMain: false,
      signal: new AbortController().signal,
      report: () => undefined,
      defaultBranch: async () => "main",
      softPull: async () => { throw new Error("not asked"); },
      runWorktree: (_id, operation) => operation()
    });
    expect(result.outcome).toBe("skipped");
    expect(calls.some((call) => call.startsWith("worktree"))).toBe(false);
  });

  it("stops before the donor refresh once cancelled", async () => {
    const calls: string[] = [];
    const controller = new AbortController();
    controller.abort();
    const result = await refreshRepositoryClones({
      git: fake(calls),
      repo,
      worktrees: [row("main", { isPrimary: true }), row("a")],
      updateMain: false,
      signal: controller.signal,
      report: () => undefined,
      defaultBranch: async () => "main",
      softPull: async () => { throw new Error("not asked"); },
      runWorktree: (_id, operation) => operation()
    });
    expect(result.outcome).toBe("cancelled");
    expect(calls).toEqual([]);
  });
});

/**
 * Real Git, end to end. Needs a Git with `git worktree reflink` (PwrGit's
 * runtime .2+), so it runs locally with
 *   PWRGIT_TEST_GIT=installed PATH=<runtime>/bin:$PATH
 * and skips elsewhere, CI included.
 */
const git = createSystemGit();
const usage = await git(["worktree", "-h"], tmpdir());
const canReshare = usage.ok && /git worktree reflink\b/.test(usage.value.stdout);

const run = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8" }).trim();

const sha = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

describe.skipIf(!canReshare)("refreshRepositoryClones with a reflink-capable Git", () => {
  let root: string;
  let main: string;
  let clean: string;
  let edited: string;
  let rows: ReshareWorktreeRow[];
  const repo: MaintenanceRepo = { id: "r", name: "fixture", path: "", profileId: "p", profileName: "P" };

  const deps = (overrides: Partial<Parameters<typeof refreshRepositoryClones>[0]> = {}) => ({
    git,
    repo,
    worktrees: rows,
    updateMain: true,
    signal: new AbortController().signal,
    report: () => undefined,
    defaultBranch: async () => "main",
    softPull: (primary: ReshareWorktreeRow) =>
      softPullMainCheckout(git, repo, primary, {
        operationId: "test",
        signal: new AbortController().signal,
        runWorktree: (_id, operation) => operation(),
        report: () => undefined
      }),
    runWorktree: <T,>(_id: string, operation: () => Promise<T>) => operation(),
    ...overrides
  });

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "pwrgit-reshare-")));
    const origin = join(root, "origin.git");
    const seed = join(root, "seed");
    main = join(root, "main");
    clean = join(root, "wt-clean");
    edited = join(root, "wt-edited");
    run(root, "init", "-q", "--bare", "-b", "main", origin);
    run(root, "init", "-q", "-b", "main", seed);
    for (const cwd of [seed]) {
      run(cwd, "config", "user.email", "t@example.com");
      run(cwd, "config", "user.name", "T");
    }
    for (let i = 1; i <= 4; i += 1) writeFileSync(join(seed, `blob${i}.bin`), Buffer.alloc(256 * 1024, i));
    writeFileSync(join(seed, "notes.txt"), "base\n");
    writeFileSync(join(seed, ".gitignore"), ".env\n");
    run(seed, "add", ".");
    run(seed, "commit", "-qm", "base");
    run(seed, "remote", "add", "origin", origin);
    run(seed, "push", "-q", "-u", "origin", "main");
    run(root, "clone", "-q", origin, main);
    run(main, "config", "user.email", "t@example.com");
    run(main, "config", "user.name", "T");
    // Plain worktrees: written by Git's ordinary writer, so every file is
    // private until re-shared.
    run(main, "-c", "checkout.reflink=false", "worktree", "add", "-q", "-b", "clean", clean);
    run(main, "-c", "checkout.reflink=false", "worktree", "add", "-q", "-b", "edited", edited);
    // Loose work that must survive untouched.
    writeFileSync(join(edited, "blob2.bin"), Buffer.alloc(256 * 1024, 42));
    writeFileSync(join(edited, "notes.txt"), "base\nlocal edit\n");
    writeFileSync(join(edited, "scratch.txt"), "untracked\n");
    writeFileSync(join(edited, ".env"), "SECRET=1\n");
    // Upstream moves on, so the main checkout has something to pull.
    writeFileSync(join(seed, "blob5.bin"), Buffer.alloc(256 * 1024, 5));
    run(seed, "add", ".");
    run(seed, "commit", "-qm", "more");
    run(seed, "push", "-q");
    repo.path = main;
    rows = [
      { id: "main", path: main, branch: "main", isPrimary: true, missing: false, locked: false },
      { id: "clean", path: clean, branch: "clean", isPrimary: false, missing: false, locked: false },
      { id: "edited", path: edited, branch: "edited", isPrimary: false, missing: false, locked: false }
    ];
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("fast-forwards the main checkout, re-shares clean files and leaves loose work alone", async () => {
    const before = {
      status: run(edited, "status", "--porcelain", "--ignored"),
      blob2: sha(join(edited, "blob2.bin")),
      notes: readFileSync(join(edited, "notes.txt"), "utf8"),
      scratch: readFileSync(join(edited, "scratch.txt"), "utf8"),
      env: readFileSync(join(edited, ".env"), "utf8"),
      clean: [1, 2, 3, 4].map((i) => sha(join(clean, `blob${i}.bin`)))
    };

    const result = await refreshRepositoryClones(deps());

    expect(result.reshare?.main).toMatchObject({ outcome: "updated", branch: "main" });
    expect(run(main, "rev-parse", "HEAD")).toBe(run(main, "rev-parse", "origin/main"));
    const [cleanResult, editedResult] = result.reshare!.worktrees;
    expect(cleanResult).toMatchObject({ outcome: "reshared", failed: 0 });
    expect(cleanResult!.reshared).toBeGreaterThanOrEqual(4);
    expect(cleanResult!.sharedBytes).toBeGreaterThan(0);
    expect(editedResult!.outcome).toBe("reshared");
    expect(editedResult!.skipped).toBeGreaterThanOrEqual(2);

    // Bytes and status are exactly as they were.
    expect([1, 2, 3, 4].map((i) => sha(join(clean, `blob${i}.bin`)))).toEqual(before.clean);
    expect(run(clean, "status", "--porcelain")).toBe("");
    expect(run(edited, "status", "--porcelain", "--ignored")).toBe(before.status);
    expect(sha(join(edited, "blob2.bin"))).toBe(before.blob2);
    expect(readFileSync(join(edited, "notes.txt"), "utf8")).toBe(before.notes);
    expect(readFileSync(join(edited, "scratch.txt"), "utf8")).toBe(before.scratch);
    expect(readFileSync(join(edited, ".env"), "utf8")).toBe(before.env);
    expect(result.outcome).toBe("success");
  });

  it("finds nothing new on a second run", async () => {
    const result = await refreshRepositoryClones(deps({ updateMain: false }));
    expect(result.reshare?.main.outcome).toBe("not_requested");
    expect(result.reshare?.worktrees.map((row) => row.reshared)).toEqual([0, 0]);
    expect(result.reshare?.worktrees[0]?.outcome).toBe("already_shared");
  });

  it("leaves a main checkout that is off its default branch", async () => {
    run(main, "switch", "-q", "-c", "side");
    try {
      const result = await refreshRepositoryClones(deps());
      expect(result.reshare?.main).toMatchObject({ outcome: "left", branch: "side" });
      expect(result.reshare?.main.message).toBe("Main checkout left: it is on side, not main.");
    } finally {
      run(main, "switch", "-q", "main");
    }
  });

  it("reports missing and locked worktrees without running Git in them", async () => {
    const result = await refreshRepositoryClones(
      deps({
        updateMain: false,
        worktrees: [
          rows[0]!,
          { ...rows[1]!, missing: true },
          { ...rows[2]!, locked: true }
        ]
      })
    );
    expect(result.reshare?.worktrees.map((row) => row.message)).toEqual([
      "Directory missing.",
      "Locked in Git, so left alone."
    ]);
  });
});
