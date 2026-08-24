import type { ForgeProvider, RemoteIdentity, RemoteSummary } from "./types.js";

const SCP_REMOTE = /^(?:[^@\s]+@)?([^\s:/]+):(.+?)\/?$/;
const SAFE_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

export function classifyProvider(host: string): ForgeProvider {
  const normalized = host.trim().toLowerCase().replace(/^www\./, "");
  if (normalized === "github.com") return "github";
  if (normalized === "gitlab.com" || normalized.startsWith("gitlab.")) {
    return "gitlab";
  }
  return "other";
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
export function parseRemoteIdentity(remote: string): RemoteIdentity | null {
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
  const provider = classifyProvider(normalizedHost);
  if (provider === "github" && path.split("/").length !== 2) return null;
  return { provider, host: normalizedHost, path };
}

export type RepositoryTarget = {
  provider: "github" | "gitlab" | null;
  host: string | null;
  path: string;
};

export function parseRepositoryTarget(
  value: string,
  provider?: "github" | "gitlab"
): RepositoryTarget | null {
  const fromRemote = parseRemoteIdentity(value);
  if (fromRemote !== null) {
    if (fromRemote.provider === "other") return null;
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
    const candidate = parseRemoteIdentity(`https://${trimmed}`);
    if (candidate === null || candidate.provider === "other") return null;
    if (provider !== undefined && provider !== candidate.provider) return null;
    return { provider: candidate.provider, host: candidate.host, path: candidate.path };
  }
  const path = normalizeProjectPath(trimmed);
  if (path === null) return null;
  if (provider === "github" && path.split("/").length !== 2) return null;
  return { provider: provider ?? null, host: null, path };
}

export function summarizeRemotes(
  configured: ReadonlyArray<{ name: string; url: string }>
): RemoteSummary[] {
  const parsed = configured.flatMap(({ name, url }) => {
    const identity = parseRemoteIdentity(url);
    return identity === null ? [] : [{ name, identity }];
  });
  const canonicalName = parsed.some(({ name }) => name === "origin")
    ? "origin"
    : parsed.find(({ identity }) => identity.provider !== "other")?.name;
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
  return (
    remote.provider !== "other" &&
    (target.provider === null || target.provider === remote.provider) &&
    (target.host === null || target.host === remote.host) &&
    target.path.toLowerCase() === remote.path.toLowerCase()
  );
}
