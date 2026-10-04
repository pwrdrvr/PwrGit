import { parseForgeRemote, remoteMatchesForgeRepo, type ForgeHostMap } from "./forge-remote";
import type { RepoIdentity } from "./types";

/**
 * What a remote is to the person reading it, rather than what it is called.
 *
 * `fork` is the repository `origin` names when the forge says it is a fork.
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
  /** The forge's answer about pushing. Known for the repository `origin`
   *  names and nothing else, so it is absent on every other remote. */
  canPush?: boolean;
};

type RemoteUrls = { name: string; fetchUrl: string; pushUrl: string };

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
  hosts: ForgeHostMap = {}
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
  return remotes.map((remote): RoutedRemote => {
    const slug = parseForgeRemote(remote.fetchUrl, hosts)?.nameWithOwner ?? null;
    if (current !== undefined && remoteMatchesForgeRepo(remote.fetchUrl, current, hosts)) {
      const canPush =
        current.viewerCanPush !== undefined &&
        remoteMatchesForgeRepo(remote.pushUrl, current, hosts)
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
