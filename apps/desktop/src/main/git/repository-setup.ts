import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { err, ok, type HookRun, type RepositorySetup, type Result, type SetupHook, type SetupIgnoreTest } from "@pwrgit/shared";
import { NO_OPTIONAL_LOCKS, requireExit0, type GitExec } from "./dugite";
import { ignoreDestinations, validIgnorePath } from "./ignore-discovery";

const receipts = new Map<string, Map<string, HookRun & { at: number }>>();
const hookNames = new Set([
  "applypatch-msg", "pre-applypatch", "post-applypatch", "pre-commit", "pre-merge-commit",
  "prepare-commit-msg", "commit-msg", "post-commit", "pre-rebase", "post-checkout",
  "post-merge", "pre-push", "pre-receive", "update", "post-receive", "post-update",
  "push-to-checkout", "pre-auto-gc", "post-rewrite", "sendemail-validate",
  "fsmonitor-watchman", "reference-transaction", "post-index-change"
]);

async function commonDirectory(git: GitExec, cwd: string): Promise<Result<string>> {
  const raw = await git(["rev-parse", "--git-common-dir"], cwd, NO_OPTIONAL_LOCKS);
  if (!raw.ok) return raw;
  const checked = requireExit0(raw.value, ["rev-parse", "--git-common-dir"]);
  if (!checked.ok) return checked;
  try { return ok(realpathSync(resolve(cwd, checked.value.stdout.trim()))); }
  catch (cause) { return err({ kind: "repo", code: "common_dir_missing", message: "Git’s common directory is unavailable", cause }); }
}

/** A receipt belongs to the clone, so a different linked worktree sees it. */
export async function recordHookReceipts(git: GitExec, cwd: string, runs: HookRun[]): Promise<void> {
  if (runs.length === 0) return;
  try {
    const common = await commonDirectory(git, cwd);
    if (!common.ok) return;
    const byName = receipts.get(common.value) ?? new Map<string, HookRun & { at: number }>();
    for (const run of runs) byName.set(run.name, { ...run, at: Date.now() });
    receipts.set(common.value, byName);
  } catch { /* A receipt never changes a commit's outcome. */ }
}

function displayPath(cwd: string, path: string, common: string): string {
  if (path.startsWith(`${common}${sep}`)) return `.git/${relative(common, path).split(sep).join("/")}`;
  const local = relative(cwd, path);
  return local.startsWith("..") || isAbsolute(local) ? path : local.split(sep).join("/");
}

function readLines(path: string): { content: string; lines: { number: number; text: string }[] } {
  if (!existsSync(path)) return { content: "", lines: [] };
  try {
    if (statSync(path).size > 128_000) return { content: "", lines: [] };
    const content = readFileSync(path, "utf8");
    return { content, lines: content.split(/\r?\n/).map((text, index) => ({ number: index + 1, text })).filter((line) => line.text.trim() !== "") };
  } catch { return { content: "", lines: [] }; }
}

function hookCalls(path: string): string {
  try {
    const huskyTarget = basename(dirname(path)) === "_" && basename(dirname(dirname(path))) === ".husky"
      ? join(dirname(dirname(path)), basename(path)) : null;
    const source = huskyTarget !== null && existsSync(huskyTarget) ? huskyTarget : path;
    if (statSync(source).size > 64_000) return "script";
    const content = readFileSync(source, "utf8").slice(0, 8_192);
    const commands = content.split(/\r?\n/).map((part) => part.trim()).filter((part) => part !== "" && !part.startsWith("#") && part !== "exit 0");
    const line = commands.find((part) => /\bgit\s+lfs\s+/.test(part)) ?? commands[0];
    return line?.replace(/^exec\s+/, "") ?? "script";
  } catch { return "script"; }
}

function callsGitLfs(path: string): boolean {
  try { return statSync(path).size <= 64_000 && /\bgit\s+lfs\s+\S+/.test(readFileSync(path, "utf8")); }
  catch { return false; }
}

function listHooks(dir: string, cwd: string, common: string, lastRuns: Map<string, HookRun & { at: number }> | undefined): { hooks: SetupHook[]; sampleCount: number } {
  let entries: string[];
  try { entries = readdirSync(dir).slice(0, 128); } catch { return { hooks: [], sampleCount: 0 }; }
  let sampleCount = 0;
  const hooks: SetupHook[] = [];
  for (const name of entries) {
    if (name.endsWith(".sample")) { sampleCount++; continue; }
    if (!hookNames.has(name)) continue;
    const path = join(dir, name);
    try {
      const stat = statSync(path);
      if (!stat.isFile() || (process.platform !== "win32" && (stat.mode & 0o111) === 0)) continue;
      const lastRun = lastRuns?.get(name);
      hooks.push({ name, path, displayPath: displayPath(cwd, path, common), calls: hookCalls(path), ...(lastRun === undefined ? {} : { lastRun }) });
    } catch { /* Disappeared during inspection. */ }
  }
  return { hooks: hooks.sort((a, b) => a.name.localeCompare(b.name)), sampleCount };
}

function managerFor(cwd: string): string | null {
  if (existsSync(join(cwd, ".husky"))) return "Husky";
  if (existsSync(join(cwd, "lefthook.yml")) || existsSync(join(cwd, "lefthook.yaml"))) return "lefthook";
  if (existsSync(join(cwd, ".pre-commit-config.yaml"))) return "pre-commit";
  return null;
}

export async function readRepositorySetup(git: GitExec, cwd: string): Promise<Result<RepositorySetup>> {
  const locations = await ignoreDestinations(git, cwd);
  if (!locations.ok) return locations;
  const common = await commonDirectory(git, cwd);
  if (!common.ok) return common;
  const config = await git(["config", "--show-origin", "--path", "--get", "core.hooksPath"], cwd, NO_OPTIONAL_LOCKS);
  if (!config.ok) return config;
  if (config.value.exitCode > 1) {
    const failed = requireExit0(config.value, ["config", "--show-origin", "--get", "core.hooksPath"]);
    if (!failed.ok) return failed;
  }
  const pair = config.value.exitCode === 0 ? config.value.stdout.trim().split("\t", 2) : [];
  const configuredPath = pair[1] ?? null;
  const origin = pair[0] ?? null;
  const defaultDir = join(common.value, "hooks");
  const activeDir = configuredPath === null ? defaultDir : resolve(cwd, configuredPath);
  const lastRuns = receipts.get(common.value);
  const active = listHooks(activeDir, cwd, common.value, lastRuns);
  const shadowed = activeDir === defaultDir ? { hooks: [], sampleCount: 0 } : listHooks(defaultDir, cwd, common.value, undefined);
  const ignore = locations.value.destinations.map((destination) => ({ ...destination, ...readLines(destination.path) }));
  return ok({
    hooks: {
      directory: activeDir,
      displayDirectory: displayPath(cwd, activeDir, common.value),
      configuredPath,
      origin,
      manager: managerFor(cwd),
      active: active.hooks,
      shadowed: shadowed.hooks,
      sampleCount: active.sampleCount + shadowed.sampleCount,
      lfsShadowed: shadowed.hooks.some((hook) => callsGitLfs(hook.path)),
      worktreeCount: locations.value.worktreeCount
    },
    ignore
  });
}

export async function testSetupIgnorePath(git: GitExec, cwd: string, path: string): Promise<Result<SetupIgnoreTest>> {
  if (!validIgnorePath(path)) return err({ kind: "validation", code: "invalid_path", message: "Choose a path inside this worktree." });
  const raw = await git(["check-ignore", "-v", "-z", "--no-index", "--stdin"], cwd, { ...NO_OPTIONAL_LOCKS, input: `${path}\0` });
  if (!raw.ok) return raw;
  if (raw.value.exitCode === 1) return ok({ path, ignored: false, source: null, line: null, pattern: null });
  const checked = requireExit0(raw.value, ["check-ignore", "-v", "--no-index"]);
  if (!checked.ok) return checked;
  const [source = "", line = "", pattern = ""] = checked.value.stdout.split("\0");
  return ok({ path, ignored: !pattern.startsWith("!"), source, line: Number(line) || null, pattern });
}

export function saveSetupExclude(path: string, previous: string, content: string): Result<{ content: string }> {
  if (content.length > 128_000 || content.includes("\0")) return err({ kind: "validation", code: "invalid_content", message: "Ignore rules are too large or contain an invalid character." });
  try {
    if (existsSync(path) && statSync(path).size > 128_000) return err({ kind: "validation", code: "file_too_large", message: "This file is too large to edit here." });
  } catch (cause) { return err({ kind: "unknown", code: "read_failed", message: `Could not read ${basename(path)}: ${String(cause)}` }); }
  const current = readLines(path).content;
  if (current !== previous) return err({ kind: "validation", code: "changed_on_disk", message: "This file changed on disk. Reload it before saving." });
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
    return ok({ content });
  } catch (cause) {
    return err({ kind: "unknown", code: "write_failed", message: `Could not save ${basename(path)}: ${String(cause)}` });
  }
}
