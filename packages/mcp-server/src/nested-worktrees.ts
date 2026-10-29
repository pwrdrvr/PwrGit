import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Linked worktrees of the same repository that sit inside a checkout, as
 * `git status` pathspec excludes.
 *
 * Agents put their worktrees inside the repository (`.claude/worktrees/<name>`),
 * and `git status` reports each one as an untracked directory: `? .claude/` by
 * default, `? .claude/worktrees/<name>/` with `-uall`. It is another checkout,
 * not content, yet it counted as an uncommitted change, so a "clean" primary
 * showed `●1` and every branch switch asked what to do with it.
 *
 * An exclude pathspec drops just that directory and keeps everything else
 * honest: a real file beside it still collapses the parent into `? .claude/`,
 * and the `# branch.*` headers are unchanged. Independent repositories nested
 * in the tree are not worktrees of this one and still show.
 *
 * Pure filesystem, no Git process: every status call pays for it, so it reads
 * `<cwd>/.git`, then `<common dir>/worktrees/*\/gitdir`, re-listing only when
 * that directory changes. Best-effort: any read failure means "none", which is
 * the old behaviour.
 */
export async function nestedWorktreeExcludes(cwd: string): Promise<string[]> {
  try {
    const root = await realpath(cwd);
    const common = await commonDir(cwd);
    if (common === null) return [];
    const roots = await worktreeRoots(common);
    const excludes: string[] = [];
    for (const path of roots) {
      const rel = insidePath(root, path);
      // Checked on every call, not cached: removing a link does not touch
      // `worktrees/`. A folder whose link is gone is no longer a checkout, and
      // its files are this checkout's untracked content again.
      if (rel !== null && (await hasLink(path))) {
        excludes.push(`:(exclude,top,literal)${rel}`);
      }
    }
    return excludes.sort();
  } catch {
    return [];
  }
}

/** `["--", ...excludes]` when there are any, so a caller can spread it last. */
export async function nestedWorktreePathspec(cwd: string): Promise<string[]> {
  const excludes = await nestedWorktreeExcludes(cwd);
  return excludes.length === 0 ? [] : ["--", ...excludes];
}

async function hasLink(root: string): Promise<boolean> {
  try {
    await stat(join(root, ".git"));
    return true;
  } catch {
    return false;
  }
}

/** `path` relative to `root` with forward slashes, when strictly inside it. */
function insidePath(root: string, path: string): string | null {
  const rel = relative(root, path);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return sep === "/" ? rel : rel.split(sep).join("/");
}

/** The repository's common git dir: `.git` itself for the primary, or the
 *  `commondir` a linked worktree's admin dir points back at. */
async function commonDir(cwd: string): Promise<string | null> {
  const dotGit = join(cwd, ".git");
  const info = await stat(dotGit);
  if (info.isDirectory()) return realpath(dotGit);
  const link = /^gitdir:\s*(.+?)\s*$/m.exec(await readFile(dotGit, "utf8"));
  if (link === null) return null;
  const admin = resolve(cwd, link[1] as string);
  const pointer = (await readFile(join(admin, "commondir"), "utf8")).trim();
  return realpath(resolve(admin, pointer));
}

type Listing = { mtimeMs: number; roots: string[] };
const listings = new Map<string, Listing>();

/** Every linked worktree's root (realpath'd), cached per common dir until
 *  `worktrees/` itself changes — an add or remove renames entries there. */
async function worktreeRoots(common: string): Promise<string[]> {
  const admin = join(common, "worktrees");
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(admin)).mtimeMs;
  } catch {
    return [];
  }
  const cached = listings.get(common);
  if (cached !== undefined && cached.mtimeMs === mtimeMs) return cached.roots;
  const roots: string[] = [];
  for (const name of await readdir(admin)) {
    try {
      const gitdir = (await readFile(join(admin, name, "gitdir"), "utf8")).trim();
      // `gitdir` names the worktree's `.git` link; its folder is the root. A
      // checkout whose folder is gone has nothing to exclude.
      roots.push(await realpath(dirname(resolve(admin, name, gitdir))));
    } catch {
      continue;
    }
  }
  listings.set(common, { mtimeMs, roots });
  return roots;
}
