import { useEffect, useMemo, useRef, useState } from "react";
import type { Commit, RepoSearchHit, SearchHitStatus } from "@pwrgit/shared";
import { createAsyncFill } from "../../lib/asyncFill";
import { dispatch } from "../../lib/pwrgit";
import { useRelativeClock } from "../../lib/useRelativeClock";
import { shortWhen } from "../graph/graph-view";
import { commitHashQuery, searchCommits } from "./commit-search";
import { PrChip } from "./PrChip";
import { PinIcon } from "./WorktreeRow";

const isMac = navigator.platform.startsWith("Mac");

const hitKey = (hit: RepoSearchHit): string =>
  `${hit.kind}:${hit.worktreeId ?? hit.repoId}`;

export type PaletteItem =
  | { kind: "commit"; commit: Commit }
  | { kind: "repo"; hit: RepoSearchHit };

export function buildPaletteItems(
  commits: Commit[],
  results: RepoSearchHit[],
  _query: string
): PaletteItem[] {
  return [
    ...commits.map((commit) => ({ kind: "commit" as const, commit })),
    ...results.map((hit) => ({ kind: "repo" as const, hit }))
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

export function RepoSwitcherOverlay({
  commits,
  commitContext,
  onClose,
  onPick,
  onPickCommit
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
}) {
  const now = useRelativeClock();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<RepoSearchHit[]>([]);
  const [sel, setSel] = useState(0);
  const [statuses, setStatuses] = useState<Map<string, SearchHitStatus>>(
    () => new Map()
  );
  const [lookedUpCommit, setLookedUpCommit] = useState<{
    query: string;
    commit: Commit | null;
  } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
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

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Toggle the hit's pin optimistically; the sidebar picks up the change via
  // the handler's repo:changed event, and our copy keeps results stable (no
  // re-query, so rows don't jump while the overlay is open).
  const togglePin = (hit: RepoSearchHit) => {
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

  useEffect(() => setSel(0), [query]);
  useEffect(() => {
    setSel((current) => Math.min(current, Math.max(0, items.length - 1)));
  }, [items.length]);

  const pickItem = (item: PaletteItem | undefined): void => {
    if (item?.kind === "commit") onPickCommit(item.commit);
    else if (item?.kind === "repo") onPick(item.hit);
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
      <div className="overlay-panel" onClick={(e) => e.stopPropagation()}>
        <div className="overlay-search">
          <SearchIcon />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search repos, branches & current repo commits…"
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSel((s) =>
                  Math.min(s + 1, Math.max(0, items.length - 1))
                );
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSel((s) => Math.max(s - 1, 0));
              } else if (e.key === "Enter") {
                pickItem(items[sel]);
              } else if (
                (e.metaKey || e.ctrlKey) &&
                !e.shiftKey &&
                e.key.toLowerCase() === "p"
              ) {
                e.preventDefault();
                const item = items[sel];
                if (item?.kind === "repo") togglePin(item.hit);
              } else if (e.key === "Escape") {
                onClose();
              }
            }}
          />
          <span className="kbd">esc</span>
        </div>

        <div className="overlay-results" role="listbox" ref={resultsRef}>
          {items.map((item, i) => {
            if (item.kind === "commit") {
              const commit = item.commit;
              return (
                <div
                  key={`commit:${commit.hash}`}
                  role="option"
                  aria-selected={i === sel}
                  className={`overlay-result${i === sel ? " is-selected" : ""}`}
                  title={
                    commitContext === null
                      ? commit.hash
                      : `${commitContext.repoName} · ${commitContext.branch} · ${commit.hash}`
                  }
                  onMouseEnter={() => setSel(i)}
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
                data-hit-key={hitKey(r)}
                role="option"
                aria-selected={i === sel}
                className={`overlay-result${i === sel ? " is-selected" : ""}`}
                onMouseEnter={() => setSel(i)}
                onClick={() => onPick(r)}
              >
              {r.kind === "worktree" ? (
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
                {r.kind === "worktree"
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
          {items[sel]?.kind === "repo" && (
            <span>{isMac ? "⌘P" : "ctrl+P"} pin</span>
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
