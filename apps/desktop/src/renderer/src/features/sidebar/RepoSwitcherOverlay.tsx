import { useEffect, useMemo, useRef, useState } from "react";
import type { RepoSearchHit, SearchHitStatus } from "@pwrgit/shared";
import { createAsyncFill } from "../../lib/asyncFill";
import { dispatch } from "../../lib/pwrgit";
import { shortWhen } from "../graph/graph-view";

const hitKey = (hit: RepoSearchHit): string =>
  `${hit.kind}:${hit.worktreeId ?? hit.repoId}`;

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

export function RepoSwitcherOverlay({
  onClose,
  onPick
}: {
  onClose: () => void;
  onPick: (hit: RepoSearchHit) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<RepoSearchHit[]>([]);
  const [sel, setSel] = useState(0);
  const [statuses, setStatuses] = useState<Map<string, SearchHitStatus>>(
    () => new Map()
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    let active = true;
    void dispatch("repo:search", { query }).then((r) => {
      if (active && r.ok) {
        setResults(r.value);
        setSel(0);
      }
    });
    return () => {
      active = false;
    };
  }, [query]);

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
            placeholder="Search repos & branches across all profiles…"
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSel((s) => Math.min(s + 1, results.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSel((s) => Math.max(s - 1, 0));
              } else if (e.key === "Enter") {
                const hit = results[sel];
                if (hit !== undefined) onPick(hit);
              } else if (e.key === "Escape") {
                onClose();
              }
            }}
          />
          <span className="kbd">esc</span>
        </div>

        <div className="overlay-results" ref={resultsRef}>
          {results.map((r, i) => (
            <button
              key={r.worktreeId ?? r.repoId}
              data-hit-key={hitKey(r)}
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
                        {shortWhen(s.lastActivityAt)}
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
            </button>
          ))}
          {results.length === 0 && (
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
          <span style={{ flex: 1 }} />
          <span>
            {results.length} {results.length === 1 ? "result" : "results"}
          </span>
        </div>
      </div>
    </div>
  );
}
