import type { ForgeProvider, RemoteIdentity, RemoteSummary } from "./types.js";

const SCP_REMOTE = /^(?:[^@\s]+@)?([^\s:/]+):(.+?)\/?$/;
const SAFE_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

const GITHUB_HOSTS_ENV = "PWRGIT_GITHUB_HOSTS";
const GITLAB_HOSTS_ENV = "PWRGIT_GITLAB_HOSTS";

/**
 * Self-managed hosts named by the environment, the same two variables the
 * desktop app reads (`ForgeHosts`' env layer).
 *
 * This server bundles standalone and has no settings file and no `gh`/`glab`
 * enumeration, so env is the only way a self-managed instance can be *stated*
 * rather than guessed. It is deliberately the app's own spelling: a user who
 * has already told PwrGit about `gitlab.acme.io` does not have to tell the MCP
 * server separately.
 */
function envProviders(env: NodeJS.ProcessEnv): ReadonlyMap<string, ForgeProvider> {
  const named = new Map<string, ForgeProvider>();
  for (const [name, provider] of [
    [GITHUB_HOSTS_ENV, "github"],
    [GITLAB_HOSTS_ENV, "gitlab"],
    ["PWRGIT_GITCAFE_HOSTS", "gitcafe"]
  ] as const) {
    for (const entry of (env[name] ?? "").split(",")) {
      const host = entry.trim().toLowerCase().replace(/^www\./, "");
      if (host !== "" && !named.has(host)) named.set(host, provider);
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
 */
export function classifyProvider(
  host: string,
  env: NodeJS.ProcessEnv = process.env
): ForgeProvider {
  const normalized = host.trim().toLowerCase().replace(/^www\./, "");
  if (normalized === "github.com") return "github";
  if (normalized === "gitlab.com") return "gitlab";
  if (normalized === "git.cafe") return "gitcafe";
  return envProviders(env).get(normalized) ?? "other";
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
  const normalizedHost = host.toLowerCase().replace(/^www\./, "");
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
