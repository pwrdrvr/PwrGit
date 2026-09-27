import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
  err,
  ok,
  type GarbageCollectionMode,
  type Result,
  type StaleBranch
} from "@pwrgit/shared";
import { deleteLocalBranch } from "./branch-lifecycle";
import { requireExit0, type GitExec } from "./dugite";
import { checkoutExists } from "./worktree-liveness";

async function output(
  git: GitExec,
  cwd: string,
  args: string[]
): Promise<Result<string>> {
  const raw = await git(args, cwd);
  if (!raw.ok) return raw;
  const checked = requireExit0(raw.value, args);
  return checked.ok ? ok(checked.value.stdout) : checked;
}

/** Resolve aliases and linked worktrees to one object store, without walking
 * up into a parent repository if a discovered checkout has disappeared. */
export async function maintenanceCommonDirectory(
  git: GitExec,
  cwd: string
): Promise<Result<string>> {
  if (!checkoutExists(cwd)) {
    return err({
      kind: "repo",
      code: "worktree_missing",
      message:
        "The repository checkout is missing. Restore its folder before running maintenance."
    });
  }
  const common = await output(git, cwd, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir"
  ]);
  if (!common.ok) return common;
  return ok(await realpath(resolve(cwd, common.value.trim())));
}

/** count-objects reports KiB of loose objects and packs, not volume free space. */
export async function objectStorageBytes(
  git: GitExec,
  cwd: string
): Promise<number | undefined> {
  const counted = await output(git, cwd, ["count-objects", "-v"]);
  if (!counted.ok) return undefined;
  const values = new Map(
    counted.value
      .trim()
      .split(/\r?\n/)
      .map((line) => {
        const [key, value] = line.split(": ");
        return [key, Number(value)] as const;
      })
  );
  const loose = values.get("size");
  const packs = values.get("size-pack");
  return loose !== undefined &&
    packs !== undefined &&
    Number.isFinite(loose + packs)
    ? (loose + packs) * 1024
    : undefined;
}

export function garbageCollectionArgs(mode: GarbageCollectionMode): string[] {
  // Missing worktrees may be on unmounted volumes. GC must not expire their
  // registration. Foreground execution keeps completion tied to Git's exit.
  return [
    "-c",
    "gc.worktreePruneExpire=never",
    "gc",
    "--no-detach",
    ...(mode === "aggressive"
      ? ["--aggressive"]
      : mode === "keep-largest"
        ? ["--keep-largest-pack"]
        : [])
  ];
}

export async function collectGarbage(
  git: GitExec,
  cwd: string,
  mode: GarbageCollectionMode
): Promise<Result<void>> {
  const result = await output(git, cwd, garbageCollectionArgs(mode));
  return result.ok ? ok(undefined) : result;
}

/** Conservative local-only review. An upstream must be a missing remote ref,
 * the tip must be reachable from this checkout's HEAD, and no worktree may
 * hold the branch. No translated '[gone]' strings or forge guesses. */
export async function scanStaleBranches(
  git: GitExec,
  cwd: string,
  repoId: string
): Promise<Result<StaleBranch[]>> {
  const refs = await output(git, cwd, [
    "for-each-ref",
    "--format=%(refname)%09%(objectname)%09%(upstream)%09%(worktreepath)%09%(upstream:remotename)",
    "refs/heads/",
    "refs/remotes/"
  ]);
  if (!refs.ok) return refs;
  const rows = refs.value
    .trimEnd()
    .split(/\r?\n/)
    .map((line) => line.split("\t"));
  if (!rows.some((row) => row[0]?.startsWith("refs/heads/"))) return ok([]);
  const merged = await output(git, cwd, [
    "for-each-ref",
    "--merged=HEAD",
    "--format=%(refname)",
    "refs/heads/"
  ]);
  if (!merged.ok) return merged;
  const remotes = await output(git, cwd, ["remote"]);
  if (!remotes.ok) return remotes;
  const remoteNames = new Set(
    remotes.value.trim().split(/\r?\n/).filter(Boolean)
  );
  const names = new Set(rows.map((row) => row[0]));
  const mergedRefs = new Set(merged.value.trim().split(/\r?\n/));
  const protectedNames = new Set([
    "main",
    "master",
    "trunk",
    "develop",
    "development"
  ]);
  for (const remote of remoteNames) {
    // for-each-ref omits a dangling remote HEAD after fetch pruning. Read
    // the symbolic target directly so its default branch stays protected.
    const args = ["symbolic-ref", "--quiet", `refs/remotes/${remote}/HEAD`];
    const raw = await git(args, cwd);
    if (!raw.ok) return raw;
    // Exit 1 means there is no symbolic HEAD configured for this remote.
    if (raw.value.exitCode === 1) continue;
    const checked = requireExit0(raw.value, args);
    if (!checked.ok) return checked;
    const symbolic = checked.value.stdout.trim();
    for (const owner of remoteNames) {
      if (symbolic.startsWith(`refs/remotes/${owner}/`)) {
        protectedNames.add(symbolic.slice(`refs/remotes/${owner}/`.length));
      }
    }
  }
  const candidates: StaleBranch[] = [];
  for (const [
    ref = "",
    head = "",
    upstream = "",
    worktree = "",
    remote = ""
  ] of rows) {
    if (!ref.startsWith("refs/heads/")) continue;
    const branch = ref.slice("refs/heads/".length);
    if (protectedNames.has(branch) || worktree !== "" || !mergedRefs.has(ref))
      continue;
    if (
      !upstream.startsWith("refs/remotes/") ||
      names.has(upstream) ||
      !remoteNames.has(remote)
    )
      continue;
    candidates.push({ repoId, branch, expectedHead: head, upstream });
  }
  return ok(candidates);
}

/** Recheck eligibility and the reviewed tip; reuse the ordinary non-force
 * deletion path, including its worktree/operation guards and Git merge check. */
export async function deleteStaleBranch(
  git: GitExec,
  cwd: string,
  candidate: StaleBranch
): Promise<Result<void>> {
  const fresh = await scanStaleBranches(git, cwd, candidate.repoId);
  if (!fresh.ok) return fresh;
  if (
    !fresh.value.some(
      (branch) =>
        branch.branch === candidate.branch &&
        branch.expectedHead === candidate.expectedHead &&
        branch.upstream === candidate.upstream
    )
  ) {
    return err({
      kind: "repo",
      code: "stale_branch_review",
      message:
        "The branch changed or is no longer eligible. Review it again; nothing was deleted."
    });
  }
  return deleteLocalBranch(git, cwd, candidate, false);
}
