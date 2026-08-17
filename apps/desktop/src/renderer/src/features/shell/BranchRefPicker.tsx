import { useEffect, useMemo, useRef, useState } from "react";
import type { RemoteBranchSummary } from "@pwrgit/shared";
import { announce } from "../../lib/announce";
import { useRemoteBranchSearch } from "../../lib/useRemoteBranchSearch";

/**
 * Pick one ref from a repository's branches.
 *
 * Both callers used to render `<option>` per remote-tracking branch, which on a
 * fetched fork network is thousands of DOM nodes in a control the user picks a
 * single row from. The list here is a *page* — a filter box narrows it in the
 * main process, and "Load more" extends it — so the control costs the same
 * whether the remote has ten branches or ten thousand.
 *
 * It stays a sized `<select>` rather than an ARIA combobox on purpose: a native
 * listbox already has the keyboard model, focus handling, and screen-reader
 * semantics that a hand-rolled one has to re-earn, and paging is what actually
 * fixes the cost.
 */

export type BranchPickerOption = {
  /** Full ref name — `refs/heads/x` or `refs/remotes/origin/x`. */
  ref: string;
  label: string;
  kind: "local" | "remote";
  head: string;
  /** Present for remote rows, for callers that need the full summary. */
  remoteBranch?: RemoteBranchSummary;
};

function optionOf(branch: RemoteBranchSummary): BranchPickerOption {
  return {
    ref: branch.fullName,
    label: branch.qualifiedName,
    kind: "remote",
    head: branch.head,
    remoteBranch: branch
  };
}

function shortHead(head: string): string {
  return head.slice(0, 12);
}

export function BranchRefPicker({
  repoId,
  label,
  locals = [],
  remote,
  onChange,
  disabled = false,
  autoFocus = false,
  rows = 8
}: {
  repoId: string;
  label: string;
  /** Already-loaded local branches, filtered here rather than re-fetched. */
  locals?: BranchPickerOption[];
  /** Restrict remote results to one remote; omitted searches all of them. */
  remote?: string;
  /**
   * Fired for the seeded selection as well as every user change, so the caller
   * never has to hold a ref string of its own — one source of truth for what is
   * selected, which matters when the caller acts destructively on it.
   */
  onChange: (option: BranchPickerOption) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  rows?: number;
}) {
  const [query, setQuery] = useState("");
  const search = useRemoteBranchSearch({
    repoId,
    query,
    ...(remote === undefined ? {} : { remote })
  });

  const needle = query.trim().toLowerCase();
  const localMatches = useMemo(
    () =>
      needle === ""
        ? locals
        : locals.filter((option) =>
            option.label.toLowerCase().includes(needle)
          ),
    [locals, needle]
  );
  const remoteMatches = useMemo(
    () => search.rows.map(optionOf),
    [search.rows]
  );

  const shown = useMemo(
    () => [...localMatches, ...remoteMatches],
    [localMatches, remoteMatches]
  );

  // The selection survives a filter that excludes it — dropping it would let a
  // stray keystroke silently repoint the action the dialog is about to take.
  const [selected, setSelected] = useState<BranchPickerOption | null>(null);
  // Seed the selection from the first row that arrives, once. `onChange` is
  // deliberately not a dependency: callers pass an inline closure, so a new
  // identity every render would re-fire this on each parent render and snap the
  // selection back to the top of the list while the user is picking.
  const notify = useRef(onChange);
  notify.current = onChange;
  useEffect(() => {
    if (selected !== null) return;
    const first = shown[0];
    if (first === undefined) return;
    setSelected(first);
    notify.current(first);
  }, [shown, selected]);

  const stranded =
    selected !== null && !shown.some((option) => option.ref === selected.ref)
      ? selected
      : null;

  // The pinned selection is not a match — counting it would render "Showing 2
  // of 1" the moment a filter excludes whatever is currently selected.
  const totalMatches = localMatches.length + search.total;

  useEffect(() => {
    if (search.loading) return;
    announce(
      totalMatches === 0
        ? "No branches match this filter."
        : `${totalMatches} branch${totalMatches === 1 ? "" : "es"} match this filter.`
    );
  }, [search.loading, totalMatches]);

  const select = (ref: string): void => {
    const option = [...shown, ...(stranded === null ? [] : [stranded])].find(
      (candidate) => candidate.ref === ref
    );
    if (option === undefined) return;
    setSelected(option);
    onChange(option);
  };

  return (
    <div className="branch-picker">
      <label className="refs-field">
        <span>Filter</span>
        <input
          type="search"
          autoFocus={autoFocus}
          value={query}
          disabled={disabled}
          placeholder="Filter by name or commit subject"
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <label className="refs-field branch-picker__list">
        <span>{label}</span>
        <select
          size={rows}
          value={selected?.ref ?? ""}
          disabled={disabled}
          onChange={(event) => select(event.target.value)}
        >
          {stranded !== null && (
            <option value={stranded.ref}>
              {stranded.label} · {shortHead(stranded.head)} (selected)
            </option>
          )}
          {localMatches.length > 0 && (
            <optgroup label="Local branches">
              {localMatches.map((option) => (
                <option key={option.ref} value={option.ref}>
                  {option.label} · {shortHead(option.head)}
                </option>
              ))}
            </optgroup>
          )}
          {remoteMatches.length > 0 && (
            <optgroup label="Remote branches">
              {remoteMatches.map((option) => (
                <option key={option.ref} value={option.ref}>
                  {option.label} · {shortHead(option.head)}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </label>
      <div className="branch-picker__status">
        {search.error !== null ? (
          <span className="branch-picker__error">{search.error}</span>
        ) : search.loading && shown.length === 0 ? (
          <span>Loading branches…</span>
        ) : totalMatches === 0 ? (
          <span>No branches match this filter.</span>
        ) : (
          <span>
            Showing {shown.length} of {totalMatches}
          </span>
        )}
        {search.hasMore && (
          <button
            type="button"
            className="branch-picker__more"
            disabled={disabled || search.loading}
            onClick={() => search.loadMore()}
          >
            {search.loading ? "Loading…" : "Load more"}
          </button>
        )}
      </div>
    </div>
  );
}
