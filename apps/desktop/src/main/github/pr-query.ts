import type { PrLifecycle, PrSummary } from "@pwrgit/shared";

/**
 * Fields every PR read shares. The tail beyond `isDraft` feeds the hover card;
 * all of it is optional downstream, because a PR that reached a terminal state
 * before this shipped stops being refreshed and will never gain them.
 */
const PR_NODE_FIELDS = `number title url state isDraft mergeable headRefName baseRefName
      additions deletions changedFiles commits(last: 1) {
        totalCount
        nodes { commit { statusCheckRollup {
          state
          contexts(first: 0) {
            checkRunCountsByState { state count }
            statusContextCountsByState { state count }
          }
        } } }
      }
      createdAt mergedAt closedAt`;
const PR_FIELDS = `nodes { ${PR_NODE_FIELDS} }`;

type PrNode = {
  number: number;
  title: string | null;
  url: string;
  state: string;
  isDraft: boolean;
  mergeable?: string | null;
  headRefName?: string | null;
  baseRefName?: string | null;
  additions?: number | null;
  deletions?: number | null;
  changedFiles?: number | null;
  commits?: {
    totalCount?: number | null;
    nodes?: { commit?: { statusCheckRollup?: CheckRollup | null } }[];
  } | null;
  createdAt?: string | null;
  mergedAt?: string | null;
  closedAt?: string | null;
};

/**
 * One GraphQL query asking for many branches at once: an aliased
 * `pullRequests(headRefName: $bN)` field per branch. Branch names are passed as
 * variables (never interpolated), and `headRefName` matches by name — so it
 * still finds PRs whose branch was deleted after a squash/merge. Batch callers
 * to a safe alias count (~50) to stay under GraphQL cost limits.
 */
export function buildPrQuery(
  owner: string,
  repo: string,
  branches: string[]
): { query: string; variables: Record<string, string> } {
  const variables: Record<string, string> = { owner, name: repo };
  const decls = ["$owner: String!", "$name: String!"];
  const aliases: string[] = [];
  branches.forEach((branch, i) => {
    variables[`b${i}`] = branch;
    decls.push(`$b${i}: String!`);
    aliases.push(
      `a${i}: pullRequests(headRefName: $b${i}, first: 1, ` +
        `orderBy: { field: CREATED_AT, direction: DESC }, ` +
        `states: [OPEN, MERGED, CLOSED]) { ${PR_FIELDS} }`
    );
  });
  const query = `query (${decls.join(", ")}) {
  repository(owner: $owner, name: $name) {
    ${aliases.join("\n    ")}
  }
}`;
  return { query, variables };
}

/**
 * Did the response actually resolve the repository every alias hangs off?
 *
 * GraphQL nulls the erroring *field*, not the document, so a refusal — SAML
 * enforcement, a revoked scope, an IP allow-list, a spent budget — answers 200
 * with `{"data":{"repository":null},"errors":[…]}`, exactly as a deleted repo
 * does. The parsers below cannot tell those apart from "this repo has no pull
 * requests": both leave every alias null. Ask this first, and treat a null
 * container as "nothing was learned" rather than as an answer about branches.
 */
export function repositoryResolved(data: unknown): boolean {
  const repository = (data as { repository?: unknown } | null | undefined)
    ?.repository;
  return typeof repository === "object" && repository !== null;
}

/** Map a GraphQL response back to branch → PrSummary (null = no PR found). */
export function parsePrResponse(
  branches: string[],
  data: unknown
): Map<string, PrSummary | null> {
  const repo =
    (data as { repository?: Record<string, { nodes?: PrNode[] }> } | null)
      ?.repository ?? {};
  const out = new Map<string, PrSummary | null>();
  branches.forEach((branch, i) => {
    const node = repo[`a${i}`]?.nodes?.[0];
    out.set(branch, node ? toSummary(node) : null);
  });
  return out;
}

function toSummary(node: PrNode): PrSummary {
  const state: PrLifecycle =
    node.state === "MERGED"
      ? "merged"
      : node.state === "CLOSED"
        ? "closed"
        : "open";
  return {
    number: node.number,
    url: node.url,
    title: node.title ?? "",
    state,
    isDraft: Boolean(node.isDraft),
    ...checkSummary(node.commits?.nodes?.[0]?.commit?.statusCheckRollup),
    ...(node.mergeable === undefined ? {} : {
      mergeState: node.mergeable === "CONFLICTING" ? "conflicting" as const
        : node.mergeable === "MERGEABLE" ? "mergeable" as const : "unknown" as const
    }),
    ...optionalText("headRefName", node.headRefName),
    ...optionalText("baseRefName", node.baseRefName),
    ...optionalCount("additions", node.additions),
    ...optionalCount("deletions", node.deletions),
    ...optionalCount("changedFiles", node.changedFiles),
    ...optionalCount("commitCount", node.commits?.totalCount),
    ...optionalTime("createdAt", node.createdAt),
    ...optionalTime("mergedAt", node.mergedAt),
    ...optionalTime("closedAt", node.closedAt)
  };
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

/** One GraphQL query asking for the PR associated with many exact commit SHAs. */
export function buildCommitPrQuery(
  owner: string,
  repo: string,
  commitHashes: string[]
): { query: string; variables: Record<string, string> } {
  const variables: Record<string, string> = { owner, name: repo };
  const decls = ["$owner: String!", "$name: String!"];
  const aliases: string[] = [];
  commitHashes.forEach((hash, i) => {
    variables[`c${i}`] = hash;
    decls.push(`$c${i}: GitObjectID!`);
    aliases.push(
      `c${i}: object(oid: $c${i}) { ... on Commit { ` +
        `associatedPullRequests(first: 10) { ${PR_FIELDS} } } }`
    );
  });
  const query = `query (${decls.join(", ")}) {
  repository(owner: $owner, name: $name) {
    ${aliases.join("\n    ")}
  }
}`;
  return { query, variables };
}

/** Map exact commit SHA → best associated PR (live first, newest otherwise). */
export function parseCommitPrResponse(
  commitHashes: string[],
  data: unknown
): Map<string, PrSummary | null> {
  const repo =
    (data as {
      repository?: Record<
        string,
        { associatedPullRequests?: { nodes?: PrNode[] } }
      >;
    } | null)?.repository ?? {};
  const out = new Map<string, PrSummary | null>();
  commitHashes.forEach((hash, i) => {
    const nodes = repo[`c${i}`]?.associatedPullRequests?.nodes ?? [];
    const node = [...nodes].sort((left, right) => {
      const leftLive = left.state === "OPEN" ? 1 : 0;
      const rightLive = right.state === "OPEN" ? 1 : 0;
      return rightLive - leftLive || right.number - left.number;
    })[0];
    out.set(hash, node === undefined ? null : toSummary(node));
  });
  return out;
}

/** One aliased query for the current status of exact PR numbers. */
export function buildPrNumberQuery(
  owner: string,
  repo: string,
  numbers: number[]
): { query: string; variables: Record<string, string | number> } {
  const variables: Record<string, string | number> = { owner, name: repo };
  const decls = ["$owner: String!", "$name: String!"];
  const aliases: string[] = [];
  numbers.forEach((number, i) => {
    variables[`n${i}`] = number;
    decls.push(`$n${i}: Int!`);
    aliases.push(`n${i}: pullRequest(number: $n${i}) { ${PR_NODE_FIELDS} }`);
  });
  const query = `query (${decls.join(", ")}) {
  repository(owner: $owner, name: $name) {
    ${aliases.join("\n    ")}
  }
}`;
  return { query, variables };
}

/** Map PR number → current status (null only if GitHub returned no node). */
export function parsePrNumberResponse(
  numbers: number[],
  data: unknown
): Map<number, PrSummary | null> {
  const repo =
    (data as { repository?: Record<string, PrNode | null> } | null)?.repository ?? {};
  return new Map(numbers.map((number, i) => {
    const node = repo[`n${i}`];
    return [number, node == null ? null : toSummary(node)] as const;
  }));
}


type CheckRollup = {
  state?: string;
  contexts?: {
    checkRunCountsByState?: { state: string; count: number }[] | null;
    statusContextCountsByState?: { state: string; count: number }[] | null;
  };
};

/** Aggregate counts cover every check without paging hundreds of jobs per PR.
 * Failure wins over pending, while the independent running flag keeps the pulse. */
function checkSummary(rollup: CheckRollup | null | undefined): Partial<PrSummary> {
  if (rollup === undefined) return {};
  const counts = [
    ...(rollup?.contexts?.checkRunCountsByState ?? []),
    ...(rollup?.contexts?.statusContextCountsByState ?? [])
  ].filter(({ count }) => count > 0);
  const failing = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"]);
  const running = new Set(["PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED"]);
  const checksStillRunning = counts.some(({ state }) => running.has(state)) || running.has(rollup?.state ?? "");
  const hasFailure = counts.some(({ state }) => failing.has(state)) || failing.has(rollup?.state ?? "");
  return {
    checkState: hasFailure ? "failing" : checksStillRunning ? "pending"
      : rollup?.state === "SUCCESS" ? "passing" : "unknown",
    checksStillRunning
  };
}
