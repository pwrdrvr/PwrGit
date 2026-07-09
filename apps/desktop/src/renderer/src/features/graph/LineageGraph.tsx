import { useEffect, useMemo, useRef, useState } from "react";
import type { LaneGraph } from "@pwrgit/shared";
import { dispatch, subscribe } from "../../lib/pwrgit";
import { GraphRow, type GraphRowVM, laneColor } from "./GraphRow";
import { shortWhen } from "./graph-view";
import { layoutLanes } from "./lane-layout";

type Scope = "active" | "all";

const scrollBehavior = (): ScrollBehavior =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : "smooth";

export function LineageGraph({
  worktreeId,
  activeEmail,
  selectedCommits,
  onToggleCommit,
  onOpenCommit
}: {
  worktreeId: string;
  activeEmail: string;
  selectedCommits: Set<string>;
  onToggleCommit: (hash: string) => void;
  onOpenCommit: (hash: string, subject: string) => void;
}) {
  const [data, setData] = useState<LaneGraph | null>(null);
  const [scope, setScope] = useState<Scope>("active");
  const [loading, setLoading] = useState(true);
  const [flash, setFlash] = useState<string | null>(null);
  const [branchesOpen, setBranchesOpen] = useState(false);
  const scrollerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    const load = (force: boolean): void => {
      void dispatch("graph:lanes", { worktreeId, scope, force }).then((r) => {
        if (!active) return;
        if (r.ok) setData(r.value);
        setLoading(false);
      });
    };
    setLoading(true);
    // A plain worktree/scope switch reuses the repo's cached lanes (fast); an
    // actual change to this worktree forces a recompute.
    load(false);
    const off = subscribe("worktree:changed", (p) => {
      if (p.worktreeId === worktreeId) load(true);
    });
    return () => {
      active = false;
      off();
    };
  }, [worktreeId, scope]);

  const head = data?.head ?? "";

  // Selecting a worktree takes you to its HEAD: center it and flash it. Also
  // re-centers when HEAD itself moves (commit, pull, switch branch).
  useEffect(() => {
    if (head === "") return;
    const raf = requestAnimationFrame(() => {
      const el = scrollerRef.current?.querySelector(`[data-hash="${head}"]`);
      if (el === null || el === undefined) return;
      el.scrollIntoView({ block: "center", behavior: scrollBehavior() });
      setFlash(head);
    });
    return () => cancelAnimationFrame(raf);
  }, [head, worktreeId]);

  useEffect(() => {
    if (flash === null) return;
    const t = setTimeout(() => setFlash(null), 1600);
    return () => clearTimeout(t);
  }, [flash]);

  const locateHash = (hash: string): void => {
    if (hash === "") return;
    const el = scrollerRef.current?.querySelector(`[data-hash="${hash}"]`);
    el?.scrollIntoView({ block: "center", behavior: scrollBehavior() });
    setFlash(hash);
  };

  const email = activeEmail.toLowerCase();
  const layout = useMemo(
    () =>
      layoutLanes(
        (data?.commits ?? []).map((c) => ({ hash: c.hash, parents: c.parents }))
      ),
    [data]
  );

  const vms: GraphRowVM[] = useMemo(() => {
    const commits = data?.commits ?? [];
    const tips = data?.tips ?? {};
    const defaultBranch = data?.defaultBranch ?? "";
    return commits.map((commit, i) => ({
      commit,
      row: layout.rows[i] ?? { lane: 0, top: [], bottom: [] },
      refs: tips[commit.hash] ?? [],
      isHead: commit.hash === head,
      isMine: commit.authorEmail.toLowerCase() === email,
      defaultBranch
    }));
  }, [data, layout, email, head]);

  // name → tip hash (from the hash → names map) for the branch navigator.
  const tipByName = useMemo(() => {
    const m = new Map<string, string>();
    for (const [hash, names] of Object.entries(data?.tips ?? {})) {
      for (const n of names) m.set(n, hash);
    }
    return m;
  }, [data]);
  const vmByHash = useMemo(
    () => new Map(vms.map((vm) => [vm.commit.hash, vm])),
    [vms]
  );

  const shown = data?.shownBranches.length ?? 0;
  const hidden = data?.hiddenBranches ?? 0;

  return (
    <>
      <div className="graph-toolbar">
        <span className="graph-toolbar__label">Lineage</span>
        <span style={{ flex: 1 }} />
        <span className="graph-branches-wrap">
          <button
            className="graph-branches"
            aria-haspopup="menu"
            aria-expanded={branchesOpen}
            title="Branches drawn in this graph — click one to jump to its tip"
            onClick={() => setBranchesOpen((v) => !v)}
          >
            {scope === "active"
              ? `${shown} active branch${shown === 1 ? "" : "es"}`
              : `${shown} branch${shown === 1 ? "" : "es"} in flight`}
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
          {branchesOpen && (
            <>
              <div
                className="branch-pop__backdrop"
                onClick={() => setBranchesOpen(false)}
              />
              <div className="branch-pop" role="menu">
                {(data?.shownBranches ?? []).map((name) => {
                  const tipHash = tipByName.get(name);
                  const vm =
                    tipHash !== undefined ? vmByHash.get(tipHash) : undefined;
                  return (
                    <button
                      key={name}
                      className="branch-pop__item"
                      role="menuitem"
                      disabled={vm === undefined}
                      title={
                        vm === undefined
                          ? "Tip is outside the loaded window"
                          : `Jump to ${name}`
                      }
                      onClick={() => {
                        if (tipHash !== undefined) {
                          locateHash(tipHash);
                          setBranchesOpen(false);
                        }
                      }}
                    >
                      <span
                        className="branch-pop__dot"
                        style={{
                          background:
                            vm !== undefined
                              ? laneColor(vm.row.lane)
                              : "var(--text-subtle)"
                        }}
                      />
                      <span className="branch-pop__name">{name}</span>
                      {vm !== undefined && (
                        <span className="branch-pop__meta">
                          {vm.isMine ? "you" : vm.commit.authorName} ·{" "}
                          {shortWhen(vm.commit.committedAt)}
                        </span>
                      )}
                    </button>
                  );
                })}
                {shown === 0 && (
                  <div className="branch-pop__empty">No branches drawn</div>
                )}
              </div>
            </>
          )}
        </span>
        {head !== "" && (
          <button
            className="graph-locate"
            onClick={() => locateHash(head)}
            title="Scroll to this worktree's current commit (HEAD)"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="12" cy="12" r="7" />
              <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
            </svg>
            You are here
          </button>
        )}
        <button
          className={`only-me${scope === "active" ? " is-on" : ""}`}
          title={
            scope === "active"
              ? "Showing your active, unmerged branches. Click to show all branches."
              : "Showing all branches. Click to show only active ones."
          }
          onClick={() => setScope((s) => (s === "active" ? "all" : "active"))}
        >
          <span className="only-me__dot" />
          {scope === "active" ? "Active" : "All branches"}
        </button>
      </div>

      <div className="graph-scroll" ref={scrollerRef}>
        {vms.length > 0 ? (
          <div
            className={`graph-card${selectedCommits.size > 0 ? " has-selection" : ""}`}
          >
            {vms.map((vm) => (
              <GraphRow
                key={vm.commit.hash}
                vm={vm}
                laneCount={layout.laneCount}
                selected={selectedCommits.has(vm.commit.hash)}
                flashing={flash === vm.commit.hash}
                onToggle={() => onToggleCommit(vm.commit.hash)}
                onOpen={() => onOpenCommit(vm.commit.hash, vm.commit.subject)}
              />
            ))}
          </div>
        ) : (
          <div className="graph-empty">
            {loading
              ? "Loading history…"
              : scope === "active"
                ? "No active branches — you're all caught up."
                : "No commits."}
          </div>
        )}

        {scope === "active" && hidden > 0 && (
          <div className="graph-hidden-note">
            {hidden} more branch{hidden === 1 ? "" : "es"} hidden (merged or
            inactive).{" "}
            <button onClick={() => setScope("all")}>Show all branches</button>
          </div>
        )}
      </div>
    </>
  );
}
