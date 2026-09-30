import type { RemoteEndpoint, WorktreeForkSource } from "@pwrgit/shared";
import { parseRemoteUrl } from "../forge/resolve";
import type { GitExec } from "./dugite";
import {
  listRemoteEndpoints,
  resolveForkStatus,
  type ForkParentHint
} from "./git-service";
import type { ForkSourceProbe } from "./worktree-state";

/** How long a repository's remote list is trusted before it is re-read. */
export const REMOTE_LIST_TTL_MS = 60_000;

type CachedRemotes = { at: number; endpoints: RemoteEndpoint[] };

/**
 * Could this repository have a fork source at all? The same two answers
 * `forkSourceRemote` accepts — a remote whose URL is the forge parent, or one
 * named `upstream` — asked without knowing the tracked remote, so a repo with
 * neither is settled from the cached remote list alone and spawns nothing
 * more on each probe.
 */
export function mayHaveForkSource(
  endpoints: readonly RemoteEndpoint[],
  parent: ForkParentHint | null
): boolean {
  if (endpoints.length < 2) return false;
  if (endpoints.some((endpoint) => endpoint.name === "upstream")) return true;
  if (parent === null) return false;
  const slug = parent.nameWithOwner.toLowerCase();
  return endpoints.some(
    (endpoint) => parseRemoteUrl(endpoint.fetchUrl)?.path.toLowerCase() === slug
  );
}

/**
 * The fork-source half of every worktree probe (`WorktreeStateService`).
 *
 * The header's `remote:forkStatus` asks the full question (push-back, drift,
 * the tracked tip); this keeps only the counts every surface shares, so the
 * sidebar badge, the header chip and the Pull accent read one stored number.
 * Nearly every repository is not a fork, and the remote list is the whole
 * answer for those: it is read once per repository per `REMOTE_LIST_TTL_MS`,
 * not once per worktree per probe.
 */
export function createForkSourceProbe(
  git: GitExec,
  forkParentOf: (repoId: string) => ForkParentHint | null,
  now: () => number = Date.now
): ForkSourceProbe {
  const remotes = new Map<string, CachedRemotes>();

  const endpointsOf = async (
    repoPath: string
  ): Promise<RemoteEndpoint[] | null> => {
    const cached = remotes.get(repoPath);
    if (cached !== undefined && now() - cached.at < REMOTE_LIST_TTL_MS) {
      return cached.endpoints;
    }
    const read = await listRemoteEndpoints(git, repoPath);
    if (!read.ok) return null;
    remotes.set(repoPath, { at: now(), endpoints: read.value });
    return read.value;
  };

  return async (repoId, repoPath, worktreePath) => {
    const endpoints = await endpointsOf(repoPath);
    if (endpoints === null) return null;
    const parent = forkParentOf(repoId);
    if (!mayHaveForkSource(endpoints, parent)) return null;
    const status = await resolveForkStatus(git, worktreePath, parent);
    if (!status.ok || status.value === null) return null;
    const target = status.value.source;
    if (target === null) return null;
    const source: WorktreeForkSource = {
      remote: target.remote,
      label: target.label,
      ahead: target.ahead,
      behind: target.behind
    };
    if (target.parent !== undefined) source.parent = target.parent;
    return source;
  };
}
