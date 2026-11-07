import type { ForgeProvider, RemoteIdentity, RemoteSummary } from "./types.js";

const SCP_REMOTE = /^(?:[^@\s]+@)?([^\s:/]+):(.+?)\/?$/;
const SAFE_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

/**
 * Each product's SaaS host and env allowlist, in the app's `FORGE_KINDS` order.
 * The order is load-bearing: a host two allowlists name belongs to the first,
 * as it does in `ForgeHosts.kindFor`.
 */
const PRODUCTS = [
  { provider: "github", saasHost: "github.com", env: "PWRGIT_GITHUB_HOSTS" },
  { provider: "gitlab", saasHost: "gitlab.com", env: "PWRGIT_GITLAB_HOSTS" },
  { provider: "gitcafe", saasHost: "git.cafe", env: "PWRGIT_GITCAFE_HOSTS" }
] as const;

/**
 * The app's `canonicalForgeHostname` (`packages/shared`), which this package
 * cannot import. Every leading `www.`, not one: the app strips them all, so a
 * single strip here read `www.www.host` in an allowlist as a different host
 * from the one the app resolves. Null for anything that is not a bare hostname.
 */
export function canonicalHostname(value: string): string | null {
  const host = value.trim().toLowerCase().replace(/^(?:www\.)+/, "");
  if (host === "") return null;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(host)) {
    return null;
  }
  return host;
}

/**
 * Self-managed hosts named by the environment, the same variables the desktop
 * app reads (`ForgeHosts`' env layer).
 *
 * This server bundles standalone and has no settings file and no `gh`/`glab`
 * enumeration, so env is the only way a self-managed instance can be *stated*
 * rather than guessed. It is deliberately the app's own spelling: a user who
 * has already told PwrGit about `gitlab.acme.io` does not have to tell the MCP
 * server separately.
 */
function envProviders(env: NodeJS.ProcessEnv): ReadonlyMap<string, ForgeProvider> {
  const named = new Map<string, ForgeProvider>();
  for (const { env: name, provider } of PRODUCTS) {
    for (const entry of (env[name] ?? "").split(",")) {
      const host = canonicalHostname(entry);
      if (host !== null && !named.has(host)) named.set(host, provider);
    }
  }
  return named;
}

/**
 * Which forge a hostname belongs to, or `other` when it cannot be known.
 *
 * Mirrors the desktop app's `classifyForgeHost` (`packages/shared`), which this
 * package cannot import — it bundles standalone. The rule that matters is the
 * one they must agree on: **a hostname is never evidence.** A `gitlab.*` prefix
 * used to be read as GitLab here and in the app; the app dropped it because a
 * self-managed instance is known only from a `gh`/`glab` sign-in or an explicit
 * setting, and keeping it here would mean an agent asking this server got
 * `gitlab` for a host the app itself calls unknown.
 *
 * `other` is not a dead end here the way it is in the app: finding a checkout
 * is a host + path question, and `targetMatchesRemote` answers it without a
 * provider. Only the live change-request and CI lookups need to know which CLI
 * to spawn, which is what the env allowlist is for.
 *
 * Env first, then the SaaS hostnames — `ForgeHosts.kindFor`'s order. This
 * server used to test the SaaS names first, so `PWRGIT_GITLAB_HOSTS=github.com`
 * made the app and an agent name two different products for one host. The
 * app's answer from env alone is the oracle (`forge-surfaces.property.test.ts`).
 */
export function classifyProvider(
  host: string,
  env: NodeJS.ProcessEnv = process.env
): ForgeProvider {
  const normalized = canonicalHostname(host);
  if (normalized === null) return "other";
  return (
    envProviders(env).get(normalized) ??
    PRODUCTS.find((product) => product.saasHost === normalized)?.provider ??
    "other"
  );
}

function normalizeProjectPath(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const segments = decoded
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/i, "")
    .split("/");
  if (
    segments.length < 2 ||
    segments.length > 8 ||
    !segments.every((segment) => SAFE_SEGMENT.test(segment))
  ) {
    return null;
  }
  return segments.join("/");
}

/** Parse URL-style and scp-style remotes into credential-free coordinates.
 * Raw remote URLs never cross the MCP boundary. */
export function parseRemoteIdentity(
  remote: string,
  env: NodeJS.ProcessEnv = process.env
): RemoteIdentity | null {
  const value = remote.trim();
  if (value === "") return null;

  let host: string | null = null;
  let pathname: string | null = null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return null;
    }
    if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol)) {
      return null;
    }
    host = url.hostname;
    pathname = url.pathname;
  } else {
    const matched = SCP_REMOTE.exec(value);
    if (matched === null) return null;
    host = matched[1] ?? null;
    pathname = matched[2] ?? null;
  }
  if (host === null || pathname === null || host.includes("\\")) return null;
  const path = normalizeProjectPath(pathname);
  if (path === null) return null;
  const normalizedHost =
    canonicalHostname(host) ?? host.toLowerCase().replace(/^www\./, "");
  const provider = classifyProvider(normalizedHost, env);
  if ((provider === "github" || provider === "gitcafe") && path.split("/").length !== 2) return null;
  return { provider, host: normalizedHost, path };
}

export type RepositoryTarget = {
  provider: "github" | "gitlab" | "gitcafe" | null;
  host: string | null;
  path: string;
};

export function parseRepositoryTarget(
  value: string,
  provider?: "github" | "gitlab" | "gitcafe",
  env: NodeJS.ProcessEnv = process.env
): RepositoryTarget | null {
  const fromRemote = parseRemoteIdentity(value, env);
  if (fromRemote !== null) {
    // A host we cannot place is still a perfectly good target: the checkout is
    // identified by host + path, and `targetMatchesRemote` compares exactly
    // that. Rejecting it here is what made every self-managed instance
    // unreachable once the `gitlab.*` guess was removed. The caller's
    // `provider` hint is dropped rather than asserted onto the target — the
    // host is the more specific claim, and pinning an unverifiable provider
    // would make the match fail against the remote's own `other`.
    if (fromRemote.provider === "other") {
      return { provider: null, host: fromRemote.host, path: fromRemote.path };
    }
    if (provider !== undefined && provider !== fromRemote.provider) return null;
    return {
      provider: fromRemote.provider,
      host: fromRemote.host,
      path: fromRemote.path
    };
  }

  const trimmed = value.trim().replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");
  const hostQualified = /^([^/]+\.[^/]+)\/(.+)$/.exec(trimmed);
  if (hostQualified !== null) {
    const candidate = parseRemoteIdentity(`https://${trimmed}`, env);
    if (candidate === null) return null;
    if (candidate.provider === "other") {
      return { provider: null, host: candidate.host, path: candidate.path };
    }
    if (provider !== undefined && provider !== candidate.provider) return null;
    return { provider: candidate.provider, host: candidate.host, path: candidate.path };
  }
  const path = normalizeProjectPath(trimmed);
  if (path === null) return null;
  if ((provider === "github" || provider === "gitcafe") && path.split("/").length !== 2) return null;
  return { provider: provider ?? null, host: null, path };
}

export function summarizeRemotes(
  configured: ReadonlyArray<{ name: string; url: string }>,
  env: NodeJS.ProcessEnv = process.env
): RemoteSummary[] {
  const parsed = configured.flatMap(({ name, url }) => {
    const identity = parseRemoteIdentity(url, env);
    return identity === null ? [] : [{ name, identity }];
  });
  // Falls back to the first remote rather than the first *placeable* one: on a
  // repository whose only remote is a self-managed host, preferring a known
  // forge left no canonical remote at all and the status loader had nothing to
  // report on.
  const canonicalName = parsed.some(({ name }) => name === "origin")
    ? "origin"
    : (parsed.find(({ identity }) => identity.provider !== "other")?.name ??
      parsed[0]?.name);
  return parsed.map(({ name, identity }) => ({
    ...identity,
    name,
    role:
      name === canonicalName
        ? "canonical"
        : name === "upstream"
          ? "upstream"
          : "other"
  }));
}

export function targetMatchesRemote(
  target: RepositoryTarget,
  remote: RemoteIdentity
): boolean {
  // No provider gate: which forge runs at a host is irrelevant to whether this
  // checkout is the one asked for. Host + path is the identity, and requiring a
  // placeable provider silently excluded every self-managed instance.
  return (
    (target.provider === null || target.provider === remote.provider) &&
    (target.host === null || target.host === remote.host) &&
    target.path.toLowerCase() === remote.path.toLowerCase()
  );
}
