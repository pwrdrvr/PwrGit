import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Reject a path that escapes the worktree before it reaches the filesystem.
 *
 * Shared by every main-process channel that turns a renderer-supplied Git path
 * into a real file read. Keeping one copy matters: the containment rules here
 * are subtle enough that a second implementation would drift.
 *
 * Git always reports forward-slash paths, so the input is split on `/` rather
 * than trusting the platform separator — see the AGENTS.md note in this
 * directory. The *result* of `relative()` is a filesystem path, which is why
 * the escape check uses `sep`.
 */
export function insideWorktree(cwd: string, gitPath: string): string | null {
  // Git never emits an absolute path; one arriving here is not something to
  // reinterpret as relative.
  if (isAbsolute(gitPath)) return null;
  const root = resolve(cwd);
  const full = resolve(root, ...gitPath.split("/"));
  const rel = relative(root, full);
  // Only a leading `..` SEGMENT escapes — a plain `startsWith("..")` would
  // also reject a file that merely begins with two dots (`..cover.png`).
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) return null;
  return full;
}
