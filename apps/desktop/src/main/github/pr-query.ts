import type { PrLifecycle, PrSummary } from "@pwrgit/shared";

const PR_FIELDS = "nodes { number title url state isDraft }";

type PrNode = {
  number: number;
  title: string | null;
  url: string;
  state: string;
  isDraft: boolean;
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
    isDraft: Boolean(node.isDraft)
  };
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
    aliases.push(`n${i}: pullRequest(number: $n${i}) { number title url state isDraft }`);
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
