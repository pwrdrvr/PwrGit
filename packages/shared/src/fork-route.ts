import { parseForgeRemote, remoteMatchesForgeRepo, type ForgeHostMap } from "./forge-remote";
import type { RemoteForgeIdentity, RepoIdentity } from "./types";

/**
 * What a remote is to the person reading it, rather than what it is called.
 *
 * `fork` is the repository `origin` names when the forge says it is a fork,
 * or another remote the forge confirms is a fork of the same original.
 * `original` is that fork's parent, or a repository the forge says you can't
 * push to and which has no parent: the one a Fork… would copy. Everything
 * else is `other`, however it is named. A remote called `upstream` is not
 * the original until its URL says so.
 */
export type RemoteRole = "fork" | "original" | "other";

export type RoutedRemote = {
  /** The local nickname, as `git remote` lists it. */
  name: string;
  /** `owner/name` on a forge, or null when the URL names none. */
  nameWithOwner: string | null;
  role: RemoteRole;
  /** The forge's answer about pushing, when confirmed for this remote. */
  canPush?: boolean;
};

type RemoteUrls = { name: string; fetchUrl: string; pushUrl: string; pushUrls?: string[] };

/**
 * Each remote labelled by what it is, for the surfaces that draw where a
 * branch pulls from and pushes to (Publish, the Remotes tab).
 *
 * `identity` describes the repository `origin` pointed at when the forge
 * last answered. It is trusted only while `origin` still points there: a
 * re-pointed `origin` would otherwise lend its old answer to a new
 * repository. The push answer additionally needs the push URL to agree,
 * since that is where a push goes.
 */
export function routedRemotes(
  identity: RepoIdentity | undefined,
  remotes: readonly RemoteUrls[],
  hosts: ForgeHostMap = {},
  remoteIdentities: readonly RemoteForgeIdentity[] = []
): RoutedRemote[] {
  const origin = remotes.find((remote) => remote.name === "origin");
  const current =
    identity !== undefined &&
    origin !== undefined &&
    remoteMatchesForgeRepo(origin.fetchUrl, identity, hosts)
      ? identity
      : undefined;
  const parent =
    current?.parent === undefined
      ? undefined
      : { hostname: current.hostname, nameWithOwner: current.parent.nameWithOwner };
  const root =
    current?.root === undefined
      ? undefined
      : { hostname: current.hostname, nameWithOwner: current.root.nameWithOwner };
  const originalSlug =
    parent?.nameWithOwner.toLowerCase() ??
    (current !== undefined && current.viewerCanPush === false
      ? current.nameWithOwner.toLowerCase()
      : undefined);
  const rootSlug = root?.nameWithOwner.toLowerCase();
  const byKey = new Map<string, RemoteForgeIdentity>();
  for (const entry of remoteIdentities) {
    byKey.set(`${entry.hostname.toLowerCase()}\0${entry.nameWithOwner.toLowerCase()}`, entry);
  }
  return remotes.map((remote): RoutedRemote => {
    const parsedFetch = parseForgeRemote(remote.fetchUrl, hosts);
    const slug = parsedFetch?.nameWithOwner ?? null;
    if (current !== undefined && remoteMatchesForgeRepo(remote.fetchUrl, current, hosts)) {
      const canPush =
        current.viewerCanPush !== undefined &&
        (remote.pushUrls ?? [remote.pushUrl]).every((url) => remoteMatchesForgeRepo(url, current, hosts))
          ? { canPush: current.viewerCanPush }
          : {};
      if (parent !== undefined) {
        return { name: remote.name, nameWithOwner: current.nameWithOwner, role: "fork", ...canPush };
      }
      // Not a fork, and closed to you: the repository a fork would copy.
      if (current.viewerCanPush === false) {
        return { name: remote.name, nameWithOwner: current.nameWithOwner, role: "original", ...canPush };
      }
      return { name: remote.name, nameWithOwner: current.nameWithOwner, role: "other", ...canPush };
    }
    if (parent !== undefined && remoteMatchesForgeRepo(remote.fetchUrl, parent, hosts)) {
      return { name: remote.name, nameWithOwner: parent.nameWithOwner, role: "original" };
    }
    if (parsedFetch !== null) {
      const meta = byKey.get(
        `${parsedFetch.hostname.toLowerCase()}\0${parsedFetch.nameWithOwner.toLowerCase()}`
      );
      if (meta !== undefined) {
        const pushMatches = (remote.pushUrls ?? [remote.pushUrl]).every((url) =>
          remoteMatchesForgeRepo(url, meta, hosts)
        );
        const canPush =
          meta.viewerCanPush !== undefined && pushMatches
            ? { canPush: meta.viewerCanPush }
            : {};
        const metaParent = meta.parent?.toLowerCase();
        const metaRoot = meta.root?.toLowerCase();
        const sameForkNetwork =
          current?.hostname.toLowerCase() === meta.hostname.toLowerCase() &&
          ((originalSlug !== undefined &&
            (metaParent === originalSlug || metaRoot === originalSlug)) ||
            (rootSlug !== undefined &&
              (metaParent === rootSlug || metaRoot === rootSlug)));
        if (sameForkNetwork) {
          return { name: remote.name, nameWithOwner: meta.nameWithOwner, role: "fork", ...canPush };
        }
        return { name: remote.name, nameWithOwner: meta.nameWithOwner, role: "other", ...canPush };
      }
    }
    return { name: remote.name, nameWithOwner: slug, role: "other" };
  });
}

/**
 * The remote a tracking ref like `upstream/main` belongs to. The longest
 * matching nickname wins, because remote names may contain a slash
 * (`team/upstream`) and a shorter one can be a prefix of it.
 */
export function trackedRemoteName(
  upstream: string | undefined,
  remotes: readonly { name: string }[]
): string | null {
  if (upstream === undefined) return null;
  let best: string | null = null;
  for (const remote of remotes) {
    if (upstream.startsWith(`${remote.name}/`) && (best === null || remote.name.length > best.length)) {
      best = remote.name;
    }
  }
  return best;
}
