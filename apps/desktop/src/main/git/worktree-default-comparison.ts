import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { checkoutCommonGitDir } from "@pwrgit/mcp-server/nested-worktrees";
import { NO_OPTIONAL_LOCKS, type GitExec } from "./dugite";

export type DefaultComparison = {
  behindDefault: number;
  mergedIntoDefault: boolean;
  divergedFromDefault: boolean;
  lastActivityAt: string;
};

type DefaultComparisonBase = {
  commonDir: string;
  base: string;
  shallowBoundary: string | undefined;
};

export type DefaultComparisons = DefaultComparisonBase & {
  byHead: Map<string, DefaultComparison>;
};

const DEFAULT_COUNT_LIMIT = 2048;

const existsOrUnreadable = (path: string): Promise<boolean> =>
  access(path).then(() => true, (cause: NodeJS.ErrnoException) => cause.code !== "ENOENT");

const localOnly = { env: { ...NO_OPTIONAL_LOCKS.env, GIT_NO_LAZY_FETCH: "1" } };

/** The common shallow boundary determines the parent edges Git can walk. */
function readShallowBoundary(commonDir: string): Promise<string | undefined | null> {
  return readFile(join(commonDir, "shallow"), "utf8").catch(
    (cause: NodeJS.ErrnoException) => cause.code === "ENOENT" ? undefined : null
  );
}

/** Check the default in this checkout, where a private ref can shadow it.
 * Extra OIDs from the glob mean that replacement refs may change the graph. */
export async function defaultComparisonApplies(
  git: GitExec, path: string, defaultRef: string, snapshot: DefaultComparisonBase
): Promise<boolean> {
  const [revision, shallowBoundary, grafts] = await Promise.all([
    git([
      "rev-parse", "--revs-only", "--glob=refs/replace/*", `${defaultRef}^{commit}`, "--"
    ], path, localOnly),
    readShallowBoundary(snapshot.commonDir),
    existsOrUnreadable(join(snapshot.commonDir, "info", "grafts"))
  ]);
  return revision.ok && revision.value.exitCode === 0 &&
    revision.value.stdout.trim() === snapshot.base && shallowBoundary === snapshot.shallowBoundary && !grafts;
}

/** Batch comparisons against one pinned default commit. Git does the graph
 * walk, including the checkout family's shared shallow boundary. Grafts,
 * replacements and unusual Git discovery keep the checkout-local queries. */
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
  const [shallowBoundary, grafts] = await Promise.all([
    readShallowBoundary(commonDir),
    existsOrUnreadable(join(commonDir, "info", "grafts"))
  ]);
  if (shallowBoundary === null || grafts) return null;

  const refs = await git([
    "for-each-ref", "--stdin",
    `--format=%(refname)%00%(objectname)%00%(ahead-behind:${base})%00%(committerdate:iso8601-strict)`
  ], path, { ...localOnly, input: [...branches, "refs/replace", ""].join("\n") });
  if (!refs.ok || refs.value.exitCode !== 0) return null;

  const pairs: Array<{ head: string; ahead: number; behind: number; date: string }> = [];
  for (const line of refs.value.stdout.trimEnd().split("\n")) {
    const [name, head, pair, date] = line.split("\0");
    if (name?.startsWith("refs/replace/")) return null;
    if (head === undefined || pair === undefined || date === undefined) continue;
    const match = /^(\d+) (\d+)$/.exec(pair);
    if (match === null) continue;
    const ahead = Number(match[1]);
    const behind = Number(match[2]);
    if (!Number.isSafeInteger(ahead) || !Number.isSafeInteger(behind)) continue;
    pairs.push({ head, ahead, behind, date });
  }

  // A tip with zero on either side is already known to share ancestry.
  // For the other tips, counting one more commit than their behind value is
  // sufficient to show that the default has something in common with them.
  const maxBehind = pairs.reduce((max, { ahead, behind }) =>
    ahead > 0 && behind < DEFAULT_COUNT_LIMIT ? Math.max(max, behind) : max, 0);
  let reachable = 0;
  if (maxBehind > 0) {
    const count = await git(["rev-list", "--count", `--max-count=${maxBehind + 1}`, base], path, localOnly);
    if (!count.ok || count.value.exitCode !== 0) return null;
    reachable = Number(count.value.stdout.trim());
    if (!Number.isSafeInteger(reachable) || reachable <= 0 || reachable > maxBehind + 1) return null;
  }

  const byHead = new Map<string, DefaultComparison>();
  for (const { head, ahead, behind, date } of pairs) {
    const needsCount = ahead > 0 && behind > 0;
    // Use the checkout-local merge base when the bounded count cannot decide.
    if (needsCount && (behind >= DEFAULT_COUNT_LIMIT || behind > reachable)) continue;
    const divergedFromDefault = needsCount && behind === reachable;
    byHead.set(head, {
      behindDefault: divergedFromDefault ? 0 : behind,
      mergedIntoDefault: ahead === 0,
      divergedFromDefault,
      lastActivityAt: date.trim()
    });
  }
  const snapshot = { commonDir, base, shallowBoundary, byHead };
  return await defaultComparisonApplies(git, path, defaultRef, snapshot) ? snapshot : null;
}
