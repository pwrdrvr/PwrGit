import type { ChangeRequestEntry, PrSummary } from "./types";

export type StackBranchHealth = {
  inSync: boolean;
  needsRestack: boolean;
  parentMerged: boolean;
  needsPush: boolean;
  drift: boolean;
  remoteAhead: boolean;
};

export type StackHealthFacts = {
  branch: string;
  parent: string;
  base?: string;
  catalogHead?: string;
  localHead?: string;
  parentHead?: string;
  remoteHead?: string;
  baseIsAncestor: boolean;
  remoteIsAncestor: boolean;
  localIsAncestorOfRemote: boolean;
  parentMerged: boolean;
  pr?: PrSummary;
};

export function stackBranchHealth(facts: StackHealthFacts): StackBranchHealth {
  const { parent, base, catalogHead, localHead, parentHead, remoteHead, pr } = facts;
  // The recorded remote head remains expected across our own branch rewrites.
  const knownRemote = remoteHead === pr?.headOid || remoteHead === catalogHead;
  return {
    inSync: Boolean(base && parentHead === base && facts.baseIsAncestor),
    needsRestack: Boolean(base && parentHead && parentHead !== base),
    parentMerged: facts.parentMerged,
    needsPush: Boolean(localHead && pr?.headOid && localHead !== pr.headOid && !facts.localIsAncestorOfRemote),
    drift: Boolean(pr?.baseRefName && pr.baseRefName !== parent),
    remoteAhead: facts.localIsAncestorOfRemote || Boolean(localHead && remoteHead && !knownRemote && !facts.remoteIsAncestor),
  };
}

export type StackLayer = {
  branch: string;
  parent: string;
  head?: string;
  base?: string;
  pr?: PrSummary;
  forgeRepo?: string;
  health: StackBranchHealth;
};

export type RepositoryStack = {
  id: string;
  source: "tracked" | "inferred";
  catalogRepository: string;
  trunk: { branch: string; head?: string };
  layers: StackLayer[];
};

export type StackSnapshot = {
  schemaVersion: number;
  readOnly: boolean;
  stacks: RepositoryStack[];
  busy?: string;
  recoveryAvailable?: boolean;
};

export type StackPosition = { stack: RepositoryStack; layer: StackLayer; index: number };

export function stackPosition(stacks: readonly RepositoryStack[], predicate: (layer: StackLayer) => boolean): StackPosition | undefined {
  for (const stack of stacks) {
    const index = stack.layers.findIndex(predicate);
    if (index !== -1) return { stack, index: index + 1, layer: stack.layers[index] };
  }
  return undefined;
}

/** A fork, gap, cycle, or duplicate head never gets an arbitrary stacked order. */
export function inferPullRequestStacks(entries: readonly ChangeRequestEntry[], tracked: ReadonlySet<string>): ChangeRequestEntry[][] {
  const groups = new Map<string, ChangeRequestEntry[]>();
  for (const entry of entries) {
    const { pr } = entry;
    if (pr.state !== "open" || !pr.headRefName || !pr.baseRefName || pr.headRepoPath) continue;
    const group = groups.get(entry.forgeRepo) ?? [];
    group.push(entry);
    groups.set(entry.forgeRepo, group);
  }
  const stacks: ChangeRequestEntry[][] = [];
  for (const [, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const byHead = new Map<string, ChangeRequestEntry[]>();
    const children = new Map<string, ChangeRequestEntry[]>();
    for (const entry of group) {
      const head = entry.pr.headRefName!;
      const base = entry.pr.baseRefName!;
      byHead.set(head, [...(byHead.get(head) ?? []), entry]);
      children.set(base, [...(children.get(base) ?? []), entry]);
    }
    const roots = group.filter(({ pr }) => !byHead.has(pr.baseRefName!))
      .toSorted((a, b) => a.pr.headRefName!.localeCompare(b.pr.headRefName!));
    for (const root of roots) {
      const chain: ChangeRequestEntry[] = [];
      const visited = new Set<string>();
      let member: ChangeRequestEntry | undefined = root;
      while (member) {
        const head: string = member.pr.headRefName!;
        const next: ChangeRequestEntry[] = children.get(head) ?? [];
        if (visited.has(head) || tracked.has(head) || byHead.get(head)?.length !== 1 || next.length > 1) break;
        chain.push(member);
        visited.add(head);
        member = next[0];
      }
      if (!member && chain.length > 1) stacks.push(chain);
    }
  }
  return stacks;
}

export type StackAction =
  | { kind: "restack"; from?: string }
  | { kind: "add_branch"; branch: string }
  | { kind: "adopt" }
  | { kind: "remove"; branch: string; mode: "detach" | "forget" };

export type StackPlanStep = {
  branch: string;
  parent: string;
  oldBase: string;
  newBase: string;
  oldTip: string;
  newTip?: string;
  proof?: { preserved: number; dropped: { commit: string; id: string }[] };
  conflict?: { commit: string; files: string[] };
  resolved?: boolean;
};

export type StackPlanPreview = {
  id: string;
  action: StackAction;
  steps: StackPlanStep[];
  moves: { branch: string; old: string | null; next: string | null }[];
  blocked: { path: string; files: string[] }[];
  cleanPrefix: boolean;
};

export type StackApplied = {
  operationId: string;
  plan: StackPlanPreview;
  checkoutWarning?: string;
  stack?: RepositoryStack;
};

export type StackConflict = {
  plan: StackPlanPreview;
  branch: string;
  worktreePath: string;
  worktreeId: string | null;
  phase: "resolving" | "resolved" | "aborted" | "unverified";
};
