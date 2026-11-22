import { access } from "node:fs/promises";
import { join } from "node:path";
import { checkoutCommonGitDir } from "@pwrgit/mcp-server/nested-worktrees";
import { NO_OPTIONAL_LOCKS, type GitExec } from "./dugite";

export type DefaultComparison = {
  behindDefault: number;
  mergedIntoDefault: boolean;
  divergedFromDefault: boolean;
  lastActivityAt: string;
};

export type DefaultComparisons = {
  commonDir: string;
  base: string;
  byHead: Map<string, DefaultComparison>;
};

const existsOrUnreadable = (path: string): Promise<boolean> =>
  access(path).then(() => true, (cause: NodeJS.ErrnoException) => cause.code !== "ENOENT");

const localOnly = { env: { ...NO_OPTIONAL_LOCKS.env, GIT_NO_LAZY_FETCH: "1" } };

/** Batch comparisons against one pinned default commit. Git does the graph
 * walk. Shallow history, grafts, replacements and unusual Git discovery keep
 * the checkout-local queries since they can change reachability. */
export async function readDefaultComparisons(
  git: GitExec, path: string, defaultRef: string, base: string, branches: string[]
): Promise<DefaultComparisons | null> {
  if ([
    "GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_NAMESPACE",
    "GIT_SHALLOW_FILE", "GIT_GRAFT_FILE", "GIT_REPLACE_REF_BASE",
    "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"
  ].some((key) => process.env[key] !== undefined)) return null;
  const commonDir = await checkoutCommonGitDir(path);
  if (commonDir === null) return null;
  const [shallow, grafts] = await Promise.all([
    existsOrUnreadable(join(commonDir, "shallow")),
    existsOrUnreadable(join(commonDir, "info", "grafts"))
  ]);
  if (shallow || grafts) return null;

  const [refs, count] = await Promise.all([
    git([
      "for-each-ref", "--stdin",
      `--format=%(refname)%00%(objectname)%00%(ahead-behind:${base})%00%(committerdate:iso8601-strict)`
    ], path, { ...localOnly, input: [...branches, "refs/replace", ""].join("\n") }),
    git(["rev-list", "--count", base], path, localOnly)
  ]);
  if (!refs.ok || refs.value.exitCode !== 0 || !count.ok || count.value.exitCode !== 0) return null;
  const reachable = Number(count.value.stdout.trim());
  if (!Number.isSafeInteger(reachable) || reachable <= 0) return null;

  const byHead = new Map<string, DefaultComparison>();
  for (const line of refs.value.stdout.trimEnd().split("\n")) {
    const [name, head, pair, date] = line.split("\0");
    if (name?.startsWith("refs/replace/")) return null;
    if (head === undefined || pair === undefined || date === undefined) continue;
    const match = /^(\d+) (\d+)$/.exec(pair);
    if (match === null) continue;
    const ahead = Number(match[1]);
    const behind = Number(match[2]);
    if (!Number.isSafeInteger(ahead) || !Number.isSafeInteger(behind) || behind > reachable) continue;
    // D minus H contains all of D iff their reachable sets are disjoint.
    // H minus D is empty iff H itself is reachable from D.
    const divergedFromDefault = behind === reachable;
    byHead.set(head, {
      behindDefault: divergedFromDefault ? 0 : behind,
      mergedIntoDefault: ahead === 0,
      divergedFromDefault,
      lastActivityAt: date.trim()
    });
  }
  // The legacy per-checkout walks use the short default ref. Verify its exact
  // meaning after the batch, in case it was shadowed or moved during the read.
  const [shorthand, replacements, nowShallow, nowGrafts] = await Promise.all([
    git(["rev-parse", "--verify", "--quiet", `${defaultRef}^{commit}`], path, localOnly),
    git(["for-each-ref", "--format=%(refname)", "refs/replace"], path, localOnly),
    existsOrUnreadable(join(commonDir, "shallow")),
    existsOrUnreadable(join(commonDir, "info", "grafts"))
  ]);
  if (!shorthand.ok || shorthand.value.exitCode !== 0 || shorthand.value.stdout.trim() !== base ||
    !replacements.ok || replacements.value.exitCode !== 0 || replacements.value.stdout.trim() !== "" ||
    nowShallow || nowGrafts) return null;
  return { commonDir, base, byHead };
}
