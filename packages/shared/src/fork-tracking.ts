import { parseForgeRemote, type ForgeHostMap } from "./forge-remote";
import type { ForkTrackingRepair, RepoIdentity } from "./types";

/** A remote rename carries branch tracking with it. Offer to restore tracking
 *  only when the forge confirms origin is the fork and the tracked remote is
 *  its parent. A remote named upstream alone is not proof. */
export function forkTrackingRepair(
  identity: RepoIdentity | undefined,
  remotes: readonly { name: string; fetchUrl: string; pushUrl: string }[],
  branch: { name: string; upstream?: string },
  hosts: ForgeHostMap = {}
): ForkTrackingRepair | null {
  if (identity?.parent === undefined || branch.upstream === undefined) {
    return null;
  }
  const upstream = branch.upstream;
  // Config repair requires a confirmed instance, rather than guessing which
  // host an SSH alias might reach.
  const matches = (url: string, slug: string): boolean => {
    const remote = parseForgeRemote(url, hosts);
    return (
      remote !== null &&
      remote.hostname === identity.hostname &&
      remote.nameWithOwner.toLowerCase() === slug.toLowerCase()
    );
  };
  const origin = remotes.find((remote) => remote.name === "origin");
  if (
    origin === undefined ||
    !matches(origin.fetchUrl, identity.nameWithOwner) ||
    !matches(origin.pushUrl, identity.nameWithOwner)
  ) return null;
  const tracked = [...remotes]
    .sort((a, b) => b.name.length - a.name.length)
    .find((remote) => upstream.startsWith(`${remote.name}/`));
  if (
    tracked === undefined || tracked.name === "origin" ||
    !matches(tracked.fetchUrl, identity.parent.nameWithOwner)
  ) return null;
  return { branch: branch.name, upstream, target: `origin/${branch.name}` };
}
