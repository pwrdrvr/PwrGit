import { useCallback, useEffect, useRef, useState } from "react";
import {
  TAG_PAGE_SIZE,
  type TagSourceState,
  type TagStatusCounts,
  type TagStatusFilter,
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
 * stored snapshot. Main filters and compares; only one page crosses IPC, and
 * nothing here reaches the network.
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
  /** Increment after a mutation or a fresh listing to restart at page zero. */
  refreshKey?: number;
}): TagStatusSearch {
  const [rows, setRows] = useState<TagStatusRow[]>([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<TagStatusCounts | null>(null);
  const [source, setSource] = useState<TagSourceState | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const fetchPage = useCallback(
    async (offset: number, append: boolean): Promise<void> => {
      const stamp = ++generation.current;
      setLoading(true);
      const result = await dispatch("repo:tagStatus", {
        repoId,
        filter,
        query,
        offset,
        limit: pageSize
      });
      if (!mounted.current || stamp !== generation.current) return;
      setLoading(false);
      if (!result.ok) {
        setError(result.error.message.split("\n")[0] ?? "Load failed");
        if (!append) {
          setRows([]);
          setTotal(0);
        }
        return;
      }
      setError(null);
      setTotal(result.value.total);
      setCounts(result.value.counts ?? null);
      setSource(result.value.source ?? null);
      setRows((previous) =>
        append ? [...previous, ...result.value.rows] : result.value.rows
      );
    },
    // refreshKey restarts the search; it is never read.
    [filter, pageSize, query, refreshKey, repoId]
  );

  useEffect(() => {
    if (!enabled) {
      generation.current += 1;
      setLoading(false);
      return;
    }
    // Loading starts when the search is enabled, not when the debounce fires;
    // callers read `!loading && rows.length === 0` as "nothing matches".
    setLoading(true);
    const timer = setTimeout(() => void fetchPage(0, false), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [enabled, fetchPage]);

  const loadMore = useCallback(() => {
    if (loading) return;
    void fetchPage(rows.length, true);
  }, [fetchPage, loading, rows.length]);

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
