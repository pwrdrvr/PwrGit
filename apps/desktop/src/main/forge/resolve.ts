import { classifyForgeHost, forgeAllowsPathDepth } from "@pwrgit/shared";
import type { ForgeKind, ForgeRepo } from "./types";

/** Host → forge, for hosts whose name doesn't announce what they run. */
export type ForgeHostOverrides = Readonly<Record<string, ForgeKind>>;

type ParsedRemote = { host: string; port?: number; path: string };

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

  // scp syntax (`git@host:path`) has no port field at all.
  const scp = /^(?:([^@/]+)@)?([^@/:]+):(.+)$/.exec(trimmed);
  const urlLike =
    /^(https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::(\d+))?\/(.+)$/i.exec(trimmed);

  const matched = urlLike ?? (isUrlLike(trimmed) ? null : scp);
  if (matched === null) return null;
  // Host is group 2 either way: (user, host, path) for scp, (scheme, host,
  // port, path) for a URL.
  const host = canonicalHost(matched[2]);
  const rawPath = urlLike ? matched[4] : matched[3];
  if (host === undefined || rawPath === undefined) return null;

  const path = normalizePath(rawPath);
  if (path === null) return null;
  // A port only tells us where the API lives when the remote is itself a web
  // URL. An ssh:// port is the SSH daemon's and says nothing about https.
  const scheme = urlLike?.[1]?.toLowerCase();
  const port =
    scheme === "http" || scheme === "https"
      ? normalizePort(urlLike?.[3])
      : undefined;
  return port === undefined ? { host, path } : { host, port, path };
}

/**
 * Lowercase, and drop a `www.` prefix.
 *
 * `www.github.com` is a perfectly valid remote, but `gh api --hostname
 * www.github.com` and `https://www.gitlab.com/api/graphql` are not what either
 * CLI or API expects — the canonical name is the one without it.
 */
function canonicalHost(value: string | undefined): string | undefined {
  const host = value?.trim().toLowerCase();
  if (host === undefined || host === "") return undefined;
  const withoutWww = host.startsWith("www.") ? host.slice(4) : host;
  return withoutWww === "" ? undefined : withoutWww;
}

function normalizePort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const port = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) return undefined;
  // 443 is already implied by https; carrying it would only make two spellings
  // of the same origin.
  return port === 443 ? undefined : port;
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
 * Only the two SaaS hostnames are certain. Every self-managed instance —
 * `gitlab.corp.example` as much as `git.acme.com` — is unknowable from the URL
 * alone and needs an entry in `overrides`, which `ForgeHosts.overrides()`
 * builds from what `gh`/`glab` are signed in to plus what the user added by
 * hand. Until a host is in there PwrGit no-ops exactly as it does for any
 * unrecognized remote.
 */
export function classifyHost(
  host: string,
  overrides: ForgeHostOverrides = {}
): ForgeKind | null {
  // Delegates to the shared classifier so the clone/fork dialogs — which run
  // in the renderer and cannot import from main — cannot disagree with this
  // process about which forge owns a remote. `other` is this function's null.
  const kind = classifyForgeHost(canonicalHost(host) ?? "", overrides);
  return kind === "other" ? null : kind;
}

/**
 * Resolve a remote URL to the repo a provider can query, or null to no-op.
 *
 * Path depth is the product's own rule (`maxPathSegments`): a product without
 * subgroups must be exactly `owner/repo`, because anything deeper is some other
 * URL of theirs — a tree, a gist — rather than a repository, while one that
 * nests accepts whatever depth it was given.
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
  if (!forgeAllowsPathDepth(kind, segments.length)) return null;
  return {
    kind,
    host: parsed.host,
    ...(parsed.port === undefined ? {} : { port: parsed.port }),
    path: parsed.path
  };
}

/** Split a GitHub `owner/repo` path for APIs that still want two arguments. */
export function githubOwnerAndName(
  repo: ForgeRepo
): { owner: string; name: string } | null {
  const [owner, name] = repo.path.split("/");
  return owner === undefined || name === undefined ? null : { owner, name };
}
