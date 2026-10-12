import {
  aggregateContributions,
  contributionRows,
  type ContributionIdentity,
  type ContributionOptions,
  type ContributionRecord,
  type ContributionRepo,
  type ContributionWindow
} from "./contributions";

/**
 * The picture a user copies out of Contributions, with the names they chose.
 *
 * Names are resolved HERE, before anything is drawn, so a masked org's login
 * and its repositories' names never reach the renderer's image code at all.
 * Series keys stay node IDs (opaque), and nothing that draws reads them.
 */
export type ContributionShareGroup = "org" | "repo" | "none";
export type ContributionShareNameMode = "show" | "mask";
export type ContributionShareNames = Readonly<
  Record<string, ContributionShareNameMode>
>;

/** Readable stacks in a pasted image: eight series, then Other. */
export const CONTRIBUTION_SHARE_TOP_N = 8;

export type ContributionShareOwner = {
  ownerId: string;
  owner: string;
  kind: ContributionRepo["ownerKind"];
  /** The viewer's own personal namespace. */
  viewer: boolean;
  total: number;
};
export type ContributionShareSeries = {
  key: string;
  label: string;
  total: number;
  other?: true;
};
export type ContributionShareChart = {
  series: ContributionShareSeries[];
  /** `values[i]` is `series[i]`'s count in this bucket. */
  buckets: { date: string; total: number; values: number[] }[];
};

/** Every namespace with a PR in the current measure and filters, busiest first. */
export function contributionShareOwners(
  records: ContributionRecord[],
  identity: ContributionIdentity,
  window: ContributionWindow,
  options: ContributionOptions = {}
): ContributionShareOwner[] {
  const owners = new Map<string, ContributionShareOwner>();
  for (const row of contributionRows(records, identity.id, window, options)) {
    const { ownerId, owner, ownerKind } = row.repo;
    const entry = owners.get(ownerId) ?? {
      ownerId,
      owner,
      kind: ownerKind,
      viewer: ownerKind === "user" && owner === identity.login,
      total: 0
    };
    entry.total++;
    owners.set(ownerId, entry);
  }
  return [...owners.values()].sort(
    (a, b) => b.total - a.total || a.owner.localeCompare(b.owner)
  );
}

/**
 * Masked unless it is the viewer's own personal namespace. A reflexive Copy
 * must not put an employer's name on someone's timeline; showing one is a
 * choice the user makes per org, and the screen remembers it.
 */
export function defaultShareNameMode(
  owner: ContributionShareOwner
): ContributionShareNameMode {
  return owner.viewer ? "show" : "mask";
}

/** The label each owner gets in the image. Masks are lettered by volume. */
export function contributionShareOwnerLabels(
  owners: readonly ContributionShareOwner[],
  names: ContributionShareNames
): Map<string, string> {
  const labels = new Map<string, string>();
  let orgs = 0;
  let users = 0;
  for (const owner of owners) {
    const mode = names[owner.ownerId] ?? defaultShareNameMode(owner);
    if (mode === "show") {
      labels.set(
        owner.ownerId,
        owner.viewer ? `personal:${owner.owner}` : owner.owner
      );
    } else if (owner.viewer) {
      labels.set(owner.ownerId, "Personal");
    } else if (owner.kind === "user") {
      labels.set(owner.ownerId, `User ${letter(users++)}`);
    } else {
      labels.set(owner.ownerId, `Org ${letter(orgs++)}`);
    }
  }
  return labels;
}

/** A, B, … Z, AA, AB, … so a 27th masked org still gets a distinct name. */
function letter(index: number): string {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  }
  return name;
}

export function contributionShareChart(
  records: ContributionRecord[],
  identity: ContributionIdentity,
  window: ContributionWindow,
  options: ContributionOptions,
  group: ContributionShareGroup,
  names: ContributionShareNames
): ContributionShareChart {
  const aggregate = aggregateContributions(records, identity.id, window, {
    ...options,
    group: group === "repo" ? "repo" : "org",
    topN: CONTRIBUTION_SHARE_TOP_N
  });
  if (group === "none") {
    return {
      series: [
        { key: "__total", label: "Pull requests", total: aggregate.total }
      ],
      buckets: aggregate.buckets.map((bucket) => ({
        date: bucket.date,
        total: bucket.total,
        values: [bucket.total]
      }))
    };
  }

  const owners = contributionShareOwners(records, identity, window, options);
  const ownerLabels = contributionShareOwnerLabels(owners, names);
  const masked = (ownerId: string): boolean => {
    const owner = owners.find((candidate) => candidate.ownerId === ownerId);
    return (
      owner !== undefined &&
      (names[ownerId] ?? defaultShareNameMode(owner)) === "mask"
    );
  };

  // Repo labels: a masked owner's repositories are numbered by volume among
  // ALL of that owner's repositories, not just the ones that made the top 8.
  const repoLabels = new Map<string, string>();
  if (group === "repo") {
    const repos = new Map(
      records.map((record) => [record.repo.id, record.repo])
    );
    const rank = new Map<string, number>();
    for (const { key } of aggregate.totals) {
      const repo = repos.get(key);
      if (repo === undefined) continue;
      const ownerLabel = ownerLabels.get(repo.ownerId) ?? "Other";
      if (!masked(repo.ownerId)) {
        repoLabels.set(key, repo.path);
        continue;
      }
      const n = (rank.get(repo.ownerId) ?? 0) + 1;
      rank.set(repo.ownerId, n);
      repoLabels.set(key, `${ownerLabel}/repo ${n}`);
    }
  }

  const series: ContributionShareSeries[] = aggregate.series.map((entry) => {
    if (entry.key === "__other") {
      return {
        key: entry.key,
        label: "Other",
        total: entry.total,
        other: true
      };
    }
    const label =
      group === "repo" ? repoLabels.get(entry.key) : ownerLabels.get(entry.key);
    // A series with no resolvable owner is drawn without a name, never with
    // the aggregate's label, which is the raw login or path.
    return { key: entry.key, label: label ?? "Unknown", total: entry.total };
  });
  return {
    series,
    buckets: aggregate.buckets.map((bucket) => ({
      date: bucket.date,
      total: bucket.total,
      values: series.map((entry) => bucket.values[entry.key] ?? 0)
    }))
  };
}
