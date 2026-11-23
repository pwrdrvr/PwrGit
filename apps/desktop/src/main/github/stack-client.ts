import type { GitHubStack, PrSummary } from "@pwrgit/shared";

const PER_PAGE = 100;
const MAX_PAGES = 5;
const GITHUB_VERSION = "2026-03-10";

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

export function parseGitHubStacks(value: unknown, owner: string, name: string): GitHubStack[] {
  if (!Array.isArray(value)) return [];
  const repoUrl = `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  return value.flatMap(raw => {
    const row = record(raw);
    const trunk = record(row.base).ref;
    const number = row.number;
    if (row.open !== true || typeof number !== "number" || !Number.isSafeInteger(number)
        || number <= 0 || typeof trunk !== "string" || !trunk || !Array.isArray(row.pull_requests)) return [];
    const members: PrSummary[] = [];
    for (const rawPr of row.pull_requests) {
      const pr = record(rawPr);
      const head = record(pr.head);
      const base = record(pr.base);
      const prNumber = pr.number;
      const branch = head.ref;
      if (typeof prNumber !== "number" || !Number.isSafeInteger(prNumber) || prNumber <= 0
          || typeof branch !== "string" || !branch || (pr.state !== "open" && pr.state !== "closed")) return [];
      const mergedAt = typeof pr.merged_at === "string" ? Date.parse(pr.merged_at) : NaN;
      members.push({
        number: prNumber, url: `${repoUrl}/pull/${prNumber}`, title: typeof pr.title === "string" ? pr.title : branch,
        state: Number.isFinite(mergedAt) ? "merged" : pr.state, isDraft: pr.draft === true,
        forge: "github", host: "github.com", repoPath: `${owner}/${name}`, headRefName: branch,
        ...(typeof head.sha === "string" ? { headOid: head.sha } : {}),
        ...(typeof base.ref === "string" ? { baseRefName: base.ref } : {}),
        ...(Number.isFinite(mergedAt) ? { mergedAt } : {}),
      });
    }
    if (!members.length || new Set(members.map(pr => pr.headRefName)).size !== members.length ||
        new Set(members.map(pr => pr.number)).size !== members.length) return [];
    return [{ number, trunk, url: `${repoUrl}/stack/${number}`, members }];
  });
}

/** GitHub's documented repository Stacks API. Failure leaves the PR list usable
 * and preserves the last verified stack result until the next list refresh. */
export async function fetchGitHubStacks(token: string, owner: string, name: string): Promise<GitHubStack[] | undefined> {
  const stacks: GitHubStack[] = [];
  try {
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/stacks?per_page=${PER_PAGE}&page=${page}`;
      const response = await fetch(url, {
        headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": GITHUB_VERSION },
        signal: AbortSignal.timeout(5_000), redirect: "error",
      });
      if (!response.ok) return undefined;
      const body: unknown = await response.json();
      if (!Array.isArray(body)) return undefined;
      stacks.push(...parseGitHubStacks(body, owner, name));
      if (body.length < PER_PAGE) break;
    }
    return stacks;
  } catch {
    return undefined;
  }
}
