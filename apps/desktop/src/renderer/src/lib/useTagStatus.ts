import { useCallback, useEffect, useRef, useState } from "react";
import {
  TAG_PAGE_MAX,
  TAG_PAGE_SIZE,
  type TagSourceState,
  type TagStatusCounts,
  type TagStatusFilter,
  type TagStatusPage,
  type TagStatusRow
} from "@pwrgit/shared";
import { dispatch } from "./pwrgit";

const SEARCH_DEBOUNCE_MS = 200;

export type TagStatusSearch = {
  rows: TagStatusRow[];
  total: number;
  counts: TagStatusCounts | null;
  source: TagSourceState | null;
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  loadMore: () => void;
};

/**
 * Debounced, paged Tags tab: local tags compared with the published remote's
 * stored snapshot. Main filters and compares; IPC reads stay within the
 * server's page limit, and nothing here reaches the network.
 */
export function useTagStatus({
  repoId,
  query,
  filter,
  pageSize = TAG_PAGE_SIZE,
  enabled = true,
  refreshKey = 0
}: {
  repoId: string;
  query: string;
  filter: TagStatusFilter;
  pageSize?: number;
  enabled?: boolean;
  /** Increment after a mutation or listing to refresh the loaded range. */
  refreshKey?: number;
}): TagStatusSearch {
  const [rows, setRows] = useState<TagStatusRow[]>([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<TagStatusCounts | null>(null);
  const [source, setSource] = useState<TagSourceState | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const requestedEnd = useRef(pageSize);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const fetchRange = useCallback(
    async (start: number, end: number, preserveRows: boolean): Promise<void> => {
      const stamp = ++generation.current;
      setLoading(true);
      const nextRows: TagStatusRow[] = [];
      let offset = start;
      let page: TagStatusPage;
      do {
        const result = await dispatch("repo:tagStatus", {
          repoId, filter, query, offset, limit: Math.min(end - offset, TAG_PAGE_MAX)
        });
        if (!mounted.current || stamp !== generation.current) return;
        if (!result.ok) {
          setLoading(false);
          setError(result.error.message.split("\n")[0] ?? "Load failed");
          if (!preserveRows) {
            setRows([]);
            setTotal(0);
          }
          return;
        }
        page = result.value;
        nextRows.push(...page.rows);
        offset += page.rows.length;
        if (page.rows.length === 0) break;
      } while (offset < Math.min(end, page.total));

      // Publish the range together so later rows stay mounted and focusable
      // while earlier pages are being read.
      requestedEnd.current = Math.max(pageSize, offset);
      setLoading(false);
      setError(null);
      setTotal(page.total);
      setCounts(page.counts ?? null);
      setSource(page.source ?? null);
      setRows((previous) =>
        start === 0 ? nextRows : [...previous, ...nextRows]
      );
    },
    [filter, pageSize, query, repoId]
  );
  const previousSearch = useRef<typeof fetchRange | null>(null);

  useEffect(() => {
    if (!enabled) {
      previousSearch.current = null;
      generation.current += 1;
      setLoading(false);
      return;
    }
    const refresh = previousSearch.current === fetchRange;
    previousSearch.current = fetchRange;
    if (!refresh) requestedEnd.current = pageSize;
    // Loading starts when the search is enabled, not when the debounce fires:
    // between those two moments there are no rows and no request, and callers
    // read `!loading && rows.length === 0` as "nothing matches".
    //
    // A new query also retires the fetch in flight now, not when the debounce
    // fires: an older query's answer landing in between would otherwise clear
    // `loading` and show its rows as this query's results.
    generation.current += 1;
    setLoading(true);
    const timer = setTimeout(
      () => void fetchRange(0, requestedEnd.current, refresh),
      SEARCH_DEBOUNCE_MS
    );
    return () => clearTimeout(timer);
  }, [enabled, fetchRange, pageSize, refreshKey]);

  const loadMore = useCallback(() => {
    if (loading) return;
    requestedEnd.current = rows.length + pageSize;
    void fetchRange(rows.length, requestedEnd.current, true);
  }, [fetchRange, loading, pageSize, rows.length]);

  return {
    rows,
    total,
    counts,
    source,
    loading,
    error,
    hasMore: rows.length < total,
    loadMore
  };
}
