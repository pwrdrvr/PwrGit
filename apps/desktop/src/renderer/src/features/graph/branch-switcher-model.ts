import type { BranchRef } from "@pwrgit/shared";

/**
 * The branch switcher's rows: one per local branch, plus remote branches no
 * local branch has a name for.
 *
 * A remote branch with a local namesake is not a row of its own. When the
 * local branch tracks it, it is redundant; when it does not — `pwrdisk/main`
 * beside a `main` that tracks `origin/main` — it is one of that branch's
 * tracking choices, reached from the row's chip. Hiding the second kind as
 * well is what made another remote's `main` unreachable.
 * Design: `design/Tracking Another Remote - UX Review.dc.html`, turn 2.
 */
export type SwitcherRow = {
  ref: BranchRef;
  /** Local rows only: same-named branches on remotes it does not track. */
  alternates: BranchRef[];
  /** The alternate a search reached this row through, when the query
   *  matched nothing else on it — typing `pwrdisk/main` finds `main` with
   *  `pwrdisk/main` already chosen. */
  searchPick: BranchRef | null;
};

/** The branch name on its remote: `pwrdisk/main` → `main`. Uses the remote
 *  main resolved; a ref no configured remote owns falls back to dropping the
 *  first segment, which is what `git switch` would guess too. */
export function remoteBranchName(ref: BranchRef): string {
  return ref.remoteBranch ?? ref.name.replace(/^[^/]+\//, "");
}

/** The name to hand `git switch`: a remote ref drops its remote, so the DWIM
 *  creates or uses the local tracking branch. */
export function switchTarget(ref: BranchRef): string {
  return ref.isRemote ? remoteBranchName(ref) : ref.name;
}

export function switcherRows(
  branches: readonly BranchRef[],
  query: string
): SwitcherRow[] {
  const locals = branches.filter((b) => !b.isRemote);
  const localNames = new Set(locals.map((b) => b.name));
  const tracked = new Set(
    locals.flatMap((b) => (b.upstream === undefined ? [] : [b.upstream]))
  );
  const alternates = new Map<string, BranchRef[]>();
  const remoteRows: BranchRef[] = [];
  for (const ref of branches) {
    if (!ref.isRemote) continue;
    const name = remoteBranchName(ref);
    if (localNames.has(name)) {
      const list = alternates.get(name) ?? [];
      list.push(ref);
      alternates.set(name, list);
    } else if (!tracked.has(ref.name)) {
      remoteRows.push(ref);
    }
  }

  const q = query.trim().toLowerCase();
  const rows: SwitcherRow[] = [];
  for (const ref of locals) {
    const others = (alternates.get(ref.name) ?? []).filter(
      (alt) => alt.name !== ref.upstream
    );
    if (q === "") {
      rows.push({ ref, alternates: others, searchPick: null });
      continue;
    }
    if (
      ref.name.toLowerCase().includes(q) ||
      (ref.upstream?.toLowerCase().includes(q) ?? false)
    ) {
      rows.push({ ref, alternates: others, searchPick: null });
      continue;
    }
    const hit = others.find((alt) => alt.name.toLowerCase().includes(q));
    if (hit !== undefined) rows.push({ ref, alternates: others, searchPick: hit });
  }
  for (const ref of remoteRows) {
    if (q === "" || ref.name.toLowerCase().includes(q)) {
      rows.push({ ref, alternates: [], searchPick: null });
    }
  }
  // Current first, then other locals, then remotes — each keeping the recency
  // order the list arrived in.
  return [
    ...rows.filter((row) => row.ref.isCurrent),
    ...rows.filter((row) => !row.ref.isCurrent && !row.ref.isRemote),
    ...rows.filter((row) => !row.ref.isCurrent && row.ref.isRemote)
  ];
}
