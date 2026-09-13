// Policy for "reclaim the ignored files" — the gentle half of the pruner.
//
// Shared because main needs the default when a request omits excludes, and the
// dialog needs the same list as the starting value of its editable field. A
// second copy would let the dialog promise a protection main does not apply.

/**
 * Patterns spared by default.
 *
 * `.gitignore` is not a statement that a file is worthless — it is a statement
 * that it is local. Local means unrecoverable: there is no git object behind a
 * `.env`, a SQLite database, or a key, and `git clean` is not an undoable
 * operation. So the default list spares the things whose loss is permanent and
 * whose size is negligible, and leaves the genuinely regenerable bulk
 * (`node_modules`, `target`, `dist`, build caches) to be deleted.
 *
 * These are gitignore-style patterns; one without a slash matches at any
 * depth, which is what we want for all of them. They reach git as **negated**
 * `-e` rules (`-e '!.env*'`) — see `spareArgs` in
 * apps/desktop/src/main/git/worktree-reclaim.ts for why a plain `-e` under
 * `-X` does the opposite of sparing.
 *
 * The user can delete any of these to opt into removing them. Nothing here is
 * enforced below the UI: the list is a default, not a floor.
 */
export const RECLAIM_DEFAULT_EXCLUDES: readonly string[] = [
  // Environment and local configuration (covers .env.local, .envrc, …).
  ".env*",
  // The conventional suffix for "this file is mine": settings.local.json,
  // vite's *.local, terraform's *.auto.tfvars-adjacent conventions.
  "*.local",
  // Local databases — an app's dev data, and the single most common thing a
  // developer is surprised to lose to a clean.
  "*.sqlite",
  "*.sqlite3",
  "*.db",
  // Keys and certificates people generate for local TLS and never commit.
  "*.pem",
  "*.key",
  "*.p12",
  // Editor-local state: small, personal, and gitignored in most repos.
  ".vscode/",
  ".idea/"
];

/** Why an exclude pattern was refused. */
export type ExcludePatternProblem = "empty" | "negation" | "too_long";

export const MAX_EXCLUDE_PATTERN_LENGTH = 200;
export const MAX_EXCLUDE_PATTERNS = 64;

/**
 * Reject a pattern rather than pass it to git.
 *
 * A leading `!` is refused because the negation is ours to add: every pattern
 * here reaches git as `-e '!<pattern>'`, so a user-supplied `!` would produce
 * `!!foo` — which git reads as un-ignoring a file literally named `!foo`, not
 * as anything the user meant. The field means "spare this"; it is not a place
 * to hand-write gitignore precedence.
 */
export function excludePatternProblem(
  pattern: string
): ExcludePatternProblem | null {
  const trimmed = pattern.trim();
  if (trimmed === "") return "empty";
  if (trimmed.startsWith("!")) return "negation";
  if (trimmed.length > MAX_EXCLUDE_PATTERN_LENGTH) return "too_long";
  return null;
}

/**
 * Trim, drop blanks and duplicates, and cap the list. Order is preserved so
 * the user's own list reads back the way they typed it.
 */
export function normalizeExcludes(patterns: readonly string[]): string[] {
  const out: string[] = [];
  for (const pattern of patterns) {
    const trimmed = pattern.trim();
    if (excludePatternProblem(trimmed) !== null) continue;
    if (out.includes(trimmed)) continue;
    out.push(trimmed);
    if (out.length >= MAX_EXCLUDE_PATTERNS) break;
  }
  return out;
}

/** Bytes as a short human string. Shared so the dialog, the confirm, and the
 *  summary all round the same way. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 100 || unit === 0 ? Math.round(value) : Number(value.toFixed(1));
  return `${rounded} ${units[unit]}`;
}
