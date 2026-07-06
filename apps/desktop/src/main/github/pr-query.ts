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
