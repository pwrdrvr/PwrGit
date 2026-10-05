import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeRequestView } from "@pwrgit/shared";
import { dispatch, subscribe } from "../../lib/pwrgit";
import { parseUnifiedDiff, type DiffFile } from "../diff/parse-diff";
import { changeRequestPickKey, type ChangeRequestPick } from "./change-request-selection";

/** All of the change request, or one of its commits. */
export type ChangeRequestScope =
  | { kind: "all" }
  | { kind: "commit"; hash: string; subject: string };

export type ChangeRequestViewState = {
  /** The last answer for the change request on screen; null until the first. */
  view: ChangeRequestView | null;
  /** The ref a fetch is bringing in, while it runs. */
  fetching: string | null;
  /** The bus refused (repository gone, change request off the list). */
  error: string | null;
  scope: ChangeRequestScope;
  setScope: (scope: ChangeRequestScope) => void;
  /** The patch the scope draws; null while it loads, or when too large. */
  patch: string | null;
  /** The picked commit's diff could not be read. */
  scopeError: string | null;
  /** The scope's patch, parsed once for the rail's file list. */
  files: DiffFile[];
  /** What the head shown changes, counted from its diff: the header's
   *  numbers once git has answered, since the forge's describe its own head,
   *  which may not be the one drawn. Null until then, or when too large. */
  totals: { files: number; additions: number; deletions: number } | null;
  /** Which end to draw when the local branch and the forge's head differ. */
  showEnd: (end: "local" | "forge") => void;
  /** Ask again, fetching what is missing. */
  fetchNow: () => void;
};

/**
 * Wait this long on a row reached by arrow keys before fetching its head: a
 * key held down the list must not start a fetch per row it passes.
 */
export const KEYBOARD_FETCH_DWELL_MS = 600;
/** A `pr:openChanged` this soon after our own fetch is our own echo. */
const OWN_FETCH_ECHO_MS = 3_000;
const ALL_CHANGES: ChangeRequestScope = { kind: "all" };

/**
 * The PR view's data: `pr:view`, asked first without leave to fetch (an
 * answer from the object store alone), then — when it says a fetch is needed
 * — again with it: at once for a click, after `KEYBOARD_FETCH_DWELL_MS` for a
 * row the arrow keys rested on. A list refresh (`pr:openChanged`) re-reads,
 * keeping the old answer on screen meanwhile so nothing flashes.
 *
 * `worktreeId` is any worktree of the repository: a commit's diff is read
 * through it (the object store is shared), and image previews too.
 */
export function useChangeRequestView(
  pick: ChangeRequestPick | null,
  worktreeId: string | null
): ChangeRequestViewState {
  const key = pick === null ? null : changeRequestPickKey(pick.repoId, pick.entry);
  const repoId = pick?.repoId ?? null;
  const number = pick?.entry.pr.number ?? null;
  const forgeRepo = pick?.entry.forgeRepo ?? null;
  const via = pick?.via ?? "pointer";
  const [view, setView] = useState<ChangeRequestView | null>(null);
  const [fetching, setFetching] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The end and the scope belong to one change request. Stored with its key
  // and read back only under it, so the render that switches picks already
  // asks the new one with neither — a reset effect would run after the load
  // effect had sent the last pick's `show` (and fetched for it).
  const [showFor, setShowFor] = useState<{ key: string; end: "local" | "forge" } | null>(null);
  const [scopeFor, setScopeFor] = useState<{ key: string; scope: ChangeRequestScope } | null>(
    null
  );
  const show = showFor !== null && showFor.key === key ? showFor.end : undefined;
  const scope: ChangeRequestScope =
    scopeFor !== null && scopeFor.key === key ? scopeFor.scope : ALL_CHANGES;
  const [commitPatch, setCommitPatch] = useState<
    { hash: string; patch: string | null; error: string | null } | null
  >(null);
  /** Bumped to ask again; `forceFetch` says whether that ask may fetch. */
  const [nonce, setNonce] = useState(0);
  const forceFetch = useRef(false);
  /** Our own fetches in flight, and when the last one finished: main
   *  announces `pr:openChanged` before it answers, so the echo can land
   *  while the fetch is still ours to wait on. */
  const ownFetches = useRef(0);
  const ownFetchDoneAt = useRef(0);

  // A different change request starts clean.
  useEffect(() => {
    setView(null);
    setError(null);
    setFetching(null);
    setCommitPatch(null);
    forceFetch.current = false;
  }, [key]);

  useEffect(() => {
    if (repoId === null || number === null || forgeRepo === null) return;
    let live = true;
    let timer: number | undefined;
    const ask = async (fetch: boolean): Promise<ChangeRequestView | null> => {
      if (fetch) ownFetches.current += 1;
      const result = await dispatch("pr:view", {
        repoId,
        number,
        forgeRepo,
        fetch,
        ...(show === undefined ? {} : { show })
      }).finally(() => {
        if (!fetch) return;
        ownFetches.current -= 1;
        ownFetchDoneAt.current = Date.now();
      });
      if (!live) return null;
      if (!result.ok) {
        setError(result.error.message);
        setFetching(null);
        return null;
      }
      setError(null);
      setView(result.value);
      return result.value;
    };
    const forced = forceFetch.current;
    forceFetch.current = false;
    void ask(forced).then((first) => {
      if (!live || first === null) return;
      // The forge's head was asked for, and its commit is not here.
      const forgeMissing =
        show === "forge" && first.state === "ready" && first.shown !== "forge";
      if (first.state !== "needsFetch" && !forgeMissing) {
        setFetching(null);
        return;
      }
      setFetching(first.state === "needsFetch" ? first.what : "the forge's head");
      const fetchNow = (): void => {
        void ask(true).then(() => {
          if (live) setFetching(null);
        });
      };
      if (via === "pointer" || forced || forgeMissing) fetchNow();
      else timer = window.setTimeout(fetchNow, KEYBOARD_FETCH_DWELL_MS);
    });
    return () => {
      live = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [repoId, number, forgeRepo, via, show, nonce]);

  // Someone else's refresh moved the list: read again, without a fetch.
  useEffect(() => {
    if (repoId === null) return;
    return subscribe("pr:openChanged", (payload) => {
      if (payload.repoId !== repoId) return;
      if (ownFetches.current > 0) return;
      if (Date.now() - ownFetchDoneAt.current < OWN_FETCH_ECHO_MS) return;
      setNonce((n) => n + 1);
    });
  }, [repoId]);

  // One commit's diff, read through any worktree of the repository.
  const scopeHash = scope.kind === "commit" ? scope.hash : null;
  const ownCommit = commitPatch !== null && commitPatch.hash === scopeHash ? commitPatch : null;
  useEffect(() => {
    if (scopeHash === null || worktreeId === null) return;
    let live = true;
    void dispatch("diff:commit", { worktreeId, hash: scopeHash }).then((result) => {
      if (!live) return;
      setCommitPatch(
        result.ok
          ? { hash: scopeHash, patch: result.value, error: null }
          : { hash: scopeHash, patch: null, error: result.error.message }
      );
    });
    return () => {
      live = false;
    };
  }, [scopeHash, worktreeId]);

  // The first render after a new pick still holds the last change request's
  // answer (the reset runs after it): never draw one under the other's header.
  const shown =
    view !== null && view.entry.forgeRepo === forgeRepo && view.entry.pr.number === number
      ? view
      : null;
  const patch =
    scope.kind === "all"
      ? shown?.state === "ready"
        ? shown.patch
        : null
      : (ownCommit?.patch ?? null);
  const allPatch = shown?.state === "ready" ? shown.patch : null;
  const all = useMemo(() => (allPatch === null ? null : parseUnifiedDiff(allPatch)), [allPatch]);
  const scopeFiles = useMemo(
    () => (scope.kind === "all" || patch === null ? [] : parseUnifiedDiff(patch).files),
    [scope.kind, patch]
  );
  const files = scope.kind === "all" ? (all?.files ?? []) : scopeFiles;
  const totals = useMemo(
    () =>
      all === null
        ? null
        : { files: all.files.length, additions: all.additions, deletions: all.deletions },
    [all]
  );

  const showEnd = useCallback(
    (end: "local" | "forge") => {
      if (key !== null) setShowFor({ key, end });
    },
    [key]
  );
  const setScope = useCallback(
    (next: ChangeRequestScope) => {
      if (key !== null) setScopeFor({ key, scope: next });
    },
    [key]
  );
  const fetchNow = useCallback(() => {
    forceFetch.current = true;
    setNonce((n) => n + 1);
  }, []);

  return {
    view: shown,
    fetching,
    error,
    scope,
    setScope,
    patch,
    scopeError: scope.kind === "commit" ? (ownCommit?.error ?? null) : null,
    files,
    totals,
    showEnd,
    fetchNow
  };
}
