import { useCallback, useEffect, useRef, useState } from "react";
import {
  REMOTE_BRANCH_PAGE_SIZE,
  type RemoteBranchSummary
} from "@pwrgit/shared";
import { dispatch } from "./pwrgit";

/**
 * Debounced, paged search over a repository's remote-tracking branches.
 *
 * `repo:refs` carries only a six-row preview per remote, because a fetched fork
 * network runs to thousands of refs. Anything that browses or picks from the
 * full set pulls pages through here instead, so neither the IPC response nor
 * the option list it feeds grows with the size of the remote.
 */

/** Long enough that typing a branch name is one query, not one per keystroke. */
const SEARCH_DEBOUNCE_MS = 200;

export type RemoteBranchSearch = {
  rows: RemoteBranchSummary[];
  /** Matches across the whole remote — `rows` is the part fetched so far. */
  total: number;
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  loadMore: () => void;
};

export function useRemoteBranchSearch({
  repoId,
  query,
  remote,
  pageSize = REMOTE_BRANCH_PAGE_SIZE,
  enabled = true
}: {
  repoId: string;
  query: string;
  /** Restrict to one remote; omitted searches every remote. */
  remote?: string;
  pageSize?: number;
  /** Skip fetching entirely — e.g. while the surface is closed. */
  enabled?: boolean;
}): RemoteBranchSearch {
  const [rows, setRows] = useState<RemoteBranchSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);

  // Every fetch stamps itself, and only the newest may write state. Pages are
  // requested as the user types, so slow responses WILL land out of order.
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
      const result = await dispatch("repo:remoteBranches", {
        repoId,
        ...(remote === undefined ? {} : { remote }),
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
    [pageSize, query, remote, repoId]
  );

  // A new query restarts at offset 0; `loadMore` extends the current one.
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
