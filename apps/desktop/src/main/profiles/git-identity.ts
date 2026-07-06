import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type GitIdentityDefaults = { name?: string; email?: string };

/**
 * Best-effort read of the user's global git identity (~/.gitconfig) to seed
 * the first-run default profile. Parses the ini directly — no git shell — so
 * it stays cheap and dependency-free. Returns empty when unreadable.
 */
export function readGitIdentityDefaults(
  configPath: string = join(homedir(), ".gitconfig")
): GitIdentityDefaults {
  try {
    const text = readFileSync(configPath, "utf8");
    const out: GitIdentityDefaults = {};
    const name = /^\s*name\s*=\s*(.+?)\s*$/m.exec(text)?.[1];
    const email = /^\s*email\s*=\s*(.+?)\s*$/m.exec(text)?.[1];
    if (name) out.name = name;
    if (email) out.email = email;
    return out;
  } catch {
    return {};
  }
}
