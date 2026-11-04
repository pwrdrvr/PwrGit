import { access, stat } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { logMain } from "../logs";
import type { GitExec } from "./dugite";
import type { WorktreeInfo } from "./git-service";

/**
 * Where removable and network volumes mount. A worktree under one of these
 * whose volume is not attached right now is waiting for a drive, not deleted.
 */
const MOUNT_CONTAINERS = ["/Volumes", "/media", "/run/media", "/mnt"];

export type VolumeFs = {
  exists: (path: string) => Promise<boolean>;
  /** Device id of a path, or null when it cannot be read. */
  device: (path: string) => Promise<number | null>;
};

const nodeVolumeFs: VolumeFs = {
  exists: async (path) => {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  },
  device: async (path) => {
    try {
      return (await stat(path)).dev;
    } catch {
      return null;
    }
  }
};

/**
 * Whether a path sits on a volume that is not attached right now: a drive
 * letter that is gone on Windows, or nothing mounted between a mount
 * container (`/Volumes`, `/media`, …) and the path. An empty mount-point
 * directory left behind by an unmount is not a mount — its device is its
 * parent's — so it reads as detached too. Anything outside those containers
 * is on a fixed disk, where a missing folder was deleted.
 */
export async function onDetachedVolume(
  path: string,
  platform: NodeJS.Platform = process.platform,
  fs: VolumeFs = nodeVolumeFs
): Promise<boolean> {
  if (platform === "win32") {
    const root = win32.parse(path).root;
    return root !== "" && !(await fs.exists(root));
  }
  const container = MOUNT_CONTAINERS.find((c) => path.startsWith(`${c}/`));
  if (container === undefined) return false;
  for (let dir = path; dir.length > container.length; dir = posix.dirname(dir)) {
    const own = await fs.device(dir);
    if (own === null) continue;
    const parent = await fs.device(posix.dirname(dir));
    if (parent !== null && own !== parent) return false;
  }
  return true;
}

/**
 * Drop git's record of every linked worktree whose folder is gone, and return
 * the listing without them.
 *
 * Agents delete their checkouts without `git worktree remove` (Codex cleans up
 * `~/.codex/worktrees/…`), and git keeps listing the entry. Keeping it costs
 * more than a stale sidebar row: git refuses to check the branch out anywhere
 * else ("already used by worktree at …"). So each such entry gets the
 * per-entry `git worktree remove --force` — never the repo-wide `prune`.
 *
 * Kept, and flagged missing by the caller instead:
 * - the primary checkout (only a rescan drops a repository);
 * - a locked worktree — `git worktree lock` is git's "do not touch";
 * - a folder that still exists but lost its `.git` link — its files are there;
 * - a folder on a volume that is not attached (`onDetachedVolume`);
 * - a detached HEAD no ref contains — git's record is the last thing pointing
 *   at those commits, so dropping it is for the user to decide (Remove);
 * - any entry git declined to remove, so the user still sees it.
 */
export async function forgetVanishedWorktrees(
  git: GitExec,
  repoPath: string,
  listed: WorktreeInfo[],
  fs: VolumeFs = nodeVolumeFs,
  platform: NodeJS.Platform = process.platform,
  now: () => number = Date.now
): Promise<WorktreeInfo[]> {
  const kept: WorktreeInfo[] = [];
  for (const [index, w] of listed.entries()) {
    const key = `${repoPath}\n${w.path}`;
    const declinedAt = declined.get(key);
    if (
      index === 0 ||
      w.bare ||
      !w.prunable ||
      w.locked ||
      (declinedAt !== undefined && now() - declinedAt < DECLINED_RETRY_MS) ||
      (await fs.exists(w.path)) ||
      (await onDetachedVolume(w.path, platform, fs)) ||
      (w.detached && !(await headIsReachable(git, repoPath, w.head)))
    ) {
      kept.push(w);
      continue;
    }
    const raw = await git(["worktree", "remove", "--force", w.path], repoPath);
    const stderr = raw.ok ? raw.value.stderr.trim() : raw.error.message;
    // Another index pass of this repo forgot it first: gone either way.
    if ((raw.ok && raw.value.exitCode === 0) || /is not a working tree/i.test(stderr)) {
      declined.delete(key);
      logMain("info", "worktree", `forgot ${w.path}: its folder is gone`);
      continue;
    }
    // Every refresh of the repo lands here; ask git again only after a while,
    // so a refusal costs one spawn and one log line per window, not per pass.
    declined.set(key, now());
    logMain("warn", "worktree", `could not forget ${w.path}, whose folder is gone:`, stderr);
    kept.push(w);
  }
  return kept;
}

/** Entries git refused to remove, by `<repo>\n<path>`, with when it refused. */
const declined = new Map<string, number>();
const DECLINED_RETRY_MS = 10 * 60_000;

/** Whether some branch, remote-tracking ref or tag contains a commit. */
async function headIsReachable(
  git: GitExec,
  repoPath: string,
  head: string
): Promise<boolean> {
  if (!/^[0-9a-f]{7,64}$/i.test(head)) return false;
  const raw = await git(
    ["for-each-ref", "--count=1", "--format=%(refname)", "--contains", head],
    repoPath
  );
  return raw.ok && raw.value.exitCode === 0 && raw.value.stdout.trim() !== "";
}

/**
 * Ask for a repo re-index when a probe finds a linked worktree's folder gone,
 * at most once per worktree per cooldown. The re-index is what drops git's
 * record and the row; a worktree it keeps (a detached volume, a lock) stays
 * flagged, and the 15s poll would otherwise re-index its repo every time it
 * looked.
 *
 * One re-index per repo at a time: several worktrees of one repo usually go
 * together (an agent cleaning up), and concurrent passes would race on the
 * same `git worktree remove`. An ask that lands while its repo is being
 * re-indexed queues one more pass, since the running one may have listed
 * the worktrees before this folder went.
 */
export function createVanishedWorktreeRefresh({
  refresh,
  now = Date.now,
  cooldownMs = VANISHED_WORKTREE_REFRESH_COOLDOWN_MS
}: {
  refresh: (repoId: string) => Promise<void>;
  now?: () => number;
  cooldownMs?: number;
}): (worktreeId: string, repoId: string) => void {
  const asked = new Map<string, number>();
  /** Repos being re-indexed, and whether another pass was asked for. */
  const running = new Map<string, { again: boolean }>();
  const run = (repoId: string): void => {
    const state = { again: false };
    running.set(repoId, state);
    void refresh(repoId)
      .catch(() => {})
      .finally(() => {
        running.delete(repoId);
        if (state.again) run(repoId);
      });
  };
  return (worktreeId, repoId) => {
    const at = now();
    const last = asked.get(worktreeId);
    if (last !== undefined && at - last < cooldownMs) return;
    // Forget expired asks so a long session does not keep every id ever seen.
    for (const [id, when] of asked) {
      if (at - when >= cooldownMs) asked.delete(id);
    }
    asked.set(worktreeId, at);
    const inFlight = running.get(repoId);
    if (inFlight !== undefined) inFlight.again = true;
    else run(repoId);
  };
}

export const VANISHED_WORKTREE_REFRESH_COOLDOWN_MS = 10 * 60_000;
