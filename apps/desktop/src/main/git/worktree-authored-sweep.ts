import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { checkoutCommonGitDir, checkoutGitDirs } from "@pwrgit/mcp-server/nested-worktrees";
import { NO_OPTIONAL_LOCKS, type GitExec } from "./dugite";

type ColdTips = {
  commonDir: string;
  packedRefs: string | null;
  tips: ReadonlyMap<string, { ref: string; oid: string; packed: boolean }>;
};

async function packedRefsVersion(commonDir: string): Promise<string | null> {
  try {
    const file = await stat(join(commonDir, "packed-refs"), { bigint: true });
    return file.isFile() ? `${file.dev}:${file.ino}:${file.size}:${file.mtimeNs}:${file.ctimeNs}` : null;
  } catch {
    return null;
  }
}

/**
 * `git log --since` prunes an old tip before walking any of its parents.
 * Get that negative answer from one ref query for the attached worktrees
 * whose live branch Git can identify. A recent tip still needs the ordinary
 * checkout-local history and identity reads.
 */
export async function readColdAuthoredTips(
  git: GitExec, repoPath: string, branches: ReadonlySet<string>, sinceMs: number
): Promise<ColdTips | null> {
  if ([
    "GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_NAMESPACE",
    "GIT_REPLACE_REF_BASE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"
  ].some((key) => process.env[key] !== undefined)) return null;
  const commonDir = await checkoutCommonGitDir(repoPath);
  if (commonDir === null) return null;
  const packedRefs = await packedRefsVersion(commonDir);
  const result = await git([
    "for-each-ref", "--stdin",
    "--format=%(refname)%00%(worktreepath)%00%(committerdate:unix)%00%(symref)%00%(objectname)%00%(flag)%00"
  ], repoPath, {
    env: { ...NO_OPTIONAL_LOCKS.env, GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1" },
    input: [...branches, "refs/replace", ""].join("\n")
  });
  if (!result.ok || result.value.exitCode !== 0) return null;

  const cutoff = Math.floor(sinceMs / 1000);
  const tips = new Map<string, { ref: string; oid: string; packed: boolean }>();
  for (const line of result.value.stdout.split(/\0\r?\n/)) {
    if (line === "") continue;
    const fields = line.split("\0");
    if (fields.length !== 6) return null;
    const [ref, path, date, symbolic, oid, flags] = fields;
    // Worktree-specific config can choose whether to honor replacement refs.
    if (ref?.startsWith("refs/replace/")) return null;
    if (ref === undefined || !branches.has(ref) || !path || !oid || symbolic !== "" ||
        date === undefined || !/^\d+$/.test(date)) continue;
    if (Number(date) < cutoff) {
      tips.set(resolve(path), { ref, oid, packed: flags?.split(",").includes("packed") === true });
    }
  }
  return { commonDir, packedRefs, tips };
}

/** Recheck the checkout and ref before using the batch. A switch, commit,
 * reftable backend or unreadable file sends the row through Git. */
export async function stillColdAuthoredTip(path: string, snapshot: ColdTips | null): Promise<boolean> {
  const tip = snapshot?.tips.get(resolve(path));
  if (snapshot === null || tip === undefined) return false;
  const dirs = await checkoutGitDirs(path);
  if (dirs?.commonDir !== snapshot.commonDir) return false;
  try {
    const head = await readFile(join(dirs.gitDir, "HEAD"), "utf8");
    if (head.trimEnd() !== `ref: ${tip.ref}`) return false;
    try {
      return (await readFile(join(dirs.commonDir, tip.ref), "utf8")).trimEnd() === tip.oid;
    } catch (cause) {
      return (cause as NodeJS.ErrnoException).code === "ENOENT" && tip.packed && snapshot.packedRefs !== null &&
        await packedRefsVersion(dirs.commonDir) === snapshot.packedRefs;
    }
  } catch {
    return false;
  }
}
