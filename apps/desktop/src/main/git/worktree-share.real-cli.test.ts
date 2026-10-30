import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandBus } from "../command-bus";
import { logMain } from "../logs";
import { openDatabase, type DB } from "../persistence/db";
import { ProfileService } from "../profiles/profile-service";
import { SettingsService } from "../settings/settings-service";
import { bundledGitPath, useInstalledGit, type GitExec } from "./dugite";
import { registerBranchHandlers } from "./branch-handlers";
import { listWorktrees } from "./git-service";
import { RepoIndexer } from "./repo-indexer";
import { createSystemGit } from "./test-support/system-git";
import { registerWorktreeLifecycleHandlers } from "./worktree-lifecycle-handlers";
import { worktreePathFor } from "./worktree-paths";
import { WorktreeStateService } from "./worktree-state";
import { WorktreeOperationQueue } from "./worktree-operation-queue";

const hoisted = vi.hoisted(() => ({ git: null as unknown as GitExec }));
vi.mock("../ipc", () => ({ emitEvent: vi.fn() }));
vi.mock("../logs", () => ({ logMain: vi.fn() }));
vi.mock("./dugite", async (importActual) => ({
  ...await importActual<typeof import("./dugite")>(),
  execGit: (...args: Parameters<GitExec>) => hoisted.git(...args)
}));

// Explicit opt-in keeps ordinary desktop tests independent of the Rust build.
// Every invocation below operates only on repositories/Cargo homes we create.
const binary = process.env.PWRGIT_SHARE_REAL_BINARY;
const run = promisify(execFile);
const systemGit = createSystemGit();

describe.skipIf(binary === undefined || process.platform !== "darwin")("worktree:create with the real pwrgit-share CLI", () => {
  let root: string;
  let donor: string;
  let db: DB;
  let settings: SettingsService;
  let bus: CommandBus;
  let repoId: string;
  let otherRepo: string;
  let indexer: RepoIndexer;
  const calls: string[][] = [];
  let lockHolder: ChildProcess | undefined;

  function git(path: string, args: string[]): string {
    return execFileSync("git", ["-C", path, ...args], { cwd: tmpdir(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    calls.length = 0;
    root = mkdtempSync(join(tmpdir(), "pwrgit-real-share-"));
    vi.stubEnv("CARGO_HOME", join(root, "cargo-home"));
    vi.stubEnv("CARGO_TARGET_DIR", undefined);
    donor = join(root, "donor");
    mkdirSync(donor);
    git(donor, ["init", "-b", "main"]);
    git(donor, ["config", "user.name", "Fixture"]);
    git(donor, ["config", "user.email", "fixture@example.invalid"]);
    git(donor, ["config", "core.autocrlf", "false"]);
    writeFileSync(join(donor, "clean.txt"), "clean fixture source\n".repeat(1024));
    writeFileSync(join(donor, "dirty.txt"), "committed\n");
    writeFileSync(join(donor, ".gitignore"), "target/\nprivate.txt\n");
    symlinkSync("clean.txt", join(donor, "link.txt"));
    git(donor, ["add", "."]);
    git(donor, ["commit", "-m", "fixture"]);
    writeFileSync(join(donor, "dirty.txt"), "private donor edit\n");
    writeFileSync(join(donor, "private.txt"), "ignored fixture secret\n");
    writeFileSync(join(donor, "untracked.txt"), "untracked fixture secret\n");
    otherRepo = join(root, "other-repo");
    git(donor, ["clone", "--", donor, otherRepo]);
    db = openDatabase(":memory:");
    const profiles = new ProfileService(db);
    const profile = profiles.create({ name: "Fixture", email: "fixture@example.invalid" });
    const otherProfile = profiles.create({ name: "Other", email: "other@example.invalid" });
    indexer = new RepoIndexer(db, systemGit);
    const indexed = await indexer.indexRepoAt(profile.id, donor);
    if (!indexed.ok) throw new Error("fixture indexing failed");
    donor = indexed.value.path;
    repoId = indexed.value.id;
    await indexer.indexRepoAt(otherProfile.id, otherRepo);
    settings = new SettingsService(join(root, "settings.json"));
    settings.update({ worktreeRoot: join(root, "managed"), worktreeReflink: "on", worktreeShareCommand: resolve(binary!) });
    hoisted.git = async (args, cwd, options) => {
      calls.push(args);
      return systemGit(args, cwd, options);
    };
    bus = new CommandBus();
    const operations = new WorktreeOperationQueue();
    registerWorktreeLifecycleHandlers(bus, db, indexer, settings, new WorktreeStateService(db, systemGit, operations), operations);
    registerBranchHandlers(bus, db, indexer, {
      refreshWorktree: vi.fn(), refreshRepoWorktrees: vi.fn()
    }, operations, settings);
  });

  afterEach(async () => {
    if (lockHolder) {
      const exited = new Promise<void>((done) => lockHolder!.once("exit", () => done()));
      lockHolder.kill();
      await exited;
      lockHolder = undefined;
    }
    vi.unstubAllEnvs();
    useInstalledGit(null);
    expect(git(otherRepo, ["worktree", "list", "--porcelain"]).match(/^worktree /gm)).toHaveLength(1);
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  function create(branch = "feature", newBranch = true, startPoint?: string) {
    return bus.dispatch("worktree:create", { repoId, branch, newBranch, ...(startPoint === undefined ? {} : { startPoint }) });
  }

  const normalAdds = () => calls.filter((args) => args[0] === "worktree" && args[1] === "add");
  const destination = (branch = "feature") => worktreePathFor(settings, "donor", branch);
  async function measure(path: string) {
    return JSON.parse((await run(binary!, ["measure", "--json", path])).stdout) as { cloneCount: number; copyCount: number; logicalBytes: number; countsOrigin: string };
  }

  it("creates under a fresh managed root, preserves source isolation, and uses no hardlinks", async () => {
    const probe = JSON.parse((await run(binary!, ["probe", "--json", root])).stdout) as { cow: string };
    expect(probe.cow).toBe("apfs");
    expect(existsSync(join(root, "managed"))).toBe(false);
    const result = await create();
    expect(result).toMatchObject({ ok: true, value: { worktreeId: expect.any(String) } });
    expect(normalAdds()).toHaveLength(0);
    expect(git(destination(), ["status", "--porcelain"])).toBe("");
    const report = await measure(destination());
    expect(report.cloneCount).toBeGreaterThan(0);
    expect(report.copyCount).toBe(0);
    console.info("real-cli APFS source materialization:", JSON.stringify({ cow: probe.cow, clonedFiles: report.cloneCount, copyCount: report.copyCount }));
    expect(readFileSync(join(destination(), "dirty.txt"), "utf8")).toBe("committed\n");
    expect(existsSync(join(destination(), "private.txt"))).toBe(false);
    expect(existsSync(join(destination(), "untracked.txt"))).toBe(false);
    const source = join(donor, "clean.txt");
    const recipient = join(destination(), "clean.txt");
    expect(statSync(source).ino).not.toBe(statSync(recipient).ino);
    expect(statSync(source).nlink).toBe(1);
    expect(statSync(recipient).nlink).toBe(1);
    const original = readFileSync(source, "utf8");
    writeFileSync(recipient, "recipient edit\n");
    expect(readFileSync(source, "utf8")).toBe(original);
    git(destination(), ["reset", "--hard", "HEAD"]);
    expect(readFileSync(source, "utf8")).toBe(original);
    writeFileSync(source, "donor edit\n");
    expect(readFileSync(recipient, "utf8")).toBe(original);
  });

  it("uses the real executable on PATH and checks out an existing branch", async () => {
    const bin = join(root, "bin");
    mkdirSync(bin);
    symlinkSync(resolve(binary!), join(bin, "pwrgit-share"));
    vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH ?? ""}`);
    settings.update({ worktreeShareCommand: "" });
    git(donor, ["branch", "existing"]);
    expect(await create("existing", false)).toMatchObject({ ok: true });
    expect(git(destination("existing"), ["symbolic-ref", "--short", "HEAD"])).toBe("existing");
    expect((await measure(destination("existing"))).cloneCount).toBeGreaterThan(0);
    expect(normalAdds()).toHaveLength(0);
  });

  it("shares branch-from-commit creation from the focused linked donor", async () => {
    const linked = join(root, "linked-donor");
    git(donor, ["worktree", "add", "-b", "donor", linked]);
    writeFileSync(join(linked, "clean.txt"), "linked donor source\n");
    git(linked, ["commit", "-am", "linked donor update"]);
    const selected = git(linked, ["rev-parse", "HEAD"]);
    await indexer.refreshRepoWorktrees(repoId);
    const row = db.prepare("SELECT id FROM worktrees WHERE repo_id = ? AND branch = ?").get(repoId, "donor") as { id: string };
    const result = await bus.dispatch("branch:create", {
      worktreeId: row.id, branch: "from-commit", startPoint: selected, checkout: "new-worktree"
    });
    expect(result).toMatchObject({ ok: true, value: { checkedOutWorktreeId: expect.any(String) } });
    const path = destination("from-commit");
    expect(git(path, ["rev-parse", "HEAD"])).toBe(selected);
    expect(readFileSync(join(path, "clean.txt"), "utf8")).toBe("linked donor source\n");
    // All three regular files are clean in the linked donor. The primary
    // checkout has a dirty file and a different blob, so it cannot clone them.
    expect((await measure(path)).cloneCount).toBe(3);
    expect(normalAdds()).toHaveLength(0);
  });

  it("accepts the real CLI's fallback checkout without adding it a second time", async () => {
    vi.stubEnv("PWRGIT_SHARE_FORCE_NONE", "1");
    expect(await create()).toMatchObject({ ok: true });
    expect(normalAdds()).toHaveLength(0);
    expect((await measure(destination())).cloneCount).toBe(0);
    expect(git(destination(), ["status", "--porcelain"])).toBe("");
    expect(logMain).toHaveBeenCalledWith("info", "worktree", "Worktree sharing is unavailable; using a normal Git checkout.");
  });

  it("reports an invalid start point through the existing error path without registering a checkout", async () => {
    expect(await create("invalid", true, "missing-ref")).toMatchObject({ ok: false, error: { kind: "repo", code: "worktree_add_failed" } });
    const listed = await listWorktrees(systemGit, donor);
    expect(listed.ok && listed.value).toHaveLength(1);
    expect(existsSync(destination("invalid"))).toBe(false);
  });

  it("removes the real CLI's registration after a crash without touching an existing worktree", async () => {
    const kept = join(root, "kept");
    git(donor, ["worktree", "add", "-b", "kept", kept]);
    const bin = join(root, "paused-git");
    const marker = join(root, "hash-ready.json");
    mkdirSync(bin);
    const wrapper = join(bin, "git");
    writeFileSync(wrapper, `#!${process.execPath}\n
      const fs = require('node:fs');
      const cp = require('node:child_process');
      const args = process.argv.slice(2);
      if (args.includes('hash-object')) {
        fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({cliPid:process.ppid}));
        while (fs.existsSync(${JSON.stringify(marker)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
      const result = cp.spawnSync(${JSON.stringify(bundledGitPath())}, args, {stdio:'inherit'});
      process.exit(result.status ?? 1);
    `);
    chmodSync(wrapper, 0o755);
    useInstalledGit(wrapper);
    const pending = create("crashed");
    try {
      await vi.waitFor(() => expect(existsSync(marker)).toBe(true));
      const { cliPid } = JSON.parse(readFileSync(marker, "utf8")) as { cliPid: number };
      process.kill(cliPid, "SIGKILL");
    } finally {
      if (existsSync(marker)) unlinkSync(marker);
    }
    expect(await pending).toMatchObject({ ok: false, error: { kind: "repo", code: "worktree_add_failed" } });
    expect(normalAdds()).toHaveLength(0);
    const listed = await listWorktrees(systemGit, donor);
    expect(listed.ok && listed.value.map((w) => w.branch).sort()).toEqual(["kept", "main"]);
    expect(existsSync(destination("crashed"))).toBe(false);
    expect(readFileSync(join(kept, "dirty.txt"), "utf8")).toBe("committed\n");
  });

  it("forwards seeding to the real CLI and returns the safe zero-seed result", async () => {
    mkdirSync(join(donor, "src"));
    writeFileSync(join(donor, "Cargo.toml"), "[package]\nname='fixture'\nversion='0.1.0'\nedition='2024'\n");
    writeFileSync(join(donor, "src", "lib.rs"), "pub fn answer() -> u32 { 42 }\n");
    execFileSync("cargo", ["build", "--offline"], { cwd: donor, stdio: "pipe", env: { ...process.env, CARGO_TARGET_DIR: join(donor, "target") } });
    git(donor, ["add", "Cargo.toml", "Cargo.lock", "src"]);
    git(donor, ["commit", "-m", "cargo fixture"]);
    const donorArtifact = join(donor, "target", "debug", "libfixture.rlib");
    const before = readFileSync(donorArtifact);
    settings.update({ worktreeSeedCargoTarget: "on" });
    expect(await create()).toMatchObject({ ok: true });
    expect((await measure(destination())).cloneCount).toBeGreaterThan(0);
    expect(existsSync(join(destination(), "target"))).toBe(false);
    const seed = JSON.parse((await run(binary!, ["target", "seed", "--from", join(donor, "target"), "--to", join(root, "standalone-target"), "--json"])).stdout);
    expect(seed).toMatchObject({ unitsSeeded: 0, cloneCount: 0, copyCount: 0, reason: "fingerprint-unproven" });
    expect(readFileSync(donorArtifact)).toEqual(before);
    expect(existsSync(join(root, "standalone-target"))).toBe(false);
  });

  it("fails cleanly for a locked donor only when seeding is enabled", async () => {
    mkdirSync(join(donor, "target", "debug"), { recursive: true });
    const path = join(donor, "target", "debug", ".cargo-lock");
    writeFileSync(path, "");
    lockHolder = spawn("python3", ["-c", "import fcntl,sys,time; f=open(sys.argv[1], 'r'); fcntl.flock(f, fcntl.LOCK_EX); print('locked', flush=True); time.sleep(300)", path], { stdio: ["ignore", "pipe", "pipe"] });
    await new Promise<void>((done, fail) => {
      lockHolder!.stdout!.once("data", () => done());
      lockHolder!.once("error", fail);
      lockHolder!.once("exit", (code) => fail(new Error(`lock holder exited: ${code}`)));
    });
    settings.update({ worktreeSeedCargoTarget: "on" });
    expect(await create("locked")).toMatchObject({ ok: false, error: { kind: "repo", code: "worktree_add_failed", message: expect.stringContaining("locked") } });
    const listed = await listWorktrees(systemGit, donor);
    expect(listed.ok && listed.value).toHaveLength(1);
    expect(existsSync(destination("locked"))).toBe(false);
    settings.update({ worktreeSeedCargoTarget: "off" });
    expect(await create("source-only")).toMatchObject({ ok: true });
    expect((await measure(destination("source-only"))).cloneCount).toBeGreaterThan(0);
  });
});
