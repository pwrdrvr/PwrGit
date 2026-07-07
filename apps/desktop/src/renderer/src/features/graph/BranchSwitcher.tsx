import { useEffect, useMemo, useRef, useState } from "react";
import type { BranchRef } from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";
import { shortWhen } from "./graph-view";

/** The name to hand `git switch` — a remote ref drops its remote prefix so the
 *  DWIM creates/uses the local tracking branch. */
function switchTarget(ref: BranchRef): string {
  return ref.isRemote ? ref.name.replace(/^[^/]+\//, "") : ref.name;
}

/**
 * Pick the branch a worktree checks out. Lists local heads and remote-only
 * branches (a remote whose local counterpart already exists is hidden as
 * redundant), current first. Selecting one runs `branch:switch`; the tree,
 * header, and graph refresh off the resulting events.
 */
export function BranchSwitcher({
  worktreeId,
  currentBranch,
  onClose
}: {
  worktreeId: string;
  currentBranch: string;
  onClose: () => void;
}) {
  const [branches, setBranches] = useState<BranchRef[] | null>(null);
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    let active = true;
    void dispatch("branch:list", { worktreeId }).then((r) => {
      if (active && r.ok) setBranches(r.value);
    });
    return () => {
      active = false;
    };
  }, [worktreeId]);

  const ordered = useMemo<BranchRef[]>(() => {
    const all = branches ?? [];
    const localNames = new Set(all.filter((b) => !b.isRemote).map((b) => b.name));
    // Drop remotes that already have a same-named local head — redundant.
    const shown = all.filter(
      (b) => !b.isRemote || !localNames.has(switchTarget(b))
    );
    const q = query.trim().toLowerCase();
    const filtered =
      q === "" ? shown : shown.filter((b) => b.name.toLowerCase().includes(q));
    // Current first, then other locals, then remotes — each keeping the
    // recency order the list arrived in.
    return [
      ...filtered.filter((b) => b.isCurrent),
      ...filtered.filter((b) => !b.isCurrent && !b.isRemote),
      ...filtered.filter((b) => !b.isCurrent && b.isRemote)
    ];
  }, [branches, query]);

  useEffect(() => {
    setSel(0);
  }, [query]);

  const pick = async (ref: BranchRef): Promise<void> => {
    if (ref.isCurrent) {
      onClose();
      return;
    }
    const target = switchTarget(ref);
    setBusy(target);
    setError(null);
    const r = await dispatch("branch:switch", { worktreeId, branch: target });
    setBusy(null);
    if (r.ok) onClose();
    else setError(r.error.message.split("\n")[0]);
  };

  return (
    <div className="overlay-backdrop" onClick={onClose}>
      <div className="overlay-panel" onClick={(e) => e.stopPropagation()}>
        <div className="overlay-search">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="6" y1="3" x2="6" y2="15" />
            <circle cx="18" cy="6" r="3" />
            <circle cx="6" cy="18" r="3" />
            <path d="M18 9a9 9 0 0 1-9 9" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Switch from ${currentBranch}…`}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSel((s) => Math.min(s + 1, ordered.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSel((s) => Math.max(s - 1, 0));
              } else if (e.key === "Enter") {
                const ref = ordered[sel];
                if (ref !== undefined) void pick(ref);
              } else if (e.key === "Escape") {
                onClose();
              }
            }}
          />
          <span className="kbd">esc</span>
        </div>

        <div className="overlay-results">
          {ordered.map((b, i) => (
            <button
              key={b.name}
              className={`overlay-result branch-item${i === sel ? " is-selected" : ""}`}
              onMouseEnter={() => setSel(i)}
              onClick={() => void pick(b)}
              disabled={busy !== null}
            >
              <span
                className={`branch-item__dot${b.isCurrent ? " is-current" : ""}`}
              />
              <span className="branch-item__name">{b.name}</span>
              {b.isCurrent && <span className="branch-item__here">current</span>}
              {b.isRemote && <span className="branch-item__badge">remote</span>}
              {busy === switchTarget(b) && (
                <span className="branch-item__meta">switching…</span>
              )}
              {busy !== switchTarget(b) && b.lastCommitAt !== undefined && (
                <span className="branch-item__meta">
                  {shortWhen(b.lastCommitAt)}
                </span>
              )}
            </button>
          ))}
          {branches !== null && ordered.length === 0 && (
            <div className="overlay-empty">
              {query.trim() === ""
                ? "No branches"
                : `No branches match "${query}"`}
            </div>
          )}
          {branches === null && <div className="overlay-empty">Loading…</div>}
        </div>

        {error !== null ? (
          <div className="overlay-foot overlay-foot--error">{error}</div>
        ) : (
          <div className="overlay-foot">
            <span>↑↓ navigate</span>
            <span>↵ switch</span>
            <span style={{ flex: 1 }} />
            <span>
              {ordered.length} {ordered.length === 1 ? "branch" : "branches"}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
