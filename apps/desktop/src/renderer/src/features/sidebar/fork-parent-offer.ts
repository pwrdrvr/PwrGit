import {
  parseForgeRemote,
  type RepoIdentity,
  type RemoteSummary
} from "@pwrgit/shared";

export type ForkParentOffer = {
  parent: string;
  suggestedName: string;
  upstreamOccupied: boolean;
};

/** The persisted forge identity is the only reason to propose a parent. */
export function forkParentOffer(
  identity: RepoIdentity | undefined,
  remotes: readonly RemoteSummary[]
): ForkParentOffer | null {
  const parent = identity?.parent?.nameWithOwner;
  if (
    parent === undefined ||
    !remotes.some((remote) => remote.name === "origin")
  ) {
    return null;
  }
  const slug = parent.toLowerCase();
  if (
    remotes.some(
      (remote) =>
        remote.name !== "origin" &&
        parseForgeRemote(remote.fetchUrl)?.nameWithOwner.toLowerCase() === slug
    )
  ) {
    return null;
  }
  const names = new Set(remotes.map((remote) => remote.name));
  const upstreamOccupied = names.has("upstream");
  let suggestedName = "upstream";
  for (let index = 2; names.has(suggestedName); index += 1) {
    suggestedName = `upstream-${index}`;
  }
  return { parent, suggestedName, upstreamOccupied };
}
