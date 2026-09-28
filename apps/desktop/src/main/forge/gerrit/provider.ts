import { gerritPatchSet, gerritReviewUrl, type OpenChangeRequest, type PrSummary } from "@pwrgit/shared";
import { OPEN_PR_LIST_CAP, type ForgeRepo, type PublicForgeProvider } from "../types";
import { mapLimit } from "../../util/map-limit";
import { gerritGet, type GerritGet } from "./client";

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Gerrit change response.");
  return value as Record<string, unknown>;
}
function timestamp(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(`${value.replace(" ", "T").replace(/(\.\d{3})\d+$/, "$1")}Z`);
  return Number.isFinite(ms) ? ms : undefined;
}

/** Gerrit's branch is the TARGET; only the immutable patch-set ref is a head. */
export function gerritChange(value: unknown, repo: ForgeRepo): OpenChangeRequest {
  const row = object(value);
  const number = row._number;
  if (!Number.isSafeInteger(number) || (number as number) <= 0 || row.project !== repo.path || typeof row.subject !== "string" || !["NEW", "MERGED", "ABANDONED"].includes(String(row.status))) {
    throw new Error("Gerrit returned an invalid change identity or state.");
  }
  const n = number as number;
  const revision = typeof row.current_revision === "string" ? object(object(row.revisions)[row.current_revision]) : undefined;
  const ref = typeof revision?.ref === "string" ? revision.ref : undefined;
  if (ref !== undefined && gerritPatchSet(ref, n) === null) throw new Error("Gerrit returned an invalid patch-set ref.");
  const author = row.owner === undefined ? undefined : object(row.owner);
  const state = row.status === "MERGED" ? "merged" : row.status === "ABANDONED" ? "closed" : "open";
  const createdAt = timestamp(row.created);
  const updatedAt = timestamp(row.updated);
  const mergedAt = timestamp(row.submitted);
  return {
    number: n, title: row.subject, state, isDraft: row.work_in_progress === true,
    url: `${gerritReviewUrl(repo.host, repo.reviewUrl, repo.port)}/c/${repo.path.split("/").map(encodeURIComponent).join("/")}/+/${n}`,
    forge: "gerrit", host: repo.host, repoPath: repo.path,
    ...(ref === undefined ? {} : { headRefName: ref }),
    ...(typeof row.branch === "string" ? { baseRefName: row.branch } : {}),
    ...(typeof author?.username === "string" ? { author: author.username } : {}),
    ...(typeof row.insertions === "number" ? { additions: row.insertions } : {}),
    ...(typeof row.deletions === "number" ? { deletions: row.deletions } : {}),
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
    ...(state === "merged" && mergedAt !== undefined ? { mergedAt } : {})
  };
}

export function createGerritProvider(get: GerritGet = gerritGet): PublicForgeProvider {
  async function query(repo: ForgeRepo, expression: string, start = 0, limit = 100): Promise<unknown[]> {
    const params = new URLSearchParams({ q: `project:${JSON.stringify(repo.path)} ${expression}`, n: String(limit), S: String(start), o: "CURRENT_REVISION" });
    const data = await get(repo, `changes/?${params}`);
    if (!Array.isArray(data)) throw new Error("Gerrit returned an invalid change list.");
    return data;
  }
  async function lookup<K>(repo: ForgeRepo, keys: K[], expression: (key: K) => string, matches: (key: K, change: PrSummary) => boolean = () => true): Promise<Map<K, PrSummary | null>> {
    const result = new Map<K, PrSummary | null>();
    let failure: unknown;
    await mapLimit(keys, 4, async (key) => {
      try {
        const rows = await query(repo, expression(key), 0, 1);
        const change = rows.length === 0 ? null : gerritChange(rows[0], repo);
        if (change !== null && !matches(key, change)) throw new Error("Gerrit returned a different change than requested.");
        result.set(key, change);
      } catch (cause) { failure = cause; }
    });
    if (keys.length > 0 && result.size === 0) throw failure;
    return result;
  }
  return {
    kind: "gerrit", authentication: "public",
    // No source-branch relationship in Gerrit; callers gate this workflow.
    fetchPrsForBranches: async () => new Map(),
    fetchPrsForCommits: (repo, commits) => lookup(repo, commits, (sha) => {
      if (!/^[a-f0-9]{40,64}$/i.test(sha)) throw new Error("Invalid commit hash");
      return `commit:${sha}`;
    }),
    fetchPrsByNumbers: (repo, numbers) => lookup(repo, numbers, (number) => {
      if (!Number.isSafeInteger(number) || number <= 0) throw new Error("Invalid change number");
      return `change:${number}`;
    }, (number, change) => change.number === number),
    fetchOpenPrs: async (repo) => {
      const items: OpenChangeRequest[] = [];
      const seen = new Set<number>();
      while (items.length < OPEN_PR_LIST_CAP) {
        const rows = await query(repo, "status:open", items.length, Math.min(100, OPEN_PR_LIST_CAP - items.length));
        for (const row of rows) {
          const change = gerritChange(row, repo);
          if (seen.has(change.number) || change.state !== "open") throw new Error("Gerrit returned an inconsistent page.");
          seen.add(change.number); items.push(change);
        }
        const more = rows.length > 0 && object(rows[rows.length - 1])._more_changes === true;
        if (!more) return { items, truncated: false };
        if (items.length >= OPEN_PR_LIST_CAP) return { items: items.slice(0, OPEN_PR_LIST_CAP), truncated: true };
      }
      return { items, truncated: true };
    }
  };
}
export const gerritProvider = createGerritProvider();
