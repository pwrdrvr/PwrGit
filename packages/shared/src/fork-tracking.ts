import { parseForgeRemote, type ForgeHostMap } from "./forge-remote";
import type { ForkTrackingRepair, ForkTrackingTarget, RepoIdentity } from "./types";

/** A remote rename carries branch tracking with it. Offer to restore tracking
 *  only when the forge confirms origin is the fork and the tracked remote is
 *  its parent. A remote named upstream alone is not proof. */
export function forkTrackingRepair(
  identity: RepoIdentity | undefined,
  remotes: readonly { name: string; fetchUrl: string; pushUrl: string }[],
  branch: { name: string; upstream?: string },
  hosts: ForgeHostMap = {}
): ForkTrackingRepair | null {
  if (
    identity?.parent === undefined || identity.viewerCanPush === false ||
    branch.upstream === undefined
  ) {
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
  return {
    branch: branch.name, upstream, upstreamRemote: tracked.name, target: `origin/${branch.name}`
  };
}

/**
 * Remotes other than `origin` that could take the repair instead: on the
 * fork's own host, fetching and pushing to one repository that is neither
 * the fork nor its parent. Read from URLs alone, so these are candidates —
 * only the forge can say a candidate is a fork of the same parent and that
 * you may push there, and main asks it before offering one.
 */
export function forkTrackingCandidates(
  identity: RepoIdentity,
  remotes: readonly { name: string; fetchUrl: string; pushUrl: string }[],
  repair: ForkTrackingRepair,
  hosts: ForgeHostMap = {}
): ForkTrackingTarget[] {
  const taken = new Set([identity.nameWithOwner.toLowerCase()]);
  if (identity.parent !== undefined) taken.add(identity.parent.nameWithOwner.toLowerCase());
  const candidates: ForkTrackingTarget[] = [];
  for (const remote of remotes) {
    if (remote.name === "origin" || remote.name === repair.upstreamRemote) continue;
    const fetch = parseForgeRemote(remote.fetchUrl, hosts);
    const push = parseForgeRemote(remote.pushUrl, hosts);
    if (
      fetch === null || push === null || fetch.hostname !== identity.hostname ||
      push.hostname !== identity.hostname ||
      fetch.nameWithOwner.toLowerCase() !== push.nameWithOwner.toLowerCase()
    ) continue;
    const slug = fetch.nameWithOwner.toLowerCase();
    // Two nicknames for one repository are one choice, under the first name.
    if (taken.has(slug)) continue;
    taken.add(slug);
    candidates.push({
      remote: remote.name, nameWithOwner: fetch.nameWithOwner, ref: `${remote.name}/${repair.branch}`
    });
  }
  return candidates;
}
