import type { ForgeKind, ForgeRepo } from "./types";

/** Host → forge, for hosts whose name doesn't announce what they run. */
export type ForgeHostOverrides = Readonly<Record<string, ForgeKind>>;

type ParsedRemote = { host: string; path: string };

/**
 * Split any git remote URL into its host and namespace path.
 *
 * Covers scp-style (`git@host:a/b.git`), url-style (`https|ssh|git://`), an
 * optional user, an optional port, and an optional `.git`. Unlike the GitHub
 * parser this keeps every path segment, because a GitLab project may sit at
 * any depth.
 */
export function parseRemoteUrl(url: string): ParsedRemote | null {
  const trimmed = url.trim();
  if (trimmed === "") return null;

  const scp = /^(?:([^@/]+)@)?([^@/:]+):(.+)$/.exec(trimmed);
  const urlLike = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i
    .exec(trimmed);

  const matched = urlLike ?? (isUrlLike(trimmed) ? null : scp);
  if (matched === null) return null;
  const host = (urlLike ? matched[1] : matched[2])?.toLowerCase();
  const rawPath = urlLike ? matched[2] : matched[3];
  if (host === undefined || rawPath === undefined) return null;

  const path = normalizePath(rawPath);
  return path === null ? null : { host, path };
}

function isUrlLike(url: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(url);
}

/** Strip a `.git` suffix and any surrounding slashes; reject an empty result. */
function normalizePath(rawPath: string): string | null {
  const path = rawPath
    .replace(/\.git$/i, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  if (path === "") return null;
  // A remote never addresses GitLab's `/-/` route-separator namespace.
  if (path.split("/").some((segment) => segment === "" || segment === "-")) {
    return null;
  }
  return path;
}

/**
 * Which forge a host runs, or null when we can't tell.
 *
 * Only the two SaaS hostnames are certain. A `gitlab.*` prefix is the near
 * universal self-managed convention and is worth honoring, but self-managed
 * instances on unrelated hostnames are unknowable from the URL alone — those
 * need an explicit override, and until one exists PwrGit no-ops exactly as it
 * does today for any unrecognized remote.
 */
export function classifyHost(
  host: string,
  overrides: ForgeHostOverrides = {}
): ForgeKind | null {
  const normalized = host.trim().toLowerCase();
  const override = overrides[normalized];
  if (override !== undefined) return override;
  if (normalized === "github.com" || normalized === "www.github.com") {
    return "github";
  }
  if (normalized === "gitlab.com" || normalized === "www.gitlab.com") {
    return "gitlab";
  }
  if (normalized.startsWith("gitlab.")) return "gitlab";
  return null;
}

/**
 * Resolve a remote URL to the repo a provider can query, or null to no-op.
 *
 * A GitHub path must be exactly `owner/repo`; anything deeper is some other
 * GitHub URL (a tree, a gist) rather than a repository. GitLab accepts two or
 * more segments so nested groups work.
 */
export function resolveForgeRepo(
  url: string,
  overrides: ForgeHostOverrides = {}
): ForgeRepo | null {
  const parsed = parseRemoteUrl(url);
  if (parsed === null) return null;
  const kind = classifyHost(parsed.host, overrides);
  if (kind === null) return null;
  const segments = parsed.path.split("/");
  if (kind === "github" && segments.length !== 2) return null;
  if (kind === "gitlab" && segments.length < 2) return null;
  return { kind, host: parsed.host, path: parsed.path };
}

/** Split a GitHub `owner/repo` path for APIs that still want two arguments. */
export function githubOwnerAndName(
  repo: ForgeRepo
): { owner: string; name: string } | null {
  const [owner, name] = repo.path.split("/");
  return owner === undefined || name === undefined ? null : { owner, name };
}
