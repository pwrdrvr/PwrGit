import { execFile } from "node:child_process";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { err, ok, type Result } from "@pwrgit/shared";
import type { AppSettings } from "../settings/settings-service";
import { gitLaunch, type GitExec } from "./dugite";
import {
  listWorktrees,
  worktreeAdd,
  worktreeAddError,
  worktreeRemove
} from "./git-service";

const run = promisify(execFile);

// Git canonicalizes parent symlinks even when a checkout's folder is missing.
async function canonicalPath(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch {
    const parent = dirname(absolute);
    return parent === absolute
      ? absolute
      : join(await canonicalPath(parent), basename(absolute));
  }
}

/** Only creation changes; shared checkouts use the ordinary removal path.
 * Callers hold the shared repository queue for this entire operation: an
 * overlapping create must not register a checkout between snapshot and rollback. */
export async function worktreeAddWithSharing(
  git: GitExec,
  repoPath: string,
  worktreePath: string,
  branch: string,
  options: { newBranch: boolean; startPoint?: string },
  settings: AppSettings,
  notice: (message: string) => void,
  signal?: AbortSignal
): Promise<Result<void>> {
  const normalAdd = () => worktreeAdd(git, repoPath, worktreePath, branch, options);
  if (settings.worktreeReflink !== "on") return normalAdd();

  const before = await listWorktrees(git, repoPath);
  if (!before.ok) return before;
  const destination = await canonicalPath(worktreePath);
  const existed = await lstat(worktreePath).then(
    () => true,
    (cause: NodeJS.ErrnoException) => cause.code !== "ENOENT"
  );
  // Git lists canonical paths. Inspect only this destination, never stat
  // unrelated worktrees that may live on an unavailable volume.
  const registeredBefore = before.value.some((w) => resolve(w.path) === destination);
  // Let Git report a collision. Never give an external command an existing
  // destination that a later rollback might mistake for this attempt's files.
  if (existed || registeredBefore) return normalAdd();

  // Git creates missing parent directories; pwrgit-share probes an existing
  // parent before registering the checkout. Match Git's first-create behavior.
  try {
    await mkdir(dirname(worktreePath), { recursive: true });
  } catch {
    return normalAdd();
  }

  const args = [
    "worktree", "add", "--json", "--donor", repoPath,
    ...(settings.worktreeSeedCargoTarget === "on" ? ["--seed-target"] : []),
    ...(options.newBranch ? ["-b", branch] : []),
    "--", worktreePath,
    ...(options.newBranch ? [options.startPoint ?? "HEAD"] : [branch])
  ];
  let stdout = "";
  let failure: string | undefined;
  try {
    // execFile performs PATH lookup without a shell. An override is one
    // executable, never a shell command or an argument string.
    ({ stdout } = await run(settings.worktreeShareCommand?.trim() || "pwrgit-share", args, {
      cwd: repoPath,
      env: gitLaunch().env,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      ...(signal === undefined ? {} : { signal })
    }));
  } catch (cause) {
    const error = cause as NodeJS.ErrnoException & { stderr?: string };
    if (error.code === "ENOENT" || error.code === "EACCES" || error.code === "ENOEXEC") {
      notice("pwrgit-share is unavailable; using a normal Git checkout.");
      return normalAdd();
    }
    failure = error.stderr?.trim() || error.message;
  }

  const after = await listWorktrees(git, repoPath);
  const created = after.ok
    ? after.value.find((w) => resolve(w.path) === destination)
    : undefined;

  if (failure !== undefined) {
    if (created !== undefined || !after.ok) {
      // Rollback is intentionally not cancellable. Never prune the repo or
      // touch the donor, caches, or registrations present before this attempt.
      const removed = await worktreeRemove(git, repoPath, created?.path ?? worktreePath, {
        force: true,
        ...(after.ok ? { listed: after.value } : {})
      });
      if (!removed.ok) failure += `; cleanup failed: ${removed.error.message}`;
    }
    return err(worktreeAddError(failure));
  }
  if (!after.ok) return err(worktreeAddError(after.error.message));

  let fallback = false;
  try {
    const report: unknown = JSON.parse(stdout);
    fallback = typeof report === "object" && report !== null &&
      "fallback" in report && report.fallback === "git-checkout";
  } catch {
    // The observed Git registration decides whether a second add is needed.
    fallback = true;
  }
  if (fallback || created === undefined) {
    notice("Worktree sharing is unavailable; using a normal Git checkout.");
  }
  // Exit 0's contract is a valid checkout, including fallback: git-checkout.
  return created === undefined ? normalAdd() : ok(undefined);
}
