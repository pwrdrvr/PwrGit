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
  /** Branch name on origin → its remote-tracking ref (`refs/remotes/origin/x`). */
  origin: ReadonlyMap<string, string>;
};

/**
 * Where a change request's head lives in this checkout.
 *
 * Same-repository heads are matched by name — the same assumption `branch_pr`
 * has always made — and only against origin, because the list is origin's and
 * a same-named branch on another remote is somebody else's branch.
 *
 * A fork's head is never looked for by name at all: two forks' `main` or
 * `fix-typo` are not ours. It lives, once checked out, at the product's
 * numbered local branch (`pr/121`), which is the only local name that can be
 * trusted to mean this change request.
 */
export function locateChangeRequest(
  pr: OpenChangeRequest,
  kind: ForgeKind,
  refs: CheckoutRefs
): ChangeRequestLocation {
  const held = (branch: string): ChangeRequestLocation | null => {
    const worktreeId = refs.worktrees.get(branch);
    if (worktreeId !== undefined) {
      return { kind: "worktree", branch, worktreeId };
    }
    return refs.local.has(branch) ? { kind: "local", branch } : null;
  };
  const head = pr.headRefName ?? null;
  if (pr.headRepoPath !== undefined) {
    const localBranch = changeRequestLocalBranch(kind, pr.number);
    // The forge keeps publishing a fork's head under its number after the
    // change request merges or closes, so state does not decide this one.
    return (
      held(localBranch) ?? {
        kind: "fork",
        branch: head ?? localBranch,
        headRepoPath: pr.headRepoPath,
        localBranch,
        fetchable: changeRequestHeadRef(kind, pr.number) !== null
      }
    );
  }
  if (head === null) return { kind: "missing", branch: null };
  const here = held(head);
  if (here !== null) return here;
  const fullName = refs.origin.get(head);
  if (fullName !== undefined) return { kind: "remote", branch: head, fullName };
  // An open head that is not here yet is one fetch away. A merged or closed
  // one whose branch is gone everywhere has nothing to switch to.
  return pr.state === "open"
    ? { kind: "unfetched", branch: head }
    : { kind: "missing", branch: head };
}

/** Parse `for-each-ref --format=%(refname) refs/heads refs/remotes/origin`. */
export function checkoutRefsFromRefnames(
  refnames: string,
  worktrees: ReadonlyMap<string, string>
): CheckoutRefs {
  const local = new Set<string>();
  const origin = new Map<string, string>();
  for (const line of refnames.split("\n")) {
    const ref = line.trim();
    if (ref.startsWith("refs/heads/")) {
      local.add(ref.slice("refs/heads/".length));
    } else if (ref.startsWith("refs/remotes/origin/")) {
      const name = ref.slice("refs/remotes/origin/".length);
      if (name !== "HEAD") origin.set(name, ref);
    }
  }
  return { worktrees, local, origin };
}
