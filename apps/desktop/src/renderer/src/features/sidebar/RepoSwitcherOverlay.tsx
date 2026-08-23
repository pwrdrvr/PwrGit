import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { Commit, RepoSearchHit, SearchHitStatus } from "@pwrgit/shared";
import { createAsyncFill } from "../../lib/asyncFill";
import { currentPlatform, shortcutLabel } from "../../lib/platform";
import { dispatch } from "../../lib/pwrgit";
import { useRelativeClock } from "../../lib/useRelativeClock";
import { shortWhen } from "../graph/graph-view";
import { commitHashQuery, searchCommits } from "./commit-search";
import { PrChip } from "./PrChip";
import { worktreeFolderLabel } from "./repo-view";
import { PinIcon } from "./WorktreeRow";

// The kind's own identity within its repo: a worktree id, a fetched ref, or —
// for a local branch, which carries neither — the branch name itself. Two local
// branches in one repo would otherwise share a React key.
const hitKey = (hit: RepoSearchHit): string =>
  `${hit.kind}:${hit.repoId}:${hit.worktreeId ?? hit.remoteRef ?? hit.name}`;

/** A branch hit with no worktree behind it: nothing to pin, no status to fill,
 *  and picking it opens the New worktree modal instead of selecting a row. */
const isWorktreelessBranch = (hit: RepoSearchHit): boolean =>
  hit.kind === "remote_branch" || hit.kind === "local_branch";

/** The directory a worktree hit lives in, when its branch name doesn't say.
 *  Paths are indexed too (0008_search_fts weights them below names), so a query
 *  typed from a shell prompt matches a worktree whose branch has since been
 *  renamed — and without this the row that came back named a branch the user
 *  had never heard of, with nothing to connect it to what they searched for. */
const hitFolderLabel = (hit: RepoSearchHit): string | null =>
  hit.kind === "worktree"
    ? worktreeFolderLabel(hit.name, hit.path, [hit.repoName])
    : null;

export type PaletteItem =
  | { kind: "commit"; commit: Commit }
  | { kind: "repo"; hit: RepoSearchHit };

export const paletteItemKey = (item: PaletteItem): string =>
  item.kind === "commit" ? `commit:${item.commit.hash}` : hitKey(item.hit);

export function selectedPaletteItemIndex(
  items: PaletteItem[],
  selectedKey: string | null
): number {
  if (selectedKey === null) return 0;
  const index = items.findIndex((item) => paletteItemKey(item) === selectedKey);
  return index < 0 ? 0 : index;
}

export function buildPaletteItems(
  commits: Commit[],
  results: RepoSearchHit[],
  query: string
): PaletteItem[] {
  const exactName = query.trim().normalize("NFC").toLowerCase();
  const exactRepos: RepoSearchHit[] = [];
  const otherResults: RepoSearchHit[] = [];
  for (const hit of results) {
    if (
      hit.kind === "repo" &&
      hit.name.normalize("NFC").toLowerCase() === exactName
    ) {
      exactRepos.push(hit);
    } else {
      otherResults.push(hit);
    }
  }

  return [
    ...exactRepos.map((hit) => ({ kind: "repo" as const, hit })),
    ...commits.map((commit) => ({ kind: "commit" as const, commit })),
    ...otherResults.map((hit) => ({ kind: "repo" as const, hit }))
  ];
}

function SearchIcon() {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

function CommitIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
    >
      <path d="M3 12h6M15 12h6" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function BranchIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="6" cy="5" r="2" />
      <circle cx="6" cy="19" r="2" />
      <circle cx="18" cy="8" r="2" />
      <path d="M6 7v10M8 17c5 0 8-2 8-7" />
    </svg>
  );
}

export function RepoSwitcherOverlay({
  commits,
  commitContext,
  onClose,
  onPick,
  onPickCommit,
  platform = currentPlatform()
}: {
  commits: Commit[];
  commitContext: {
    repoName: string;
    branch: string;
    worktreeId: string;
  } | null;
  onClose: () => void;
  onPick: (hit: RepoSearchHit) => void;
  onPickCommit: (commit: Commit) => void;
  /** Explicit only in deterministic platform component tests. */
  platform?: string;
}) {
  const now = useRelativeClock();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<RepoSearchHit[]>([]);
  const [selectedItemKey, setSelectedItemKey] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<Map<string, SearchHitStatus>>(
    () => new Map()
  );
  const [lookedUpCommit, setLookedUpCommit] = useState<{
    query: string;
    commit: Commit | null;
  } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const idPrefix = useId();
  const resultsId = `${idPrefix}-results`;
  const rowId = (index: number): string => `${idPrefix}-result-${index}`;
  const commitWorktreeId = commitContext?.worktreeId ?? null;
  const commitResults = useMemo(
    () => searchCommits(commits, query),
    [commits, query]
  );
  const hashQuery = commitHashQuery(query);
  const directCommit =
    hashQuery !== null && lookedUpCommit?.query === hashQuery
      ? lookedUpCommit.commit
      : null;
  const allCommitResults = useMemo(
    () =>
      directCommit === null ||
      commitResults.some((commit) => commit.hash === directCommit.hash)
        ? commitResults
        : [directCommit, ...commitResults],
    [commitResults, directCommit]
  );
  const items = useMemo<PaletteItem[]>(
    () => buildPaletteItems(allCommitResults, results, query),
    [allCommitResults, results, query]
  );
  const sel = selectedPaletteItemIndex(items, selectedItemKey);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Toggle the hit's pin optimistically; the sidebar picks up the change via
  // the handler's repo:changed event, and our copy keeps results stable (no
  // re-query, so rows don't jump while the overlay is open).
  const togglePin = (hit: RepoSearchHit) => {
    if (isWorktreelessBranch(hit)) return;
    const pinned = !hit.pinned;
    setResults((prev) =>
      prev.map((h) => (hitKey(h) === hitKey(hit) ? { ...h, pinned } : h))
    );
    if (hit.kind === "worktree" && hit.worktreeId !== undefined) {
      void dispatch("worktree:setPin", { worktreeId: hit.worktreeId, pinned });
    } else {
      void dispatch("repo:setPin", { repoId: hit.repoId, pinned });
    }
  };

  useEffect(() => {
    let active = true;
    void dispatch("repo:search", { query }).then((r) => {
      if (active && r.ok) {
        setResults(r.value);
      }
    });
    return () => {
      active = false;
    };
  }, [query]);

  useEffect(() => {
    if (hashQuery === null || commitWorktreeId === null) {
      setLookedUpCommit(null);
      return;
    }
    let active = true;
    const timer = window.setTimeout(() => {
      void dispatch("commit:lookup", {
        worktreeId: commitWorktreeId,
        hash: hashQuery
      }).then((result) => {
        if (active) {
          setLookedUpCommit({
            query: hashQuery,
            commit: result.ok ? result.value : null
          });
        }
      });
    }, 120);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [commitWorktreeId, hashQuery]);

  // Keyboard selection remains virtual so the query keeps focus. Keep the
  // active descendant visible when arrows move beyond the scroll viewport.
  useEffect(() => {
    const selected = resultsRef.current?.querySelector(
      ".overlay-result.is-selected"
    );
    if (typeof selected?.scrollIntoView === "function") {
      selected.scrollIntoView({ block: "nearest" });
    }
  }, [sel, items.length]);

  const pickItem = (item: PaletteItem | undefined): void => {
    if (item?.kind === "commit") onPickCommit(item.commit);
    else if (item?.kind === "repo") onPick(item.hit);
  };

  const selectItem = (index: number): void => {
    const item = items[index];
    setSelectedItemKey(item === undefined ? null : paletteItemKey(item));
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    // The field is the palette's only tab stop. Rows are selected through
    // aria-activedescendant, so Tab must not hand focus to Chromium's
    // keyboard-focusable scroll container.
    if (event.key === "Tab") {
      event.preventDefault();
      inputRef.current?.focus();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      selectItem(Math.min(sel + 1, Math.max(0, items.length - 1)));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      selectItem(Math.max(sel - 1, 0));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      pickItem(items[sel]);
      return;
    }
    if (
      (event.metaKey || event.ctrlKey) &&
      !event.shiftKey &&
      event.key.toLowerCase() === "p"
    ) {
      event.preventDefault();
      const item = items[sel];
      if (item?.kind === "repo") togglePin(item.hit);
    }
  };

  // Lazily fill per-hit status (tip age + dirty/ahead/behind when cached) as
  // rows become VISIBLE — debounced so a fast scroll doesn't rip through the
  // whole list, canceled the moment a row scrolls back out. Statuses are
  // memoized for the overlay's lifetime, so revisiting a row is free.
  const fill = useMemo(
    () => createAsyncFill<string>({ concurrency: 3, debounceMs: 200 }),
    []
  );
  const statusesRef = useRef(statuses);
  statusesRef.current = statuses;
  useEffect(() => () => fill.cancelAll(), [fill]);
  useEffect(() => {
    const root = resultsRef.current;
    if (root === null || results.length === 0) return;
    const byKey = new Map(results.map((h) => [hitKey(h), h]));
    const observer = new IntersectionObserver(
      (obsEntries) => {
        for (const e of obsEntries) {
          const key = (e.target as HTMLElement).dataset["hitKey"];
          if (key === undefined) continue;
          if (!e.isIntersecting) {
            fill.cancel(key);
            continue;
          }
          if (statusesRef.current.has(key)) continue;
          const hit = byKey.get(key);
          if (hit === undefined) continue;
          if (isWorktreelessBranch(hit)) continue;
          fill.request(key, async () => {
            const r = await dispatch("search:status", {
              repoId: hit.repoId,
              ...(hit.worktreeId !== undefined
                ? { worktreeId: hit.worktreeId }
                : {})
            });
            if (r.ok) {
              setStatuses((prev) => new Map(prev).set(key, r.value));
            }
          });
        }
      },
      { root }
    );
    for (const el of root.querySelectorAll("[data-hit-key]")) {
      observer.observe(el);
    }
    return () => observer.disconnect();
  }, [results, fill]);

  return (
    <div className="overlay-backdrop" onClick={onClose}>
      <div
        className="overlay-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Jump to repo, branch, or commit"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
        onMouseDown={(event) => {
          if (event.target === inputRef.current) return;
          event.preventDefault();
          inputRef.current?.focus();
        }}
      >
        <div className="overlay-search">
          <SearchIcon />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedItemKey(null);
            }}
            aria-label="Jump to repo, branch, or commit"
            aria-controls={items.length > 0 ? resultsId : undefined}
            aria-activedescendant={
              items.length > 0 ? rowId(sel) : undefined
            }
            autoComplete="off"
            spellCheck={false}
            placeholder="Search repos, branches & current repo commits…"
          />
          <span className="kbd">esc</span>
        </div>

        <div
          className="overlay-results"
          id={resultsId}
          role="listbox"
          aria-label="Repositories, branches, and commits"
          ref={resultsRef}
        >
          {items.map((item, i) => {
            if (item.kind === "commit") {
              const commit = item.commit;
              return (
                <div
                  key={`commit:${commit.hash}`}
                  id={rowId(i)}
                  role="option"
                  aria-selected={i === sel}
                  tabIndex={-1}
                  className={`overlay-result${i === sel ? " is-selected" : ""}`}
                  title={
                    commitContext === null
                      ? commit.hash
                      : `${commitContext.repoName} · ${commitContext.branch} · ${commit.hash}`
                  }
                  onMouseEnter={() => selectItem(i)}
                  onClick={() => onPickCommit(commit)}
                >
                  <CommitIcon />
                  <span className="overlay-result__name">{commit.subject}</span>
                  <span className="overlay-result__meta">{commit.authorName}</span>
                  <span className="hit-status__age">
                    {shortWhen(commit.committedAt, now)}
                  </span>
                  <span className="overlay-result__profile">
                    {commit.shortHash}
                  </span>
                </div>
              );
            }
            const r = item.hit;
            return (
              // A div, not a button: the pin star inside is a real <button>,
              // and buttons can't nest.
              <div
                // Kind-prefixed: a repo and its PRIMARY worktree share the same
                // hash-of-path id, and duplicate keys strand ghost rows in the
                // DOM across re-renders.
                key={hitKey(r)}
                id={rowId(i)}
                data-hit-key={hitKey(r)}
                role="option"
                aria-selected={i === sel}
                tabIndex={-1}
                className={`overlay-result${i === sel ? " is-selected" : ""}`}
                onMouseEnter={() => selectItem(i)}
                onClick={() => onPick(r)}
              >
              {isWorktreelessBranch(r) ? (
                <BranchIcon />
              ) : r.kind === "worktree" ? (
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M6 3v12" />
                  <circle cx="6" cy="18" r="3" />
                  <circle cx="18" cy="6" r="3" />
                  <path d="M18 9c0 6-6 6-6 12" />
                </svg>
              ) : (
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
                </svg>
              )}
              <span className="overlay-result__name">{r.name}</span>
              {(() => {
                const folder = hitFolderLabel(r);
                if (folder === null) return null;
                return (
                  <>
                    <span className="a11y-sr-only">in folder</span>
                    <span
                      className="overlay-result__folder"
                      title={`Worktree folder — ${r.path}`}
                    >
                      <svg
                        width="11"
                        height="11"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.7"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
                      </svg>
                      <span className="overlay-result__folder-name">{folder}</span>
                    </span>
                  </>
                );
              })()}
              {!isWorktreelessBranch(r) && (
                <button
                  type="button"
                  className={`pin${r.pinned ? " is-pinned" : ""}`}
                  title={
                    r.pinned
                      ? `Unpin ${r.kind === "worktree" ? "worktree" : "repo"}`
                      : `Pin ${r.kind === "worktree" ? "worktree" : "repo"}`
                  }
                  aria-label={
                    r.pinned
                      ? `Unpin ${r.kind === "worktree" ? "worktree" : "repo"}`
                      : `Pin ${r.kind === "worktree" ? "worktree" : "repo"}`
                  }
                  tabIndex={-1}
                  onClick={(e) => {
                    e.stopPropagation();
                    togglePin(r);
                  }}
                >
                  <PinIcon filled={r.pinned} size={12} />
                </button>
              )}
              {r.pr !== undefined && <PrChip pr={r.pr} />}
              {(() => {
                const s = statuses.get(hitKey(r));
                if (s === undefined) return null;
                return (
                  <span className="hit-status">
                    {s.dirty !== null && s.dirty > 0 && (
                      <span className="hit-status__b hit-status__b--warn">
                        ●{s.dirty}
                      </span>
                    )}
                    {s.ahead !== null && s.ahead > 0 && (
                      <span className="hit-status__b hit-status__b--ok">
                        ↑{s.ahead}
                      </span>
                    )}
                    {s.behind !== null && s.behind > 0 && (
                      <span className="hit-status__b hit-status__b--warn">
                        ↓{s.behind}
                      </span>
                    )}
                    {s.lastActivityAt !== null && (
                      <span
                        className="hit-status__age"
                        title={`Last commit ${s.lastActivityAt}`}
                      >
                        {shortWhen(s.lastActivityAt, now)}
                      </span>
                    )}
                  </span>
                );
              })()}
              <span className="overlay-result__meta">
                {r.kind === "remote_branch"
                  ? `${r.repoName ?? ""} · ${r.remoteName ?? "remote"}`
                  : r.kind === "local_branch"
                  ? `${r.repoName ?? ""} · no worktree`
                  : r.kind === "worktree"
                  ? (r.repoName ?? "")
                  : `${r.worktreeCount} ${r.worktreeCount === 1 ? "wt" : "wts"}`}
              </span>
              <span className="overlay-result__profile">{r.profileName}</span>
              </div>
            );
          })}
          {items.length === 0 && (
            <div className="overlay-empty">
              {query.trim() === ""
                ? "No repos indexed yet"
                : `Nothing matches "${query}"`}
            </div>
          )}
        </div>

        <div className="overlay-foot">
          <span>↑↓ navigate</span>
          <span>↵ open</span>
          {items[sel]?.kind === "repo" &&
            !isWorktreelessBranch(items[sel].hit) && (
              <span>{shortcutLabel({ key: "P" }, platform)} pin</span>
            )}
          <span style={{ flex: 1 }} />
          <span>
            {items.length} {items.length === 1 ? "result" : "results"}
          </span>
        </div>
      </div>
    </div>
  );
}
