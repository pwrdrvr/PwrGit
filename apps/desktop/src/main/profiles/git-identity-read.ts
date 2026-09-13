import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { GitIdentityRead } from "@pwrgit/shared";
import type { GitExec } from "../git/dugite";

/**
 * The identity a commit would actually carry, asked of git rather than parsed.
 *
 * `readGitIdentityDefaults` (the first-run *seed*) regexes the first `name =`
 * and the first `email =` anywhere in `~/.gitconfig`. It is not section-aware,
 * so the two can come from different sections — a `[github] name = handle`
 * ahead of `[user]` seeds the forge handle as the commit author — and it does
 * not follow `include`, so an identity kept in an included file reads as empty
 * while `git config --get user.name` answers fine.
 *
 * The seed can live with that: it is documented best-effort and only picks a
 * default nobody is shown. A wizard that puts the value on screen and says
 * "commits will be signed off as this" cannot, so it asks git.
 */
export async function readEffectiveGitIdentity(
  git: GitExec,
  cwd: string = homedir(),
  configPath: string = join(homedir(), ".gitconfig")
): Promise<GitIdentityRead> {
  const [name, email] = await Promise.all([
    readOne(git, cwd, "user.name"),
    readOne(git, cwd, "user.email")
  ]);
  return { name, email, conditionalDirs: conditionalIncludeDirs(configPath) };
}

/** `--get` exits 1 with no output when the key is unset, which is an answer
 *  ("not configured"), not a failure — so a non-zero exit maps to null rather
 *  than an error the wizard would have to render. */
async function readOne(
  git: GitExec,
  cwd: string,
  key: string
): Promise<string | null> {
  const result = await git(["config", "--get", key], cwd);
  if (!result.ok) return null;
  if (result.value.exitCode !== 0) return null;
  const value = result.value.stdout.trim();
  return value === "" ? null : value;
}

/**
 * Directory prefixes a conditional include re-points identity for.
 *
 * Read straight from `~/.gitconfig` because `git config` run outside a repo
 * cannot report them: `includeIf` is evaluated against the repository being
 * operated on, so from the home directory the conditions are simply inert.
 * Only the section headers are parsed — never the included files, which may
 * live anywhere and are none of PwrGit's business.
 *
 * Best-effort by design: an unreadable or absent config is "no conditions",
 * which costs the wizard a caveat it would have shown, not a wrong identity.
 */
function conditionalIncludeDirs(configPath: string): string[] {
  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch {
    return [];
  }
  const dirs: string[] = [];
  const header = /^\s*\[\s*includeIf\s+"gitdir(?:\/i)?:([^"]+)"\s*\]/gim;
  for (const match of text.matchAll(header)) {
    const dir = match[1]?.trim();
    if (dir !== undefined && dir !== "" && !dirs.includes(dir)) dirs.push(dir);
  }
  return dirs;
}
