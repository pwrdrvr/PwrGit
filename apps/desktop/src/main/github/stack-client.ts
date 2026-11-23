import type { GitHubStack, PrSummary } from "@pwrgit/shared";

const PER_PAGE = 100;
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
    if (typeof row.open !== "boolean" || typeof number !== "number" || !Number.isSafeInteger(number)
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
    return [{
      number, trunk, url: `${repoUrl}/stack/${number}`, members,
      ...(row.open ? {} : { closed: members.every(member => member.state === "merged") ? "merged" : "closed" }),
    }];
  });
}

/** GitHub's documented repository Stacks API. Failure leaves the PR list usable
 * and preserves the last verified stack result until the next list refresh. */
export async function fetchGitHubStacks(token: string, owner: string, name: string): Promise<GitHubStack[] | undefined> {
  const stacks = new Map<number, GitHubStack>();
  try {
    // The list has no state filter or guaranteed ordering. A fixed page limit
    // can hide open stacks as well as older closed ones.
    for (let page = 1; ; page += 1) {
      const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/stacks?per_page=${PER_PAGE}&page=${page}`;
      const response = await fetch(url, {
        headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": GITHUB_VERSION },
        signal: AbortSignal.timeout(5_000), redirect: "error",
      });
      if (!response.ok) return undefined;
      const body: unknown = await response.json();
      if (!Array.isArray(body)) return undefined;
      for (const stack of parseGitHubStacks(body, owner, name)) stacks.set(stack.number, stack);
      if (!response.headers.get("link")?.split(",").some(link => /;\s*rel="next"/.test(link))) break;
    }
    return [...stacks.values()];
  } catch {
    return undefined;
  }
}
