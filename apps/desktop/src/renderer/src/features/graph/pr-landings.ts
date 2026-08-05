import type { Commit, PrSummary } from "@pwrgit/shared";
import type { LaneLayout, LaneSeg } from "./lane-layout";

export type PrLandingLink = {
  number: number;
  landingHash: string;
  sourceHash: string;
};

export type PrLandingSeg = LaneSeg & { number: number };

export type PrLandingRows = {
  laneCount: number;
  rows: Array<{ top: PrLandingSeg[]; bottom: PrLandingSeg[] }>;
};

/** True when `target` is reachable from `start` through real Git parents. */
function reaches(
  commits: Map<string, Commit>,
  start: string,
  target: string
): boolean {
  const pending = [start];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const hash = pending.pop() as string;
    if (hash === target) return true;
    if (seen.has(hash)) continue;
    seen.add(hash);
    const commit = commits.get(hash);
    if (commit !== undefined) pending.push(...commit.parents);
  }
  return false;
}

/** Commits on the default branch's first-parent spine, newest first. */
function defaultSpine(
  commits: Map<string, Commit>,
  tips: Record<string, string[]>,
  defaultBranch: string,
  defaultRefTips: string[]
): string[] {
  const localTip = Object.entries(tips).find(([, names]) =>
    names.includes(defaultBranch)
  )?.[0];
  const candidates = new Set(defaultRefTips.filter((hash) => commits.has(hash)));
  let tip: string | undefined;
  if (candidates.size > 0) {
    const localInWindow = localTip !== undefined && commits.has(localTip);
    // Map insertion order is the graph's topological order, matching the lane
    // owner's resolved-default-spine selection.
    for (const hash of commits.keys()) {
      if (!candidates.has(hash)) continue;
      if (!localInWindow || reaches(commits, hash, localTip as string)) {
        tip = hash;
        break;
      }
    }
  }
  tip ??= localTip;
  if (tip === undefined) return [];
  const spine: string[] = [];
  let hash: string | undefined = tip;
  while (hash !== undefined) {
    const commit = commits.get(hash);
    if (commit === undefined) break;
    spine.push(hash);
    hash = commit.parents[0];
  }
  return spine;
}

/**
 * Find merged PRs whose source tip and default-branch landing are both drawn,
 * but are not connected by real Git ancestry. This is the observable shape of
 * a squash/rebase merge. The result is deliberately presentation metadata;
 * callers must never append these links to a commit's `parents`.
 */
export function findPrLandingLinks(
  commits: Commit[],
  tips: Record<string, string[]>,
  defaultBranch: string,
  defaultRefTips: string[],
  prs: Record<string, PrSummary | null>
): PrLandingLink[] {
  const byHash = new Map(commits.map((commit) => [commit.hash, commit]));
  const spine = defaultSpine(byHash, tips, defaultBranch, defaultRefTips);
  const landingByPr = new Map<number, string>();
  for (const hash of spine) {
    const pr = prs[hash];
    if (pr?.state === "merged" && !landingByPr.has(pr.number)) {
      landingByPr.set(pr.number, hash);
    }
  }

  const links: PrLandingLink[] = [];
  const linkedPrs = new Set<number>();
  // Topological commit order makes the newest drawn tip win if stale alias
  // branches happen to point at more than one commit from the same PR.
  for (const { hash: sourceHash } of commits) {
    const names = tips[sourceHash] ?? [];
    if (names.length === 0) continue;
    if (names.every((name) => name === defaultBranch)) continue;
    const pr = prs[sourceHash];
    if (pr?.state !== "merged") continue;
    if (linkedPrs.has(pr.number)) continue;
    const landingHash = landingByPr.get(pr.number);
    if (
      landingHash === undefined ||
      landingHash === sourceHash ||
      reaches(byHash, landingHash, sourceHash)
    ) {
      continue;
    }
    linkedPrs.add(pr.number);
    links.push({ number: pr.number, landingHash, sourceHash });
  }
  return links;
}

/**
 * Route each semantic landing through a temporary dotted rail. Segmenting it
 * per row lets the existing clipped/pannable gutter render it without a second
 * graph coordinate system.
 */
export function layoutPrLandingLinks(
  links: PrLandingLink[],
  commits: Commit[],
  layout: LaneLayout
): PrLandingRows {
  const rows = commits.map(() => ({
    top: [] as PrLandingSeg[],
    bottom: [] as PrLandingSeg[]
  }));
  const index = new Map(commits.map((commit, i) => [commit.hash, i]));
  let used = 0;

  for (const link of links) {
    const landingIndex = index.get(link.landingHash);
    const sourceIndex = index.get(link.sourceHash);
    if (landingIndex === undefined || sourceIndex === undefined) continue;
    if (landingIndex === sourceIndex) continue;

    const startIndex = Math.min(landingIndex, sourceIndex);
    const endIndex = Math.max(landingIndex, sourceIndex);
    const startLane = layout.rows[startIndex]?.lane;
    const endLane = layout.rows[endIndex]?.lane;
    if (startLane === undefined || endLane === undefined) continue;

    // Adjacent commits have no intervening history to route around. Meet at a
    // midpoint between their lanes so the two half-row curves form one direct,
    // smooth connector without widening the gutter for a temporary rail.
    if (endIndex === startIndex + 1) {
      const junction = (startLane + endLane) / 2;
      rows[startIndex]?.bottom.push({
        from: startLane,
        to: junction,
        number: link.number
      });
      rows[endIndex]?.top.push({
        from: junction,
        to: endLane,
        number: link.number
      });
      continue;
    }

    const rail = layout.laneCount + used;
    used += 1;
    rows[startIndex]?.bottom.push({
      from: startLane,
      to: rail,
      number: link.number
    });
    for (let row = startIndex + 1; row < endIndex; row += 1) {
      rows[row]?.top.push({ from: rail, to: rail, number: link.number });
      rows[row]?.bottom.push({ from: rail, to: rail, number: link.number });
    }
    rows[endIndex]?.top.push({
      from: rail,
      to: endLane,
      number: link.number
    });
  }

  return { laneCount: layout.laneCount + used, rows };
}
