import {
  changeRequestHeadRef,
  changeRequestLocalBranch,
  type ChangeRequestLocation,
  type ForgeKind,
  type OpenChangeRequest
} from "@pwrgit/shared";

/** What a checkout holds, as far as locating a change request's head needs. */
export type CheckoutRefs = {
  /** Branch → the worktree that has it checked out. */
  worktrees: ReadonlyMap<string, string>;
  /** Every local branch, checked out or not. */
  local: ReadonlySet<string>;
  /** Remote → its branch names → remote-tracking ref (`refs/remotes/origin/x`). */
  remotes: ReadonlyMap<string, ReadonlyMap<string, string>>;
};

/**
 * Which remotes a list entry involves: `remote` listed it, and `headRemote`
 * holds its head — `remote` itself for a same-repository head, another of
 * this checkout's remotes when the head is in a repository it also has (your
 * fork, for a PR you sent to the original), or null for a fork it has no
 * remote on.
 */
export type ChangeRequestPlace = {
  remote: string;
  headRemote: string | null;
};

const ORIGIN_PLACE = (pr: OpenChangeRequest): ChangeRequestPlace => ({
  remote: "origin",
  headRemote: pr.headRepoPath === undefined ? "origin" : null
});

/**
 * Where a change request's head lives in this checkout.
 *
 * A head in a repository this checkout has a remote on is matched by name —
 * the same assumption `branch_pr` has always made — and only against that
 * remote's tracking refs, because a same-named branch on another remote is
 * somebody else's branch.
 *
 * A fork's head is never looked for by name at all: two forks' `main` or
 * `fix-typo` are not ours. It lives, once checked out, at the product's
 * numbered local branch (`pr/121`, or `pr/upstream/121` when listed on
 * another remote), which is the only local name that can be trusted to mean
 * this change request.
 */
export function locateChangeRequest(
  pr: OpenChangeRequest,
  kind: ForgeKind,
  refs: CheckoutRefs,
  place: ChangeRequestPlace = ORIGIN_PLACE(pr)
): ChangeRequestLocation {
  const held = (branch: string): ChangeRequestLocation | null => {
    const worktreeId = refs.worktrees.get(branch);
    if (worktreeId !== undefined) {
      return { kind: "worktree", branch, worktreeId };
    }
    return refs.local.has(branch) ? { kind: "local", branch } : null;
  };
  const head = pr.headRefName ?? null;
  const headRemote =
    place.headRemote ?? (pr.headRepoPath === undefined ? place.remote : null);
  if (headRemote === null) {
    const localBranch = changeRequestLocalBranch(kind, pr.number, place.remote);
    // The forge keeps publishing a fork's head under its number after the
    // change request merges or closes, so state does not decide this one.
    return (
      held(localBranch) ?? {
        kind: "fork",
        branch: head ?? localBranch,
        headRepoPath: pr.headRepoPath ?? "",
        localBranch,
        remote: place.remote,
        fetchable: changeRequestHeadRef(kind, pr.number) !== null
      }
    );
  }
  if (head === null) return { kind: "missing", branch: null };
  const here = held(head);
  if (here !== null) return here;
  const fullName = refs.remotes.get(headRemote)?.get(head);
  if (fullName !== undefined) return { kind: "remote", branch: head, fullName };
  // An open head that is not here yet is one fetch away. A merged or closed
  // one whose branch is gone everywhere has nothing to switch to.
  return pr.state === "open"
    ? { kind: "unfetched", branch: head, remote: headRemote }
    : { kind: "missing", branch: head };
}

/**
 * Parse `for-each-ref --format=%(refname) refs/heads refs/remotes`, keeping
 * the tracking refs of `remoteNames`. A remote's name may itself hold a `/`,
 * so a ref belongs to the longest name it starts with.
 */
export function checkoutRefsFromRefnames(
  refnames: string,
  worktrees: ReadonlyMap<string, string>,
  remoteNames: readonly string[] = ["origin"]
): CheckoutRefs {
  const local = new Set<string>();
  const remotes = new Map<string, Map<string, string>>();
  const byLength = [...remoteNames].sort((a, b) => b.length - a.length);
  for (const line of refnames.split("\n")) {
    const ref = line.trim();
    if (ref.startsWith("refs/heads/")) {
      local.add(ref.slice("refs/heads/".length));
      continue;
    }
    if (!ref.startsWith("refs/remotes/")) continue;
    const rest = ref.slice("refs/remotes/".length);
    const remote = byLength.find((name) => rest.startsWith(`${name}/`));
    if (remote === undefined) continue;
    const name = rest.slice(remote.length + 1);
    if (name === "HEAD" || name === "") continue;
    let branches = remotes.get(remote);
    if (branches === undefined) {
      branches = new Map();
      remotes.set(remote, branches);
    }
    branches.set(name, ref);
  }
  return { worktrees, local, remotes };
}
