import {
  closeSync, existsSync, lstatSync, openSync, readFileSync,
  renameSync, unlinkSync, writeFileSync
} from "node:fs";
import { join } from "node:path";
import { err, ok, type Result } from "@pwrgit/shared";
import { logMain } from "../logs";
import { requireExit0, type GitExec } from "./dugite";

const refused = (code: string, message: string) =>
  err({ kind: "repo" as const, code, message });

/**
 * files-backend.c takes refs/stash.lock for both ref and reflog mutations.
 * Hold the same lock from identity validation through optional apply and
 * removal. The packed-refs lock prevents a concurrent pack from resurrecting
 * the last entry. Unsupported layouts are refused before any checkout changes.
 */
export async function removeStashByHash(
  git: GitExec,
  cwd: string,
  hash: string,
  beforeRemove?: () => Promise<Result<void>>
): Promise<Result<void>> {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(hash)) {
    return refused("invalid_stash", "Choose a stash by its full commit hash.");
  }
  const args = ["rev-parse", "--path-format=absolute", "--git-common-dir", "--show-ref-format"];
  const raw = await git(args, cwd);
  if (!raw.ok) return raw;
  const checked = requireExit0(raw.value, args);
  if (!checked.ok) return checked;
  const [common, format] = checked.value.stdout.trim().split(/\r?\n/);
  if (!common || format !== "files") {
    return refused("unsupported_stash_storage", "Use Git to remove stashes in this repository's ref storage format. Apply remains available.");
  }
  const ref = join(common, "refs", "stash");
  const log = join(common, "logs", "refs", "stash");
  const packed = join(common, "packed-refs");
  const owned = new Set<string>();
  // Once Pop's apply has run, a failure to remove the entry must not read as
  // "nothing happened": the work is already in the worktree.
  let applied = false;
  const lock = (path: string) => {
    const fd = openSync(path, "wx");
    owned.add(path);
    closeSync(fd);
  };
  try {
    lock(ref + ".lock");
    lock(packed + ".lock");
    lock(log + ".lock");
    if (
      !existsSync(ref) || !existsSync(log) ||
      !lstatSync(ref).isFile() || !lstatSync(log).isFile() ||
      (existsSync(packed) && / refs\/stash(?:\r?\n|$)/.test(readFileSync(packed, "utf8")))
    ) {
      return refused("unsupported_stash_storage", "The stash uses an unsupported or changed ref layout. Refresh, or use Git to remove it. Apply remains available.");
    }
    const bytes = readFileSync(log);
    const original = bytes.toString("utf8");
    if (!Buffer.from(original, "utf8").equals(bytes)) {
      return refused("unsupported_stash_storage", "Use Git to remove entries from this non-UTF-8 stash log.");
    }
    const lines = original.split("\n");
    if (lines.pop() !== "") throw new Error("Incomplete stash reflog");
    const parsed = lines.map((line) => {
      const match = /^([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) (.+)$/.exec(line);
      if (!match || match[1]!.length !== hash.length || match[2]!.length !== hash.length) {
        throw new Error("Unrecognized stash reflog");
      }
      return { hash: match[2]!, suffix: match[3]! };
    });
    const matches = parsed.filter((entry) => entry.hash === hash);
    if (matches.length !== 1) {
      return refused(matches.length ? "ambiguous_stash" : "not_found",
        "The selected stash disappeared or has duplicate occurrences. Refresh before removing it.");
    }
    if (readFileSync(ref, "utf8").trim() !== parsed.at(-1)?.hash) {
      return refused("stash_changed", "The stash ref and log disagree. Use Git to inspect the stack before removing entries.");
    }
    const remaining = parsed.filter((entry) => entry.hash !== hash);
    let previous = "0".repeat(hash.length);
    const rewritten = remaining.map((entry) => {
      const line = previous + " " + entry.hash + " " + entry.suffix + "\n";
      previous = entry.hash;
      return line;
    }).join("");
    // Stage both files before applying; a permission/disk error must not
    // restore work and only then discover that removal cannot be prepared.
    writeFileSync(log + ".lock", rewritten);
    writeFileSync(ref + ".lock", previous + "\n");
    if (beforeRemove) {
      const restored = await beforeRemove();
      if (!restored.ok) return restored;
      applied = true;
    }
    renameSync(log + ".lock", log);
    owned.delete(log + ".lock");
    try {
      if (remaining.length) {
        renameSync(ref + ".lock", ref);
        owned.delete(ref + ".lock");
      } else {
        unlinkSync(ref);
      }
    } catch (cause) {
      // Ref commit failed: restore the original stack while still locked.
      lock(log + ".lock");
      writeFileSync(log + ".lock", original);
      renameSync(log + ".lock", log);
      owned.delete(log + ".lock");
      throw cause;
    }
    return ok(undefined);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return applied
      ? refused("stash_applied_not_removed",
        "The stash was applied here, but it could not be removed from the stack, so it is still listed. Check the worktree, then drop it rather than popping it again. " + detail)
      : refused("stash_removal_failed",
        "Could not safely remove the stash. It may be locked by another Git process. Refresh and inspect the worktree before retrying. " + detail);
  } finally {
    // Never delete a lock belonging to another process. Try every one we own:
    // a lock left behind blocks every later Git stash command.
    for (const path of owned) {
      try {
        unlinkSync(path);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
          logMain("warn", "stash", `could not remove ${path}:`, cause);
        }
      }
    }
  }
}
