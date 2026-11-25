import {
  canonicalForgeHostname,
  parseForgeRemote,
  type ForgeHostMap
} from "./forge-remote";
import {
  isForgeKind,
  type ForgeKind,
  type RemoteEndpoint,
  type RemoteForgeIdentity,
  type RepoIdentity
} from "./types";

/** One non-source remote whose URLs point to a single forge repository on the
 *  same forge instance as the repository's fork source. */
export type SiblingForkCandidate = {
  remote: string;
  host: ForgeKind;
  hostname: string;
  nameWithOwner: string;
};

/** One confirmed writable sibling fork remote eligible for fork sync pushes. */
export type EligibleForkRemote = {
  remote: string;
  hostname: string;
  nameWithOwner: string;
  viewerCanPush: boolean;
  parent?: string;
  root?: string;
};

type ForkRemoteUrls = Pick<RemoteEndpoint, "fetchUrl" | "pushUrl" | "pushUrls">;

/** Sync requires a confirmed forge instance, including for SSH URLs. */
export function matchesForkSyncRepository(
  url: string,
  expected: { hostname: string; nameWithOwner: string },
  hosts: ForgeHostMap
): boolean {
  const parsed = parseForgeRemote(url, hosts);
  return parsed !== null &&
    parsed.hostname === canonicalForgeHostname(expected.hostname) &&
    parsed.nameWithOwner.toLowerCase() === expected.nameWithOwner.toLowerCase();
}

function allPushUrlsMatch(
  remote: ForkRemoteUrls,
  expected: { hostname: string; nameWithOwner: string },
  hosts: ForgeHostMap
): boolean {
  const urls = remote.pushUrls ?? [remote.pushUrl];
  return urls.length > 0 && urls.every((url) => matchesForkSyncRepository(url, expected, hosts));
}

/** Remote nicknames that safely address the same forge repository. */
export function forkSyncRemoteAliases(
  remote: string,
  endpoints: readonly RemoteEndpoint[],
  hosts: ForgeHostMap
): string[] {
  const endpoint = endpoints.find((entry) => entry.name === remote);
  const repo = endpoint === undefined ? null : parseForgeRemote(endpoint.fetchUrl, hosts);
  if (endpoint === undefined || repo === null || !isForgeKind(repo.host) ||
      !allPushUrlsMatch(endpoint, repo, hosts)) {
    return [remote];
  }
  return endpoints.filter((entry) =>
    matchesForkSyncRepository(entry.fetchUrl, repo, hosts) && allPushUrlsMatch(entry, repo, hosts)
  ).map((entry) => entry.name);
}

/** Cached metadata for the fetch repository, independent of the push routing. */
export function remoteFetchForgeMetadata(
  remote: Pick<RemoteEndpoint, "fetchUrl">,
  identity: RepoIdentity | undefined,
  endpoints: readonly Pick<RemoteEndpoint, "name" | "fetchUrl">[],
  remoteIdentities: readonly RemoteForgeIdentity[],
  hosts: ForgeHostMap = {}
): RemoteForgeIdentity | null {
  const fetch = parseForgeRemote(remote.fetchUrl, hosts);
  if (fetch === null || !isForgeKind(fetch.host)) return null;
  const origin = endpoints.find((entry) => entry.name === "origin");
  if (
    identity !== undefined &&
    origin !== undefined &&
    matchesForkSyncRepository(origin.fetchUrl, identity, hosts) &&
    matchesForkSyncRepository(remote.fetchUrl, identity, hosts)
  ) {
    return {
      hostname: identity.hostname,
      nameWithOwner: identity.nameWithOwner,
      ...(identity.viewerCanPush === undefined
        ? {}
        : { viewerCanPush: identity.viewerCanPush }),
      ...(identity.parent === undefined
        ? {}
        : { parent: identity.parent.nameWithOwner }),
      ...(identity.root === undefined ? {} : { root: identity.root.nameWithOwner }),
      ...(identity.fetchedAt === undefined ? {} : { fetchedAt: identity.fetchedAt })
    };
  }
  const host = fetch.hostname.toLowerCase();
  const slug = fetch.nameWithOwner.toLowerCase();
  const hit = remoteIdentities.find(
    (entry) =>
      entry.hostname.toLowerCase() === host &&
      entry.nameWithOwner.toLowerCase() === slug
  );
  return hit ?? null;
}

/** Cached metadata only when every push destination matches the fetch repository. */
function remoteForgeMetadata(
  remote: ForkRemoteUrls,
  identity: RepoIdentity | undefined,
  endpoints: readonly RemoteEndpoint[],
  remoteIdentities: readonly RemoteForgeIdentity[],
  hosts: ForgeHostMap
): RemoteForgeIdentity | null {
  const meta = remoteFetchForgeMetadata(remote, identity, endpoints, remoteIdentities, hosts);
  return meta !== null && allPushUrlsMatch(remote, meta, hosts) ? meta : null;
}

/**
 * Canonical `(hostname, nameWithOwner)` of the repository's fork source remote
 * (e.g. `upstream` -> `pingdotgg/t3code`).
 */
export function resolveSourceForgeRepo(
  endpoints: readonly RemoteEndpoint[],
  sourceRemote: string | null,
  identity: RepoIdentity | undefined,
  hosts: ForgeHostMap = {}
): { host: ForgeKind; hostname: string; nameWithOwner: string } | null {
  if (sourceRemote !== null) {
    const endpoint = endpoints.find((entry) => entry.name === sourceRemote);
    if (endpoint !== undefined) {
      const parsed = parseForgeRemote(endpoint.fetchUrl, hosts);
      if (parsed !== null && isForgeKind(parsed.host)) {
        return {
          host: parsed.host,
          hostname: parsed.hostname,
          nameWithOwner: parsed.nameWithOwner
        };
      }
    }
  }
  if (identity?.parent !== undefined && isForgeKind(identity.host)) {
    return {
      host: identity.host,
      hostname: identity.hostname,
      nameWithOwner: identity.parent.nameWithOwner
    };
  }
  return null;
}

/**
 * Other remotes on the same forge host whose fetch & push URLs point to one
 * repository that is neither the source nor the tracked remote. Read from URLs
 * alone — only confirmed forge metadata can promote a candidate into an
 * eligible push target.
 */
export function siblingForkCandidates(
  endpoints: readonly RemoteEndpoint[],
  options: {
    sourceRemote: string | null;
    trackedRemote: string | null;
    source: { host: ForgeKind; hostname: string; nameWithOwner: string };
    hosts?: ForgeHostMap;
  }
): SiblingForkCandidate[] {
  const hosts = options.hosts ?? {};
  const sourceHost = options.source.hostname.toLowerCase();
  const sourceSlug = options.source.nameWithOwner.toLowerCase();
  const taken = new Set<string>([sourceSlug]);
  if (options.trackedRemote !== null) {
    const tracked = endpoints.find((entry) => entry.name === options.trackedRemote);
    if (tracked !== undefined) {
      const parsed = parseForgeRemote(tracked.fetchUrl, hosts);
      if (parsed !== null && parsed.hostname.toLowerCase() === sourceHost) {
        taken.add(parsed.nameWithOwner.toLowerCase());
      }
    }
  }
  // Prefer `origin` first if `origin` is a sibling (when the branch tracks a
  // non-origin fork), then remaining remotes in Git's order.
  const ordered = [...endpoints].sort(
    (a, b) => Number(b.name === "origin") - Number(a.name === "origin")
  );
  const candidates: SiblingForkCandidate[] = [];
  for (const remote of ordered) {
    if (remote.name === options.sourceRemote || remote.name === options.trackedRemote) {
      continue;
    }
    const fetch = parseForgeRemote(remote.fetchUrl, hosts);
    if (
      fetch === null ||
      !isForgeKind(fetch.host) ||
      fetch.hostname.toLowerCase() !== sourceHost ||
      !allPushUrlsMatch(remote, fetch, hosts)
    ) {
      continue;
    }
    const slug = fetch.nameWithOwner.toLowerCase();
    if (taken.has(slug)) continue;
    taken.add(slug);
    candidates.push({
      remote: remote.name,
      host: fetch.host,
      hostname: fetch.hostname,
      nameWithOwner: fetch.nameWithOwner
    });
  }
  return candidates;
}

/**
 * Whether `meta` confirms a repository is a writable fork of `sourceSlug`
 * (either direct fork via `parent`, or fork-of-a-fork via `root`).
 */
export function isWritableForkOf(
  meta: Pick<RemoteForgeIdentity, "viewerCanPush" | "parent" | "root">,
  sourceSlug: string
): boolean {
  if (meta.viewerCanPush !== true) return false;
  const target = sourceSlug.toLowerCase();
  return (
    meta.parent?.toLowerCase() === target ||
    meta.root?.toLowerCase() === target
  );
}

/**
 * Sibling remotes confirmed by the forge as writable forks of the fork source.
 * Never guesses write access or fork lineage from remote names alone.
 */
export function eligibleSiblingForkRemotes(
  endpoints: readonly RemoteEndpoint[],
  options: {
    sourceRemote: string | null;
    trackedRemote: string | null;
    identity: RepoIdentity | undefined;
    remoteIdentities: readonly RemoteForgeIdentity[];
    hosts?: ForgeHostMap;
  }
): EligibleForkRemote[] {
  const hosts = options.hosts ?? {};
  const source = resolveSourceForgeRepo(
    endpoints,
    options.sourceRemote,
    options.identity,
    hosts
  );
  if (source === null) return [];
  const candidates = siblingForkCandidates(endpoints, {
    sourceRemote: options.sourceRemote,
    trackedRemote: options.trackedRemote,
    source,
    hosts
  });
  const eligible: EligibleForkRemote[] = [];
  for (const candidate of candidates) {
    const endpoint = endpoints.find((entry) => entry.name === candidate.remote);
    if (endpoint === undefined) continue;
    const meta = remoteForgeMetadata(
      endpoint,
      options.identity,
      endpoints,
      options.remoteIdentities,
      hosts
    );
    if (meta === null || !isWritableForkOf(meta, source.nameWithOwner)) {
      continue;
    }
    eligible.push({
      remote: candidate.remote,
      hostname: meta.hostname,
      nameWithOwner: meta.nameWithOwner,
      viewerCanPush: true,
      ...(meta.parent === undefined ? {} : { parent: meta.parent }),
      ...(meta.root === undefined ? {} : { root: meta.root })
    });
  }
  return eligible;
}

/**
 * Whether fork sync is enabled for a remote, given the repository's stored
 * per-remote overrides. Writable fork remotes are enabled by default; only an
 * explicit `false` disables one.
 */
export function isForkSyncRemoteEnabled(
  remote: string,
  prefs: ReadonlyMap<string, boolean>,
  endpoints: readonly RemoteEndpoint[] = [],
  hosts: ForgeHostMap = {}
): boolean {
  return forkSyncRemoteAliases(remote, endpoints, hosts).every((name) => prefs.get(name) !== false);
}

/**
 * Repo-level summary of every remote eligible for fork sync push (used by the
 * Remotes tab). Includes `origin` when `origin` is a writable fork, plus every
 * confirmed writable sibling fork of the same upstream.
 */
export function repoForkSyncEligibility(
  endpoints: readonly RemoteEndpoint[],
  options: {
    identity: RepoIdentity | undefined;
    remoteIdentities: readonly RemoteForgeIdentity[];
    prefs: ReadonlyMap<string, boolean>;
    hosts?: ForgeHostMap;
  }
): Map<
  string,
  {
    eligible: boolean;
    enabled: boolean;
    viewerCanPush?: boolean;
    parent?: string;
    root?: string;
  }
> {
  const hosts = options.hosts ?? {};
  const result = new Map<
    string,
    {
      eligible: boolean;
      enabled: boolean;
      viewerCanPush?: boolean;
      parent?: string;
      root?: string;
    }
  >();

  // Identify the fork source repo slug for this repository, if any.
  const origin = endpoints.find((entry) => entry.name === "origin");
  const validIdentity =
    options.identity !== undefined &&
    origin !== undefined &&
    matchesForkSyncRepository(origin.fetchUrl, options.identity, hosts)
      ? options.identity
      : undefined;

  let sourceSlug: string | null = null;
  let sourceHost: string | null = null;
  if (validIdentity?.parent !== undefined) {
    sourceSlug = validIdentity.parent.nameWithOwner.toLowerCase();
    sourceHost = validIdentity.hostname.toLowerCase();
  } else if (validIdentity !== undefined && validIdentity.viewerCanPush === false) {
    // `origin` itself is the read-only upstream; check if other remotes are forks of it.
    sourceSlug = validIdentity.nameWithOwner.toLowerCase();
    sourceHost = validIdentity.hostname.toLowerCase();
  } else {
    const upstream = endpoints.find((entry) => entry.name === "upstream");
    if (upstream !== undefined) {
      const parsed = parseForgeRemote(upstream.fetchUrl, hosts);
      if (parsed !== null && isForgeKind(parsed.host)) {
        sourceSlug = parsed.nameWithOwner.toLowerCase();
        sourceHost = parsed.hostname.toLowerCase();
      }
    }
  }

  // Only mark remotes as fork-sync eligible when a remote for the source
  // actually exists in the repository (otherwise there is no upstream to sync from).
  const hasSourceRemote =
    sourceSlug !== null &&
    sourceHost !== null &&
    endpoints.some((endpoint) => {
      const parsed = parseForgeRemote(endpoint.fetchUrl, hosts);
      return (
        parsed !== null &&
        parsed.hostname.toLowerCase() === sourceHost &&
        parsed.nameWithOwner.toLowerCase() === sourceSlug
      );
    });

  // Deduplicate eligible remotes by slug (`origin` first so `origin` wins over
  // a duplicate nickname pointing at the same repository).
  const ordered = [...endpoints].sort(
    (a, b) => Number(b.name === "origin") - Number(a.name === "origin")
  );
  const seenEligibleSlugs = new Set<string>();

  for (const endpoint of ordered) {
    const meta = remoteForgeMetadata(
      endpoint,
      validIdentity,
      endpoints,
      options.remoteIdentities,
      hosts
    );
    if (meta === null) continue;
    const slug = meta.nameWithOwner.toLowerCase();
    const sameHost = sourceHost !== null && meta.hostname.toLowerCase() === sourceHost;
    // `origin` on a forge that omits `viewerCanPush` (e.g. GitCafe) is still
    // eligible if it is a confirmed fork and not explicitly read-only; sibling
    // remotes always require explicit `viewerCanPush === true`.
    const writable =
      endpoint.name === "origin"
        ? meta.viewerCanPush !== false
        : meta.viewerCanPush === true;
    const isForkOfSource =
      hasSourceRemote &&
      sourceSlug !== null &&
      sameHost &&
      slug !== sourceSlug &&
      (meta.parent?.toLowerCase() === sourceSlug ||
        meta.root?.toLowerCase() === sourceSlug);
    const eligible = writable && isForkOfSource && !seenEligibleSlugs.has(slug);
    if (eligible) seenEligibleSlugs.add(slug);
    result.set(endpoint.name, {
      eligible,
      enabled: eligible ? isForkSyncRemoteEnabled(endpoint.name, options.prefs, endpoints, hosts) : false,
      ...(meta.viewerCanPush === undefined ? {} : { viewerCanPush: meta.viewerCanPush }),
      ...(meta.parent === undefined ? {} : { parent: meta.parent }),
      ...(meta.root === undefined ? {} : { root: meta.root })
    });
  }
  return result;
}
