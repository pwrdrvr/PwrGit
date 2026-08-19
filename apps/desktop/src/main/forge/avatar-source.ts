/**
 * Which avatar URLs may enter SQLite, the on-disk thumbnail cache, and a later
 * image request — for any forge.
 *
 * This is a security boundary, not a convenience: it exists so a surprising
 * signed or tokenized URL from an API response can never be persisted or
 * re-fetched. Every accepted URL is https, credential-free, stripped of its
 * hash, and stripped of every query parameter except a small known-safe set.
 *
 * The host rules differ per forge:
 * - GitHub serves avatars from `*.githubusercontent.com`.
 * - GitLab serves either a Gravatar or an upload on the instance's own host,
 *   which for a self-managed instance is only knowable at runtime — hence
 *   `rememberForgeAvatarHost`, which the resolver calls for each origin.
 */

const GRAVATAR_HOSTS = new Set(["secure.gravatar.com", "www.gravatar.com"]);
const SAAS_FORGE_HOSTS = new Set(["gitlab.com", "github.com"]);

/**
 * Query parameters worth preserving, by meaning:
 * - `v` versions GitHub's avatar so a changed picture busts the cache.
 * - `d` selects Gravatar's fallback image (`identicon`), without which an
 *   account with no Gravatar renders as a blank square instead of its glyph.
 */
const PRESERVED_PARAMS = ["v", "d"] as const;
const PRESERVED_PARAM_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/** Thumbnails are rendered at 28px; 64 keeps thousands of files genuinely cheap. */
const AVATAR_SIZE = "64";

const runtimeHosts = new Set<string>();

/**
 * Trust a self-managed forge host seen on a real `origin`.
 *
 * The host comes from the user's own git remote, and an avatar URL still has to
 * be served by that same instance's API to be accepted — so this widens *which
 * instance* may serve an avatar, never what a URL is allowed to contain.
 */
export function rememberForgeAvatarHost(host: string): void {
  const normalized = host.trim().toLowerCase();
  if (normalized !== "") runtimeHosts.add(normalized);
}

/** Only for tests; production accumulates hosts for the process's lifetime. */
export function clearRememberedForgeAvatarHosts(): void {
  runtimeHosts.clear();
}

function isTrustedHost(hostname: string): boolean {
  return (
    hostname === "avatars.githubusercontent.com" ||
    hostname.endsWith(".githubusercontent.com") ||
    GRAVATAR_HOSTS.has(hostname) ||
    SAAS_FORGE_HOSTS.has(hostname) ||
    runtimeHosts.has(hostname)
  );
}

/**
 * Normalize one avatar URL, or return undefined to refuse it.
 *
 * `base` lets a relative avatar path — which GitLab returns for an uploaded
 * picture (`/uploads/-/system/user/avatar/1/avatar.png`) — resolve against the
 * instance it came from.
 */
export function normalizeForgeAvatarSourceUrl(
  sourceUrl: string,
  base?: string
): string | undefined {
  try {
    const url = base === undefined ? new URL(sourceUrl) : new URL(sourceUrl, base);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      !isTrustedHost(url.hostname.toLowerCase())
    ) {
      return undefined;
    }
    url.hash = "";
    const preserved = PRESERVED_PARAMS.map(
      (name) => [name, url.searchParams.get(name)] as const
    );
    url.search = "";
    for (const [name, value] of preserved) {
      if (value !== null && PRESERVED_PARAM_PATTERN.test(value)) {
        url.searchParams.set(name, value);
      }
    }
    // Both GitHub's avatar endpoint and Gravatar accept `s`.
    url.searchParams.set("s", AVATAR_SIZE);
    return url.toString();
  } catch {
    return undefined;
  }
}
