import type { ForgeKind, PrSummary } from "@pwrgit/shared";

/**
 * Every column that makes up a cached `PrSummary`, in one place.
 *
 * This list was previously spelled out by hand in three files, and adding the
 * hover-card detail to only one of them is exactly how the sidebar ended up
 * able to show a card that could never have anything in it. Anything reading
 * `branch_pr` or `commit_pr` for a summary should build its projection here.
 */
export const PR_CORE_COLUMNS = [
  "number",
  "url",
  "title",
  "state",
  "is_draft"
] as const;

/** The hover-card detail. Split out because the writer needs it on its own. */
export const PR_DETAIL_COLUMNS = [
  "forge",
  "host",
  "repo_path",
  "head_ref",
  "base_ref",
  "additions",
  "deletions",
  "changed_files",
  "commit_count",
  "opened_at",
  "merged_at",
  "closed_at"
] as const;

export const PR_SUMMARY_COLUMNS = [
  ...PR_CORE_COLUMNS,
  ...PR_DETAIL_COLUMNS
] as const;

/** `p.number AS pr_number, p.url AS pr_url, …` for a joined PR row. */
export function prSummarySelect(table: string, prefix = "pr_"): string {
  return PR_SUMMARY_COLUMNS.map(
    (column) => `${table}.${column} AS ${prefix}${column}`
  ).join(", ");
}

/**
 * Rebuild a `PrSummary` from a prefixed joined row, or undefined when the join
 * found no PR.
 *
 * Absent columns stay absent rather than becoming zero — "not known" and
 * "changes nothing" are different claims, and only the second is evidence.
 */
export function prSummaryFromRow(
  row: Record<string, unknown>,
  prefix = "pr_"
): PrSummary | undefined {
  const number = row[`${prefix}number`];
  if (typeof number !== "number") return undefined;
  const state = row[`${prefix}state`];
  return {
    number,
    url: text(row[`${prefix}url`]) ?? "",
    title: text(row[`${prefix}title`]) ?? "",
    state:
      state === "merged" ? "merged" : state === "closed" ? "closed" : "open",
    isDraft: row[`${prefix}is_draft`] === 1,
    ...optional("forge", forgeKind(row[`${prefix}forge`])),
    ...optional("host", text(row[`${prefix}host`])),
    ...optional("repoPath", text(row[`${prefix}repo_path`])),
    ...optional("headRefName", text(row[`${prefix}head_ref`])),
    ...optional("baseRefName", text(row[`${prefix}base_ref`])),
    ...optional("additions", count(row[`${prefix}additions`])),
    ...optional("deletions", count(row[`${prefix}deletions`])),
    ...optional("changedFiles", count(row[`${prefix}changed_files`])),
    ...optional("commitCount", count(row[`${prefix}commit_count`])),
    ...optional("createdAt", count(row[`${prefix}opened_at`])),
    ...optional("mergedAt", count(row[`${prefix}merged_at`])),
    ...optional("closedAt", count(row[`${prefix}closed_at`]))
  };
}

function optional<T>(key: string, value: T | undefined): Record<string, T> {
  return value === undefined ? {} : { [key]: value };
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Guard the stored string rather than casting: a stale row may hold anything. */
function forgeKind(value: unknown): ForgeKind | undefined {
  return value === "github" || value === "gitlab" ? value : undefined;
}
