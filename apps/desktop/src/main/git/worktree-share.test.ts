import { execFileSync } from "node:child_process";
import { chmodSync, constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandBus } from "../command-bus";
import { logMain } from "../logs";
import { openDatabase, type DB } from "../persistence/db";
import { ProfileService } from "../profiles/profile-service";
import { SettingsService } from "../settings/settings-service";
import type { GitExec } from "./dugite";
import { listWorktrees } from "./git-service";
import { RepoIndexer } from "./repo-indexer";
import { createSystemGit } from "./test-support/system-git";
import { registerWorktreeLifecycleHandlers } from "./worktree-lifecycle-handlers";
import { worktreePathFor } from "./worktree-paths";
import { WorktreeStateService } from "./worktree-state";

const hoisted = vi.hoisted(() => ({ git: null as unknown as GitExec }));
vi.mock("../ipc", () => ({ emitEvent: vi.fn() }));
vi.mock("../logs", () => ({ logMain: vi.fn() }));
vi.mock("./dugite", async (importActual) => ({
  ...await importActual<typeof import("./dugite")>(),
  execGit: (...args: Parameters<GitExec>) => hoisted.git(...args)
}));

let root: string;
let fixture: string;
let binary: string;
let specFile: string;
let invocationFile: string;
let repo: string;
let otherRepo: string;
let db: DB;
let bus: CommandBus;
let settings: SettingsService;
let repoId: string;
let indexer: RepoIndexer;
let otherProfile: string;
const calls: string[][] = [];
const systemGit = createSystemGit();

function git(path: string, args: string[]): void {
  execFileSync("git", ["-C", path, ...args], { cwd: tmpdir(), stdio: "ignore" });
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "pwrgit-share-handler-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  binary = join(bin, process.platform === "win32" ? "pwrgit-share.exe" : "pwrgit-share");
  // A real executable on every platform, including Windows where execFile
  // cannot launch a .cmd without a shell. A test-only Node preload implements
  // the CLI and exits before Node tries to load the "worktree" main script.
  copyFileSync(process.execPath, binary, constants.COPYFILE_FICLONE);
  chmodSync(binary, 0o755);
  writeFileSync(join(root, "fake.cjs"), `
    const fs = require('node:fs');
    const cp = require('node:child_process');
    const path = require('node:path');
    if (path.basename(process.argv[1] || '') === 'worktree') {
      const spec = JSON.parse(fs.readFileSync(process.env.PWRGIT_TEST_SHARE_SPEC, 'utf8'));
      const args = ['worktree', ...process.argv.slice(2)];
      fs.writeFileSync(spec.invocationFile, JSON.stringify(args));
      if (spec.create) {
        const gitArgs = args.filter((arg, i) => arg !== '--json' && arg !== '--seed-target' && arg !== '--donor' && args[i - 1] !== '--donor');
        cp.execFileSync('git', ['-C', spec.repo, ...gitArgs], { cwd: require('node:os').tmpdir(), stdio: 'ignore' });
        if (spec.missingFolder) fs.rmSync(args[args.indexOf('--') + 1], { recursive: true, force: true });
      }
      process.stdout.write(JSON.stringify({ fallback: spec.fallback || 'none', createdWorktree: !!spec.create, clonedFiles: 1, checkoutFiles: 0, hashedMismatches: 0 }) + '\\n');
      if (spec.crash) process.kill(process.pid, 'SIGKILL');
      if (spec.exitCode) process.stderr.write('sharing failed after registration\\n');
      process.exit(spec.exitCode || 0);
    }
  `);
});

beforeEach(async () => {
  vi.clearAllMocks();
  calls.length = 0;
  fixture = mkdtempSync(join(root, "case-"));
  repo = join(fixture, "repo");
  otherRepo = join(fixture, "other-repo");
  mkdirSync(repo);
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.name", "Fixture"]);
  git(repo, ["config", "user.email", "fixture@example.invalid"]);
  git(repo, ["config", "core.autocrlf", "false"]);
  writeFileSync(join(repo, "source.txt"), "fixture source\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "fixture"]);
  git(repo, ["clone", "--", repo, otherRepo]);
  db = openDatabase(":memory:");
  const profiles = new ProfileService(db);
  const profile = profiles.create({ name: "Fixture", email: "fixture@example.invalid" });
  otherProfile = profiles.create({ name: "Other", email: "other@example.invalid" }).id;
  indexer = new RepoIndexer(db, systemGit);
  const indexed = await indexer.indexRepoAt(profile.id, repo);
  if (!indexed.ok) throw new Error("fixture indexing failed");
  repoId = indexed.value.id;
  // Use the same canonical donor spelling the handler reads from the DB.
  repo = indexed.value.path;
  await indexer.indexRepoAt(otherProfile, otherRepo);
  settings = new SettingsService(join(fixture, "settings.json"));
  settings.update({ worktreeRoot: join(fixture, "worktrees") });
  bus = new CommandBus();
  hoisted.git = async (args, cwd, options) => {
    calls.push(args);
    return systemGit(args, cwd, options);
  };
  registerWorktreeLifecycleHandlers(bus, db, indexer, settings, new WorktreeStateService(db, systemGit));
  specFile = join(fixture, "spec.json");
  invocationFile = join(fixture, "invocation.json");
  configureFake({ create: true });
  vi.stubEnv("PATH", `${join(root, "bin")}${delimiter}${process.env.PATH ?? ""}`);
  vi.stubEnv("NODE_OPTIONS", `${process.env.NODE_OPTIONS ?? ""} --require ${JSON.stringify(join(root, "fake.cjs"))}`);
  vi.stubEnv("PWRGIT_TEST_SHARE_SPEC", specFile);
  vi.stubEnv("CARGO_HOME", join(fixture, "cargo-home"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  // Another profile's checkout and index never participate in this create.
  const other = await listWorktrees(systemGit, otherRepo);
  expect(other.ok && other.value).toHaveLength(1);
  expect(indexer.listRepos(otherProfile)[0]?.worktrees).toHaveLength(1);
  db.close();
  await rm(fixture, { recursive: true, force: true });
});

afterAll(async () => { await rm(root, { recursive: true, force: true }); });

function configureFake(spec: { create?: boolean; fallback?: string; exitCode?: number; crash?: boolean; missingFolder?: boolean }): void {
  writeFileSync(specFile, JSON.stringify({ repo, invocationFile, ...spec }));
}

function create(branch = "feature", newBranch = true, startPoint?: string) {
  return bus.dispatch("worktree:create", { repoId, branch, newBranch, ...(startPoint === undefined ? {} : { startPoint }) });
}

function normalAdds(): string[][] {
  return calls.filter((args) => args[0] === "worktree" && args[1] === "add");
}

function invocation(): string[] {
  return JSON.parse(readFileSync(invocationFile, "utf8")) as string[];
}

describe("opt-in worktree sharing through the create handler", () => {
  it("does not execute the fake when off and uses today's add", async () => {
    expect((await create()).ok).toBe(true);
    expect(existsSync(invocationFile)).toBe(false);
    expect(normalAdds()).toHaveLength(1);
  });

  it("uses a created checkout without also calling worktreeAdd", async () => {
    settings.update({ worktreeReflink: "on" });
    const result = await create("feature", true, "main");
    expect(result.ok && result.value.worktreeId).toEqual(expect.any(String));
    expect(normalAdds()).toHaveLength(0);
    expect(invocation()).toEqual(["worktree", "add", "--json", "--donor", repo, "-b", "feature", "--", worktreePathFor(settings, "repo", "feature"), "main"]);
    expect(readFileSync(join(worktreePathFor(settings, "repo", "feature"), "source.txt"), "utf8")).toBe("fixture source\n");
  });

  it("checks out an existing branch with the CLI", async () => {
    git(repo, ["branch", "existing"]);
    settings.update({ worktreeReflink: "on" });
    expect((await create("existing", false)).ok).toBe(true);
    expect(invocation()).not.toContain("-b");
    expect(invocation().at(-1)).toBe("existing");
    expect(normalAdds()).toHaveLength(0);
  });

  it.each([false, true])("records fallback and only adds when necessary (CLI created: %s)", async (created) => {
    settings.update({ worktreeReflink: "on" });
    configureFake({ create: created, fallback: "git-checkout" });
    expect((await create()).ok).toBe(true);
    expect(normalAdds()).toHaveLength(created ? 0 : 1);
    expect(logMain).toHaveBeenCalledWith("info", "worktree", "Worktree sharing is unavailable; using a normal Git checkout.");
    const listed = await listWorktrees(systemGit, repo);
    expect(listed.ok && listed.value).toHaveLength(2);
  });

  it("falls back when the configured executable is missing", async () => {
    settings.update({ worktreeReflink: "on", worktreeShareCommand: join(fixture, "missing-pwrgit-share") });
    expect((await create()).ok).toBe(true);
    expect(normalAdds()).toHaveLength(1);
    expect(existsSync(invocationFile)).toBe(false);
    expect(logMain).toHaveBeenCalledWith("info", "worktree", "pwrgit-share is unavailable; using a normal Git checkout.");
  });

  it("honors the executable override before PATH", async () => {
    const override = join(root, process.platform === "win32" ? "override.exe" : "override");
    copyFileSync(binary, override, constants.COPYFILE_FICLONE);
    chmodSync(override, 0o755);
    settings.update({ worktreeReflink: "on", worktreeShareCommand: override });
    expect((await create()).ok).toBe(true);
    expect(existsSync(invocationFile)).toBe(true);
    expect(normalAdds()).toHaveLength(0);
  });

  it.each([
    { exitCode: 3 }, { exitCode: 4 }, { exitCode: 1 }, { crash: true },
    { crash: true, missingFolder: true }
  ])("rolls back only the newly registered checkout on failure %j", async (failure) => {
    const kept = join(fixture, "kept");
    git(repo, ["worktree", "add", "-b", "kept", kept]);
    settings.update({ worktreeReflink: "on", worktreeSeedCargoTarget: "on" });
    configureFake({ create: true, ...failure });
    const result = await create();
    expect(result).toMatchObject({ ok: false, error: { kind: "repo", code: "worktree_add_failed" } });
    expect(existsSync(invocationFile)).toBe(true);
    expect(normalAdds()).toHaveLength(0);
    const listed = await listWorktrees(systemGit, repo);
    expect(listed.ok && listed.value.map((w) => w.branch).sort()).toEqual(["kept", "main"]);
    expect(existsSync(worktreePathFor(settings, "repo", "feature"))).toBe(false);
    expect(readFileSync(join(kept, "source.txt"), "utf8")).toBe("fixture source\n");
    expect(calls.some((args) => args.includes("prune"))).toBe(false);
  });

  it("leaves a pre-existing worktree alone and uses the existing collision error", async () => {
    expect((await create()).ok).toBe(true);
    calls.length = 0;
    settings.update({ worktreeReflink: "on" });
    expect(await create()).toMatchObject({ ok: false, error: { kind: "repo", code: "already_exists" } });
    expect(existsSync(invocationFile)).toBe(false);
    const listed = await listWorktrees(systemGit, repo);
    expect(listed.ok && listed.value).toHaveLength(2);
  });

  it.each([
    ["off", "off"], ["off", "on"], ["on", "off"], ["on", "on"]
  ] as const)("passes --seed-target only with both settings on (%s, %s)", async (reflink, seed) => {
    settings.update({ worktreeReflink: reflink, worktreeSeedCargoTarget: seed });
    expect((await create()).ok).toBe(true);
    if (reflink === "off") expect(existsSync(invocationFile)).toBe(false);
    else expect(invocation().includes("--seed-target")).toBe(seed === "on");
  });
});
