/**
 * A forge account login as PwrGit will store and pass to a CLI.
 *
 * The value reaches `gh auth token --user <login>` as its own argv entry, so
 * the shape is what keeps it an operand: it never starts with `-` (which `gh`
 * would parse as a flag) and it holds no whitespace, slash or control
 * character. GitHub logins are alphanumerics and hyphens; Enterprise Managed
 * Users add an `_shortcode` suffix, and some Enterprise Server installs allow
 * dots, so those are accepted too. 100 characters is far past any real login.
 */
const FORGE_ACCOUNT_LOGIN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/**
 * The stored account for a host, or null when the input names none.
 *
 * Null is the signal to CLEAR the pin and follow the CLI's active account —
 * the empty string reaches here for exactly that reason, as it does for a
 * host's label. A value read from settings.json is unvalidated, so the read
 * path calls this too: a hand-edited `"--hostname"` must pin nothing rather
 * than become a flag.
 */
export function sanitizeForgeHostAccount(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return FORGE_ACCOUNT_LOGIN.test(trimmed) ? trimmed : null;
}
