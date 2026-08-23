import { useCallback, useEffect, useRef, useState } from "react";
import { TAG_PAGE_SIZE, type TagSummary } from "@pwrgit/shared";
import { dispatch } from "./pwrgit";

const SEARCH_DEBOUNCE_MS = 200;

export type TagSearch = {
  rows: TagSummary[];
  total: number;
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  loadMore: () => void;
};

/** Debounced, paged search over local tags; only a bounded page crosses IPC. */
export function useTagSearch({
  repoId,
  query,
  pageSize = TAG_PAGE_SIZE,
  enabled = true,
  refreshKey = 0
}: {
  repoId: string;
  query: string;
  pageSize?: number;
  enabled?: boolean;
  /** Increment after a mutation to restart the current search at page zero. */
  refreshKey?: number;
}): TagSearch {
  const [rows, setRows] = useState<TagSummary[]>([]);
  const [total, setTotal] = useState(0);
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
      const result = await dispatch("repo:tags", {
        repoId,
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
      setRows((previous) =>
        append ? [...previous, ...result.value.rows] : result.value.rows
      );
    },
    [pageSize, query, refreshKey, repoId]
  );

  useEffect(() => {
    if (!enabled) {
      generation.current += 1;
      setLoading(false);
      return;
    }
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
    loading,
    error,
    hasMore: rows.length < total,
    loadMore
  };
}
