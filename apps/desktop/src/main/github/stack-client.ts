import type { GitHubStack, PrSummary } from "@pwrgit/shared";
import { forgeRetryWindow } from "../forge/retry";

const PER_PAGE = 100;
const GITHUB_VERSION = "2026-03-10";
const API_ORIGIN = "https://api.github.com";

type StackPage = {
  stacks: GitHubStack[];
  etag: string | null;
  next: string | undefined;
};

export type GitHubStackHistory = {
  stacks: GitHubStack[];
  pages: ReadonlyMap<string, StackPage>;
};

export class StackHistoryResponseError extends Error {
  readonly retryAfterMs: number;

  constructor(response: Response) {
    super(`GitHub Stacks request returned HTTP ${response.status}.`);
    this.retryAfterMs = forgeRetryWindow({
      kind: "github", status: response.status, header: name => response.headers.get(name),
    })?.ms ?? 0;
  }
}

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

/** A complete walk of GitHub's repository Stacks API, including closed stacks.
 * Validators and pagination belong to each page, so a 304 on page one still
 * leads to revalidation of older pages. The caller commits the walk atomically. */
export async function fetchGitHubStacks(
  token: string, owner: string, name: string, previous?: GitHubStackHistory, signal?: AbortSignal,
): Promise<GitHubStackHistory> {
  const pages = new Map<string, StackPage>();
  const stacks = new Map<number, GitHubStack>();
  let url: string | undefined = `${API_ORIGIN}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/stacks?per_page=${PER_PAGE}&page=1`;
  while (url !== undefined) {
    signal?.throwIfAborted();
    if (pages.has(url)) throw new Error("GitHub Stacks repeated a page.");
    const cached = previous?.pages.get(url);
    const timeout = AbortSignal.timeout(5_000);
    const response = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": GITHUB_VERSION,
        ...(cached?.etag ? { "If-None-Match": cached.etag } : {}),
      },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      redirect: "error",
    });
    const link = response.headers.get("link");
    const etag = response.headers.get("etag");
    let page: StackPage;
    if (response.status === 304 && cached?.etag) {
      page = link === null && etag === null ? cached : {
        ...cached, etag: etag ?? cached.etag, next: link === null ? cached.next : nextPage(link, url),
      };
    } else {
      if (!response.ok) throw new StackHistoryResponseError(response);
      const body: unknown = await response.json();
      if (!Array.isArray(body)) throw new Error("GitHub Stacks returned an invalid list.");
      page = { stacks: parseGitHubStacks(body, owner, name), etag, next: nextPage(link, url) };
    }
    pages.set(url, page);
    for (const stack of page.stacks) stacks.set(stack.number, stack);
    url = page.next;
  }
  return { stacks: [...stacks.values()], pages };
}

function nextPage(link: string | null, current: string): string | undefined {
  const next = link?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
  if (!next) return undefined;
  const url = new URL(next, current);
  if (url.origin !== API_ORIGIN || url.username || url.password) {
    throw new Error("GitHub Stacks returned a pagination link outside its API.");
  }
  return url.href;
}
