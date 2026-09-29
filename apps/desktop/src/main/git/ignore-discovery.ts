import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import {
  err,
  ok,
  type IgnoreDestination,
  type IgnoreDestinationOption,
  type IgnoreOptions,
  type IgnorePatternChoice,
  type IgnoredSummary,
  type Result
} from "@pwrgit/shared";
import { NO_OPTIONAL_LOCKS, requireExit0, type GitExec } from "./dugite";
import { toGitignorePattern } from "./gitignore";

const invalidPath = () => err({ kind: "validation" as const, code: "invalid_path", message: "Choose a path inside this worktree." });

export function validIgnorePath(path: string): boolean {
  return path !== "" && !isAbsolute(path) && !path.split("/").includes("..") && !path.includes("\0") && !path.includes("\\");
}

function folderFor(path: string, directory: boolean): string {
  if (directory) return path;
  const parts = path.split("/");
  // The personal root is the useful unit: `.local/shots/a.png` belongs to
  // `.local/` across worktrees, as card 4a shows.
  if ([".local", ".scratch"].includes(parts[0] ?? "") && parts.length > 1) return parts[0] ?? "";
  if (parts[0] === ".claude" && parts[1] === "worktrees" && parts.length > 2) return ".claude/worktrees";
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

export function patternForChoice(path: string, directory: boolean, choice: IgnorePatternChoice): string | null {
  if (!validIgnorePath(path)) return null;
  if (choice === "file") return toGitignorePattern(path, { directory });
  if (choice === "folder") {
    const folder = folderFor(path, directory);
    return folder === "" ? null : toGitignorePattern(folder, { directory: true });
  }
  const ext = extname(path);
  return ext === "" ? null : `*${ext.replace(/[\\*?[\]]/g, (char) => `\\${char}`)}`;
}

export function suggestIgnoreDestination(path: string, projectTracksToolFolder = false): IgnoreDestination {
  const parts = path.split("/");
  const name = basename(path);
  const tool = parts.find((part) => part === ".idea" || part === ".vscode");
  if ([".DS_Store", "Thumbs.db"].includes(name) || name.endsWith(".swp")) return "global";
  if (tool !== undefined || name.endsWith(".code-workspace")) return projectTracksToolFolder ? "gitignore" : "global";
  if ([".local", ".scratch"].includes(parts[0] ?? "") || (parts[0] === ".claude" && parts[1] === "worktrees")) return "exclude";
  return "gitignore";
}

export async function ignoreDestinations(git: GitExec, cwd: string): Promise<Result<{ destinations: IgnoreDestinationOption[]; worktreeCount: number }>> {
  const common = await git(["rev-parse", "--git-common-dir"], cwd, NO_OPTIONAL_LOCKS);
  if (!common.ok) return common;
  const checked = requireExit0(common.value, ["rev-parse", "--git-common-dir"]);
  if (!checked.ok) return checked;
  const commonDir = resolve(cwd, checked.value.stdout.trim());

  const configured = await git(["config", "--path", "--get", "core.excludesFile"], cwd, NO_OPTIONAL_LOCKS);
  if (!configured.ok) return configured;
  if (configured.value.exitCode > 1) {
    const failed = requireExit0(configured.value, ["config", "--path", "--get", "core.excludesFile"]);
    if (!failed.ok) return err(failed.error);
  }
  const defaultGlobal = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "git", "ignore");
  const globalPath = configured.value.exitCode === 0 && configured.value.stdout.trim() !== ""
    ? resolve(cwd, configured.value.stdout.trim().replace(/^~(?=\/)/, homedir()))
    : defaultGlobal;

  const worktrees = await git(["worktree", "list", "--porcelain"], cwd, NO_OPTIONAL_LOCKS);
  if (!worktrees.ok) return worktrees;
  const worktreeCount = worktrees.value.exitCode === 0
    ? Math.max(1, worktrees.value.stdout.split("\n").filter((line) => line.startsWith("worktree ")).length)
    : 1;
  return ok({
    worktreeCount,
    destinations: [
      { destination: "gitignore", path: join(cwd, ".gitignore"), displayPath: ".gitignore", scope: "committed · team" },
      { destination: "exclude", path: join(commonDir, "info", "exclude"), displayPath: ".git/info/exclude", scope: `this clone · ${worktreeCount} worktree${worktreeCount === 1 ? "" : "s"}` },
      { destination: "global", path: globalPath, displayPath: globalPath === defaultGlobal ? "~/.config/git/ignore" : globalPath, scope: "this Mac" }
    ]
  });
}

function matchCount(paths: string[], path: string, directory: boolean, choice: IgnorePatternChoice): number {
  if (choice === "file") return paths.filter((candidate) => directory ? candidate.startsWith(`${path}/`) : candidate === path).length;
  if (choice === "folder") {
    const folder = folderFor(path, directory);
    return paths.filter((candidate) => candidate.startsWith(`${folder}/`)).length;
  }
  const extension = extname(path);
  return paths.filter((candidate) => basename(candidate).endsWith(extension)).length;
}

export async function readIgnoreOptions(git: GitExec, cwd: string, path: string, directory: boolean): Promise<Result<IgnoreOptions>> {
  if (!validIgnorePath(path)) return invalidPath();
  const location = await ignoreDestinations(git, cwd);
  if (!location.ok) return location;
  const untracked = await git(["ls-files", "--others", "--exclude-standard", "-z"], cwd, NO_OPTIONAL_LOCKS);
  if (!untracked.ok) return untracked;
  const checked = requireExit0(untracked.value, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (!checked.ok) return checked;
  const files = checked.value.stdout.split("\0").filter(Boolean);
  const choices: IgnorePatternChoice[] = ["file", "folder", "extension"];
  const patterns = choices.flatMap((choice) => {
    const pattern = patternForChoice(path, directory, choice);
    return pattern === null ? [] : [{ choice, pattern, count: matchCount(files, path, directory, choice) }];
  });

  const toolFolder = path.split("/").find((part) => part === ".idea" || part === ".vscode");
  let tracksTool = false;
  if (toolFolder !== undefined) {
    const tracked = await git(["ls-files", "--", toolFolder], cwd, NO_OPTIONAL_LOCKS);
    tracksTool = tracked.ok && tracked.value.exitCode === 0 && tracked.value.stdout.trim() !== "";
  }
  return ok({ ...location.value, patterns, suggested: suggestIgnoreDestination(path, tracksTool) });
}

/** Ask Git for ignored untracked paths, then attribute all of them in one
 * check-ignore invocation. Only personal rules become a resting footer. */
export async function readIgnoredSummary(git: GitExec, cwd: string): Promise<Result<IgnoredSummary>> {
  const location = await ignoreDestinations(git, cwd);
  if (!location.ok) return location;
  const status = await git(["status", "--ignored=matching", "--porcelain=v1", "--untracked-files=all", "-z"], cwd, NO_OPTIONAL_LOCKS);
  if (!status.ok) return status;
  const checked = requireExit0(status.value, ["status", "--ignored=matching"]);
  if (!checked.ok) return checked;
  const paths = checked.value.stdout.split("\0").filter((record) => record.startsWith("!! ")).map((record) => record.slice(3));
  if (paths.length === 0) return ok({ count: 0, rules: [], worktreeCount: location.value.worktreeCount });

  const attributed = await git(["check-ignore", "-v", "-z", "--stdin"], cwd, { ...NO_OPTIONAL_LOCKS, input: `${paths.join("\0")}\0` });
  if (!attributed.ok) return attributed;
  if (attributed.value.exitCode > 1) {
    const failed = requireExit0(attributed.value, ["check-ignore", "-v", "-z", "--stdin"]);
    if (!failed.ok) return err(failed.error);
  }
  const fields = attributed.value.stdout.split("\0");
  const excludePath = location.value.destinations.find((item) => item.destination === "exclude")?.path ?? "";
  const globalPath = location.value.destinations.find((item) => item.destination === "global")?.path ?? "";
  const grouped = new Map<string, IgnoredSummary["rules"][number]>();
  let count = 0;
  for (let i = 0; i + 3 < fields.length; i += 4) {
    const [source = "", lineText = "", pattern = "", matchedPath = ""] = fields.slice(i, i + 4);
    if (matchedPath === "" || pattern.startsWith("!")) continue;
    const absolute = resolve(cwd, source);
    const destination = absolute === excludePath ? "exclude" : absolute === globalPath ? "global" : null;
    if (destination === null) continue;
    const line = Number.parseInt(lineText, 10);
    const key = `${destination}\0${source}\0${line}\0${pattern}`;
    const prior = grouped.get(key);
    if (prior) prior.count += 1;
    else grouped.set(key, { source, line, pattern, count: 1, destination });
    count += 1;
  }
  return ok({ count, rules: [...grouped.values()], worktreeCount: location.value.worktreeCount });
}
