/**
 * Writing entries into a worktree's root `.gitignore`.
 *
 * Kept as pure string work with one thin filesystem wrapper: turning a path
 * into a *correct* ignore pattern is the fiddly part, and it is all about
 * characters that mean something to git and nothing to the user who right-
 * clicked a file called `report [final].pdf`.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { err, ok, type Result } from "@pwrgit/shared";

/**
 * Turn a repo-relative path into a `.gitignore` line.
 *
 * Two things have to be right. **Anchoring**: a pattern with no slash in it
 * matches that name at any depth, so ignoring the file `notes.md` would also
 * ignore `src/notes.md`. A leading `/` pins the pattern to the directory
 * holding the .gitignore, which is the worktree root here. **Escaping**: `*`,
 * `?` and `[…]` are glob syntax, and a trailing space is stripped unless
 * escaped — all of them legal in a filename, so a literal path must escape
 * them or the line quietly matches more than the user pointed at.
 */
export function toGitignorePattern(
  repoRelativePath: string,
  options: { directory?: boolean } = {}
): string {
  const escaped = repoRelativePath
    .replace(/[\\*?[\]]/g, (char) => `\\${char}`)
    // Only a trailing space needs escaping; interior spaces are literal.
    .replace(/ $/, "\\ ");
  // The leading "/" also defuses `#` and `!`, which are only a comment marker
  // and a negation at the very start of a line.
  return `/${escaped}${options.directory === true ? "/" : ""}`;
}

/**
 * Splice patterns into existing `.gitignore` text, skipping any already there.
 * Returns the new text and the patterns actually added, so a caller can say
 * "already ignored" instead of reporting work it did not do.
 */
export function addPatterns(
  existing: string,
  patterns: string[]
): { text: string; added: string[] } {
  const present = new Set(
    existing.split("\n").map((line) => line.trim()).filter((line) => line !== "")
  );
  const added: string[] = [];
  for (const pattern of patterns) {
    if (present.has(pattern)) continue;
    present.add(pattern);
    added.push(pattern);
  }
  if (added.length === 0) return { text: existing, added };

  // A file that does not end in a newline would otherwise glue the first new
  // pattern onto the last existing one, silently changing that pattern too.
  const separator = existing === "" || existing.endsWith("\n") ? "" : "\n";
  return { text: `${existing}${separator}${added.join("\n")}\n`, added };
}

export type GitignoreWrite = { added: string[]; gitignorePath: string };

/** Append patterns to `<cwd>/.gitignore`, creating the file when absent. */
export function appendToGitignore(
  cwd: string,
  patterns: string[]
): Result<GitignoreWrite> {
  const gitignorePath = join(cwd, ".gitignore");
  let existing = "";
  try {
    existing = readFileSync(gitignorePath, "utf8");
  } catch (cause) {
    // Absent is the normal first-use case; anything else is a real failure and
    // must not be papered over by writing a fresh file on top of it.
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
      return err({
        kind: "persistence",
        code: "read_failed",
        message: `Could not read ${gitignorePath}: ${(cause as Error).message}`
      });
    }
  }

  const { text, added } = addPatterns(existing, patterns);
  if (added.length === 0) return ok({ added, gitignorePath });

  try {
    writeFileSync(gitignorePath, text, "utf8");
  } catch (cause) {
    return err({
      kind: "persistence",
      code: "write_failed",
      message: `Could not write ${gitignorePath}: ${(cause as Error).message}`
    });
  }
  return ok({ added, gitignorePath });
}
