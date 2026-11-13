import {
  isForgeKind,
  MERGE_QUEUE_ENTRY_STATES,
  type ForgeKind,
  type PrMergeQueue,
  type OpenChangeRequest,
  type PrSummary
} from "@pwrgit/shared";

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
  "check_state",
  "checks_still_running",
  "merge_state",
  "forge",
  "host",
  "repo_path",
  "head_ref",
  "base_ref",
  "head_oid",
  "additions",
  "deletions",
  "changed_files",
  "commit_count",
  "opened_at",
  "merged_at",
  "closed_at",
  "merge_queue"
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
    ...optional("checkState", enumValue(row[`${prefix}check_state`], ["passing", "failing", "pending", "unknown"] as const)),
    ...optional("mergeState", enumValue(row[`${prefix}merge_state`], ["mergeable", "conflicting", "unknown"] as const)),
    ...optional("checksStillRunning", row[`${prefix}checks_still_running`] == null ? undefined : row[`${prefix}checks_still_running`] === 1),
    ...optional("forge", forgeKind(row[`${prefix}forge`])),
    ...optional("host", text(row[`${prefix}host`])),
    ...optional("repoPath", text(row[`${prefix}repo_path`])),
    ...optional("headRefName", text(row[`${prefix}head_ref`])),
    ...optional("baseRefName", text(row[`${prefix}base_ref`])),
    ...optional("headOid", text(row[`${prefix}head_oid`])),
    ...optional("additions", count(row[`${prefix}additions`])),
    ...optional("deletions", count(row[`${prefix}deletions`])),
    ...optional("changedFiles", count(row[`${prefix}changed_files`])),
    ...optional("commitCount", count(row[`${prefix}commit_count`])),
    ...optional("createdAt", count(row[`${prefix}opened_at`])),
    ...optional("mergedAt", count(row[`${prefix}merged_at`])),
    ...optional("closedAt", count(row[`${prefix}closed_at`])),
    ...optional("mergeQueue", parseMergeQueue(row[`${prefix}merge_queue`]))
  };
}

/**
 * `PrMergeQueue` → the `merge_queue` column. Keys are written in one fixed
 * order, so an unchanged queue serialises to the same string and the diff
 * writers (`sameCachedPr`, `sameRow`) see no change.
 */
export function serializeMergeQueue(queue: PrMergeQueue | undefined): string | null {
  if (queue === undefined) return null;
  const entry = queue.entry === undefined ? undefined : {
    state: queue.entry.state,
    position: queue.entry.position,
    etaSeconds: queue.entry.etaSeconds,
    enqueuedAt: queue.entry.enqueuedAt
  };
  const lastEvent = queue.lastEvent === undefined ? undefined : {
    kind: queue.lastEvent.kind,
    at: queue.lastEvent.at,
    reason: queue.lastEvent.reason
  };
  return JSON.stringify({
    required: queue.required,
    entry,
    lastEvent,
    blocked: queue.blocked,
    method: queue.method
  });
}

/**
 * The `merge_queue` column back to a `PrMergeQueue`, validating every field:
 * a stale or hand-edited row may hold anything, and an unreadable one is "not
 * known", never "no queue".
 */
export function parseMergeQueue(value: unknown): PrMergeQueue | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  if (typeof record.required !== "boolean") return undefined;
  const entryRaw = record.entry as Record<string, unknown> | undefined;
  const state = enumValue(entryRaw?.state, MERGE_QUEUE_ENTRY_STATES);
  const eventRaw = record.lastEvent as Record<string, unknown> | undefined;
  const kind = enumValue(eventRaw?.kind, ["added", "removed"] as const);
  const method = enumValue(record.method, ["merge", "squash", "rebase"] as const);
  return {
    required: record.required,
    ...(state === undefined ? {} : {
      entry: {
        state,
        ...optional("position", count(entryRaw?.position)),
        ...optional("etaSeconds", count(entryRaw?.etaSeconds)),
        ...optional("enqueuedAt", count(entryRaw?.enqueuedAt))
      }
    }),
    ...(kind === undefined ? {} : {
      lastEvent: {
        kind,
        ...optional("at", count(eventRaw?.at)),
        ...optional("reason", text(eventRaw?.reason))
      }
    }),
    ...(typeof record.blocked === "boolean" ? { blocked: record.blocked } : {}),
    ...optional("method", method)
  };
}

/** What `repo_open_pr` stores beyond a `PrSummary`. */
export const OPEN_PR_EXTRA_COLUMNS = [
  "author",
  "head_repo_path",
  "updated_at"
] as const;

export const OPEN_PR_COLUMNS = [
  ...PR_SUMMARY_COLUMNS,
  ...OPEN_PR_EXTRA_COLUMNS
] as const;

/** `prSummarySelect` for a joined `repo_open_pr` row. */
export function openPrSelect(table: string, prefix = "pr_"): string {
  return OPEN_PR_COLUMNS.map(
    (column) => `${table}.${column} AS ${prefix}${column}`
  ).join(", ");
}

/** `prSummaryFromRow`, plus the three open-list columns. */
export function openPrFromRow(
  row: Record<string, unknown>,
  prefix = "pr_"
): OpenChangeRequest | undefined {
  const summary = prSummaryFromRow(row, prefix);
  if (summary === undefined) return undefined;
  return {
    ...summary,
    ...optional("author", text(row[`${prefix}author`])),
    ...optional("headRepoPath", text(row[`${prefix}head_repo_path`])),
    ...optional("updatedAt", count(row[`${prefix}updated_at`]))
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
  return isForgeKind(value) ? value : undefined;
}

function enumValue<T extends string>(value: unknown, values: readonly T[]): T | undefined {
  return values.includes(value as T) ? value as T : undefined;
}
