import { useEffect, useRef, useState } from "react";
import type { RepoSearchHit } from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";

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
  const inputRef = useRef<HTMLInputElement>(null);

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

        <div className="overlay-results">
          {results.map((r, i) => (
            <button
              key={r.worktreeId ?? r.repoId}
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
