import type {
  MergeQueueEntryState,
  OpenChangeRequest,
  PrMergeQueue,
  PrSummary
} from "@pwrgit/shared";
import { toPrLifecycle } from "../types";

/**
 * GraphQL/REST shaping for GitLab merge requests.
 *
 * Two differences from the GitHub equivalent drive this file's shape:
 *
 * 1. GitLab batches natively. `mergeRequests(sourceBranches: [...])` takes a
 *    list, so one field replaces GitHub's ~50 aliases. The cost is that the
 *    response is a flat list rather than one node per alias, so grouping and
 *    negative caching are ours to do.
 * 2. `iid` arrives as a GraphQL String even though it is an integer, and
 *    `PrSummary.number` is a number — every read goes through `toNumber`.
 */

/**
 * `diffStatsSummary` is GitLab's equivalent of GitHub's additions/deletions/
 * changedFiles triple; `fileCount` is the field GitHub calls `changedFiles`.
 * `diffHeadSha` is GitHub's `headRefOid`: the head commit of the MR's latest
 * diff, which for a merged MR is the last commit it merged.
 */
const MR_FIELDS = `iid title webUrl state draft sourceBranch targetBranch
        diffHeadSha createdAt mergedAt closedAt commitCount
        diffStatsSummary { additions deletions fileCount }`;

/**
 * Merge trains. `mergeTrainCar` and `availableAutoMergeStrategies` are
 * GitLab Premium fields, absent from older and Community instances, which
 * refuse the whole document; `mr-client.ts` drops them per host after such a
 * refusal (`mergeTrain: false`).
 */
const MR_TRAIN_FIELDS = `autoMergeEnabled autoMergeStrategy availableAutoMergeStrategies
        detailedMergeStatus
        mergeTrainCar { status index pipeline { status } }`;

/** Whether a query carries `MR_TRAIN_FIELDS`. */
export type MrQueryOptions = { mergeTrain?: boolean };

function mrFields(options: MrQueryOptions): string {
  return options.mergeTrain === false ? MR_FIELDS : `${MR_FIELDS}\n        ${MR_TRAIN_FIELDS}`;
}

/**
 * A merge request as either transport reports it.
 *
 * GraphQL answers in camelCase; the REST commit-association endpoint
 * (`/repository/commits/:sha/merge_requests`, the only way to associate a
 * commit on GitLab) answers in snake_case for the same fields. Both spellings
 * are declared here and read through `either`, because a node reaching
 * `toSummary` may have come from either one.
 */
export type MrNode = {
  iid: string | number;
  title: string | null;
  state: string;
  draft: boolean | null;
  webUrl?: string | null;
  web_url?: string | null;
  sourceBranch?: string | null;
  source_branch?: string | null;
  targetBranch?: string | null;
  target_branch?: string | null;
  /**
   * The head commit. REST has no `diff_head_sha`; its merge request object
   * carries the same commit as plain `sha`.
   */
  diffHeadSha?: string | null;
  sha?: string | null;
  createdAt?: string | null;
  created_at?: string | null;
  mergedAt?: string | null;
  merged_at?: string | null;
  closedAt?: string | null;
  closed_at?: string | null;
  commitCount?: number | null;
  diffStatsSummary?: {
    additions?: number | null;
    deletions?: number | null;
    fileCount?: number | null;
  } | null;
  /** Asked for only where a head has to be located: the open list, a lookup. */
  sourceProject?: { fullPath?: string | null } | null;
  autoMergeEnabled?: boolean | null;
  autoMergeStrategy?: string | null;
  availableAutoMergeStrategies?: (string | null)[] | null;
  detailedMergeStatus?: string | null;
  mergeTrainCar?: {
    status?: string | null;
    index?: number | null;
    pipeline?: { status?: string | null } | null;
  } | null;
};

export type MrPage = { nodes: MrNode[]; endCursor: string | null; hasNextPage: boolean };

/** Nodes per request. GitLab rejects `first` above its 100-record page cap. */
export const MR_PAGE_SIZE = 100;

/**
 * One page of the merge requests whose source branch is any of `branches`.
 *
 * Sorted newest-first so a caller can stop paging as soon as every branch has
 * a match, instead of walking a busy project's entire MR history.
 */
export function buildMrBranchQuery(
  fullPath: string,
  branches: string[],
  after?: string | null,
  options: MrQueryOptions = {}
): { query: string; variables: Record<string, unknown> } {
  return {
    query: `query ($path: ID!, $branches: [String!], $first: Int!, $after: String) {
  project(fullPath: $path) {
    mergeRequests(sourceBranches: $branches, first: $first, after: $after, sort: CREATED_DESC) {
      nodes { ${mrFields(options)} }
      pageInfo { endCursor hasNextPage }
    }
  }
}`,
    variables: {
      path: fullPath,
      branches,
      first: MR_PAGE_SIZE,
      after: after ?? null
    }
  };
}

/** One page of the merge requests with these exact iids. */
export function buildMrNumberQuery(
  fullPath: string,
  numbers: number[],
  options: MrQueryOptions = {}
): { query: string; variables: Record<string, unknown> } {
  return {
    query: `query ($path: ID!, $iids: [String!], $first: Int!) {
  project(fullPath: $path) {
    mergeRequests(iids: $iids, first: $first) {
      nodes { ${mrFields(options)} sourceProject { fullPath } }
      pageInfo { endCursor hasNextPage }
    }
  }
}`,
    variables: {
      path: fullPath,
      iids: numbers.map((number) => String(number)),
      first: MR_PAGE_SIZE
    }
  };
}

/**
 * One page of the project's open merge requests, most recently updated first.
 *
 * `opened` excludes `locked` — a locked MR is still live (see `toPrLifecycle`),
 * but it takes no new work, which is what this list is for finding.
 */
export function buildOpenMrQuery(
  fullPath: string,
  after: string | null,
  options: MrQueryOptions = {}
): { query: string; variables: Record<string, unknown> } {
  return {
    query: `query ($path: ID!, $first: Int!, $after: String) {
  project(fullPath: $path) {
    mergeRequests(state: opened, first: $first, after: $after, sort: UPDATED_DESC) {
      nodes { ${mrFields(options)} updatedAt author { username } sourceProject { fullPath } }
      pageInfo { endCursor hasNextPage }
    }
  }
}`,
    variables: { path: fullPath, first: MR_PAGE_SIZE, after }
  };
}

type OpenMrNode = MrNode & {
  updatedAt?: string | null;
  author?: { username?: string | null } | null;
};

/**
 * The open list page, or null when the response resolved no project.
 *
 * Unlike a branch lookup, where a project nobody can see negative-caches as
 * intended, a null project here would replace the whole cached list with
 * nothing — so the caller treats it as the refusal it usually is.
 */
export function parseOpenMrPage(
  data: unknown,
  basePath: string
): { items: OpenChangeRequest[]; endCursor: string | null; hasNextPage: boolean } | null {
  const project = (data as { project?: unknown } | null)?.project;
  if (typeof project !== "object" || project === null) return null;
  const page = parseMrPage(data);
  const items = page.nodes.map((node): OpenChangeRequest => {
    const open = node as OpenMrNode;
    const summary: OpenChangeRequest = { ...toSummary(open) };
    const author = open.author?.username?.trim();
    if (author !== undefined && author !== "") summary.author = author;
    const fork = mrForkPath(open, basePath);
    if (fork !== undefined) summary.headRepoPath = fork;
    const updated = typeof open.updatedAt === "string" ? Date.parse(open.updatedAt) : NaN;
    if (Number.isFinite(updated)) summary.updatedAt = updated;
    return summary;
  });
  return { items: items.filter((item) => item.number > 0), endCursor: page.endCursor, hasNextPage: page.hasNextPage };
}

/**
 * A merge request's source project when it is not the target — a fork. One
 * GitLab will not name (deleted, or private to this token) is left as "the
 * same project", since that is the only one whose branches a checkout could
 * see anyway.
 */
export function mrForkPath(
  node: { sourceProject?: { fullPath?: string | null } | null },
  basePath: string
): string | undefined {
  const source = node.sourceProject?.fullPath?.trim();
  return source !== undefined &&
    source !== "" &&
    source.toLowerCase() !== basePath.toLowerCase()
    ? source
    : undefined;
}

/** Pull the merge-request page out of a GraphQL response, tolerating nulls. */
export function parseMrPage(data: unknown): MrPage {
  const connection = (
    data as {
      project?: {
        mergeRequests?: {
          nodes?: (MrNode | null)[] | null;
          pageInfo?: { endCursor?: string | null; hasNextPage?: boolean | null };
        } | null;
      } | null;
    } | null
  )?.project?.mergeRequests;
  return {
    nodes: (connection?.nodes ?? []).filter((node): node is MrNode => node != null),
    endCursor: connection?.pageInfo?.endCursor ?? null,
    hasNextPage: connection?.pageInfo?.hasNextPage === true
  };
}

/**
 * Pick one merge request per source branch: a live one first, then the newest.
 *
 * Mirrors the GitHub side's preference so a branch reopened after a closed
 * attempt reports the live MR rather than the historical one.
 */
export function pickBestByBranch(nodes: MrNode[]): Map<string, MrSummaryWithBranch> {
  const best = new Map<string, MrSummaryWithBranch>();
  for (const node of nodes) {
    const branch = sourceBranchOf(node)?.trim();
    if (branch === undefined || branch === "") continue;
    const candidate = { branch, summary: toSummary(node) };
    const current = best.get(branch);
    if (current === undefined || prefers(candidate.summary, current.summary)) {
      best.set(branch, candidate);
    }
  }
  return best;
}

export type MrSummaryWithBranch = { branch: string; summary: PrSummary };

function prefers(candidate: PrSummary, current: PrSummary): boolean {
  const candidateLive = candidate.state === "open" ? 1 : 0;
  const currentLive = current.state === "open" ? 1 : 0;
  if (candidateLive !== currentLive) return candidateLive > currentLive;
  return candidate.number > current.number;
}

/** Best merge request associated with one commit, from the REST association. */
export function pickBestAssociation(nodes: MrNode[]): PrSummary | null {
  const summaries = nodes.map(toSummary);
  const best = summaries.reduce<PrSummary | null>(
    (winner, summary) =>
      winner === null || prefers(summary, winner) ? summary : winner,
    null
  );
  return best;
}

export function toSummary(node: MrNode): PrSummary {
  return {
    number: toNumber(node.iid),
    url: either(node.webUrl, node.web_url) ?? "",
    title: node.title ?? "",
    state: toPrLifecycle(node.state),
    // GitLab exposes draft as a boolean; the legacy `WIP:` title prefix is
    // reflected in that same field, so the title never needs parsing.
    isDraft: node.draft === true,
    ...optionalText("headRefName", sourceBranchOf(node)),
    ...optionalText("baseRefName", either(node.targetBranch, node.target_branch)),
    ...optionalText("headOid", either(node.diffHeadSha, node.sha)),
    ...optionalCount("additions", node.diffStatsSummary?.additions),
    ...optionalCount("deletions", node.diffStatsSummary?.deletions),
    ...optionalCount("changedFiles", node.diffStatsSummary?.fileCount),
    ...optionalCount("commitCount", node.commitCount),
    ...optionalTime("createdAt", either(node.createdAt, node.created_at)),
    ...optionalTime("mergedAt", either(node.mergedAt, node.merged_at)),
    ...optionalTime("closedAt", either(node.closedAt, node.closed_at)),
    ...mergeTrainSummary(node)
  };
}

/** Strategies GitLab offers only on a project that uses merge trains. */
const TRAIN_STRATEGY = /merge_train/i;

/**
 * A merge train car's status, read as GitHub's entry states. `FRESH` means
 * the car's train pipeline is current, so its pipeline decides: still
 * running is the merge group's checks running.
 */
function carState(car: NonNullable<MrNode["mergeTrainCar"]>): MergeQueueEntryState {
  switch ((car.status ?? "").toUpperCase()) {
    case "MERGING":
      return "locked";
    case "FRESH": {
      const pipeline = (car.pipeline?.status ?? "").toUpperCase();
      if (pipeline === "SUCCESS") return "mergeable";
      if (pipeline === "FAILED" || pipeline === "CANCELED") return "unmergeable";
      return "awaiting_checks";
    }
    default:
      // IDLE (no pipeline yet) and STALE (re-running behind a change ahead).
      return "queued";
  }
}

/**
 * GitLab's merge-train fields as a `PrMergeQueue`; nothing when the query did
 * not ask for them (REST, or an instance without merge trains).
 *
 * GitLab keeps no queryable removal reason on the MR (it writes a system
 * note), so a GitLab MR is never reported `removed`, only "not in the train".
 * A car that merged is `merged_by_queue`; `SKIP_MERGED` skipped the train, so
 * it is a plain merge.
 */
export function mergeTrainSummary(node: MrNode): { mergeQueue?: PrMergeQueue } {
  if (node.mergeTrainCar === undefined && node.availableAutoMergeStrategies === undefined) return {};
  const car = node.mergeTrainCar ?? null;
  const strategies = (node.availableAutoMergeStrategies ?? []).filter(
    (value): value is string => typeof value === "string"
  );
  const carStatus = (car?.status ?? "").toUpperCase();
  const required = car !== null || strategies.some((value) => TRAIN_STRATEGY.test(value)) ||
    TRAIN_STRATEGY.test(node.autoMergeStrategy ?? "");
  const detailed = (node.detailedMergeStatus ?? "").toUpperCase();
  const inTrain = car !== null && carStatus !== "MERGED" && carStatus !== "SKIP_MERGED";
  return {
    mergeQueue: {
      required,
      ...(inTrain ? {
        entry: {
          state: carState(car),
          // `index` counts from 0 at the front of the train.
          ...(typeof car.index === "number" && car.index >= 0 ? { position: car.index + 1 } : {})
        }
      } : {}),
      ...(carStatus === "MERGED" ? { lastEvent: { kind: "added" as const } } : {}),
      // Anything but MERGEABLE blocks, the unsettled CHECKING/UNCHECKED/
      // PREPARING included: a GitLab summary has no check state to fall back
      // on, so reading those as unblocked offered "Add to merge train" right
      // after every push.
      ...(detailed === "" ? {} : { blocked: detailed !== "MERGEABLE" })
    }
  };
}

/** The source branch under whichever spelling this node's transport used. */
function sourceBranchOf(node: MrNode): string | null | undefined {
  return either(node.sourceBranch, node.source_branch);
}

/** GraphQL's camelCase wins when present; REST's snake_case is the fallback. */
function either<T>(
  camel: T | null | undefined,
  snake: T | null | undefined
): T | null | undefined {
  return camel ?? snake;
}

/**
 * Absent stays absent. A missing count is "not known", which is a different
 * claim from zero, and the hover card renders nothing rather than a false 0.
 */
function optionalCount(
  key: string,
  value: number | null | undefined
): Record<string, number> {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? { [key]: value }
    : {};
}

function optionalText(
  key: string,
  value: string | null | undefined
): Record<string, string> {
  const text = typeof value === "string" ? value.trim() : "";
  return text === "" ? {} : { [key]: text };
}

function optionalTime(
  key: string,
  value: string | null | undefined
): Record<string, number> {
  if (typeof value !== "string") return {};
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? { [key]: parsed } : {};
}

/** GraphQL sends `iid` as a String; REST sends it as a number. */
function toNumber(iid: string | number): number {
  const parsed = typeof iid === "number" ? iid : Number.parseInt(iid, 10);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}
