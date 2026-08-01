import { useEffect, useMemo, useRef, useState } from "react";
import type { LaneGraph } from "@pwrgit/shared";
import { dispatch, subscribe } from "../../lib/pwrgit";
import {
  GraphRow,
  type GraphRowVM,
  gutterWidth,
  LANE_W,
  laneColor,
  MAX_GUTTER_LANES
} from "./GraphRow";
import { shortWhen } from "./graph-view";
import { layoutLanes } from "./lane-layout";

type Scope = "active" | "all";

// Experimental setting: open new graph views in the "all branches" scope.
// Cached per window but kept fresh via settings:changed, so toggling the
// setting applies to the next opened view without a reload. The in-graph
// toggle still overrides per view.
let defaultScopePromise: Promise<Scope> | null = null;
let defaultScopeSubscribed = false;
function defaultLineageScope(): Promise<Scope> {
  if (!defaultScopeSubscribed) {
    defaultScopeSubscribed = true;
    subscribe("settings:changed", (snapshot) => {
      defaultScopePromise = Promise.resolve(
        snapshot.experimental.lineageAllBranches ? "all" : "active"
      );
    });
  }
  defaultScopePromise ??= dispatch("settings:read", undefined).then((r) =>
    r.ok && r.value.experimental.lineageAllBranches ? "all" : "active"
  );
  return defaultScopePromise;
}

const scrollBehavior = (): ScrollBehavior =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : "smooth";

export function LineageGraph({
  worktreeId,
  activeEmail,
  selectedCommits,
  focusedCommit,
  onToggleCommit,
  onOpenCommit,
  onRevealWorktree
}: {
  worktreeId: string;
  activeEmail: string;
  selectedCommits: Set<string>;
  /** Commit whose files are open in the rail — highlighted even off-branch. */
  focusedCommit: string | null;
  onToggleCommit: (hash: string) => void;
  onOpenCommit: (hash: string, subject: string) => void;
  /** Jump to a worktree from a tip chip's worktree button. */
  onRevealWorktree: (worktreeId: string) => void;
}) {
  const [data, setData] = useState<LaneGraph | null>(null);
  const [scope, setScope] = useState<Scope>("active");
  const [loading, setLoading] = useState(true);
  const [flash, setFlash] = useState<string | null>(null);
  const [branchesOpen, setBranchesOpen] = useState(false);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const laneBarRef = useRef<HTMLDivElement>(null);
  const scopeTouchedRef = useRef(false);

  useEffect(() => {
    let active = true;
    void defaultLineageScope().then((s) => {
      if (active && !scopeTouchedRef.current && s === "all") setScope("all");
    });
    return () => {
      active = false;
    };
  }, []);

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

  useEffect(() => {
    if (flash === null) return;
    const t = setTimeout(() => setFlash(null), 1600);
    return () => clearTimeout(t);
  }, [flash]);

  const email = activeEmail.toLowerCase();
  const layout = useMemo(
    () =>
      layoutLanes(
        (data?.commits ?? []).map((c) => ({ hash: c.hash, parents: c.parents })),
        data === null
          ? undefined
          : {
              tips: data.tips,
              defaultBranch: data.defaultBranch,
              // This worktree's checked-out branch — pinned to lane 1.
              headBranch: Object.entries(data.branches).find(
                ([, info]) => info.worktreeId === worktreeId
              )?.[0],
              shownBranches: data.shownBranches
            }
      ),
    [data, worktreeId]
  );

  const vms: GraphRowVM[] = useMemo(() => {
    const commits = data?.commits ?? [];
    const tips = data?.tips ?? {};
    const defaultBranch = data?.defaultBranch ?? "";
    // Drawn branches (and the default) win the capped chip slots on a commit
    // tipped by many branches; stale hangers-on collapse into the +N pill.
    const drawn = new Set([...(data?.shownBranches ?? []), defaultBranch]);
    return commits.map((commit, i) => {
      const names = tips[commit.hash] ?? [];
      const refs =
        names.length > 1
          ? [...names].sort(
              (a, b) => (drawn.has(b) ? 1 : 0) - (drawn.has(a) ? 1 : 0)
            )
          : names;
      return {
        commit,
        row: layout.rows[i] ?? { lane: 0, top: [], bottom: [] },
        refs,
        isHead: commit.hash === head,
        isMine: commit.authorEmail.toLowerCase() === email,
        defaultBranch
      };
    });
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

  const gutterW = gutterWidth(layout.laneCount);
  const laneOverflow = layout.laneCount > MAX_GUTTER_LANES;

  // Horizontally reveal a lane inside the clipped gutter (no-op when the
  // gutter isn't overflowing). Scrolling the bar drives a CSS var on the card.
  const revealLane = (lane: number): void => {
    const bar = laneBarRef.current;
    if (bar === null) return;
    const x = lane * LANE_W;
    bar.scrollLeft = Math.max(0, Math.min(x - gutterW / 2, bar.scrollWidth));
  };

  const locateHash = (hash: string): void => {
    if (hash === "") return;
    const vm = vmByHash.get(hash);
    if (vm !== undefined) revealLane(vm.row.lane);
    const el = scrollerRef.current?.querySelector(`[data-hash="${hash}"]`);
    el?.scrollIntoView({
      block: "center",
      inline: "nearest",
      behavior: scrollBehavior()
    });
    setFlash(hash);
  };

  // Selecting a worktree takes you to its HEAD: center it and flash it. Also
  // re-centers when HEAD itself moves (commit, pull, switch branch).
  useEffect(() => {
    if (head === "") return;
    const raf = requestAnimationFrame(() => locateHash(head));
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [head, worktreeId]);

  // If the graph shrinks back under the gutter cap, undo any lane scroll.
  useEffect(() => {
    if (!laneOverflow) cardRef.current?.style.setProperty("--lane-scroll", "0px");
  }, [laneOverflow]);

  // Horizontal trackpad/wheel over the LANE GUTTER pans the lanes (via the
  // shared scrollbar) without touching the commit list; vertical deltas pass
  // through to normal list scrolling. Native non-passive listener — React's
  // synthetic wheel can't preventDefault.
  useEffect(() => {
    if (!laneOverflow) return;
    const card = cardRef.current;
    if (card === null) return;
    const onWheel = (e: WheelEvent): void => {
      const target = e.target as HTMLElement | null;
      if (target === null || target.closest(".graph-lanes-clip") === null) return;
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
      const bar = laneBarRef.current;
      if (bar === null) return;
      bar.scrollLeft += e.deltaX;
      e.preventDefault();
    };
    card.addEventListener("wheel", onWheel, { passive: false });
    return () => card.removeEventListener("wheel", onWheel);
  }, [laneOverflow]);

  const shown = data?.shownBranches.length ?? 0;
  const matched = data?.matchedBranches ?? shown;
  const hidden = data?.hiddenBranches ?? 0;
  const countLabel =
    scope === "active"
      ? `${shown}${matched > shown ? ` of ${matched}` : ""} active branch${
          matched === 1 ? "" : "es"
        }`
      : `${shown}${matched > shown ? ` of ${matched}` : ""} branch${
          matched === 1 ? "" : "es"
        } in flight`;

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
            {countLabel}
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
                {matched > shown && (
                  <div className="branch-pop__more">
                    +{matched - shown} more not drawn — showing the {shown} most
                    recent
                  </div>
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
          onClick={() => {
            scopeTouchedRef.current = true;
            setScope((s) => (s === "active" ? "all" : "active"));
          }}
        >
          <span className="only-me__dot" />
          {scope === "active" ? "Active" : "All branches"}
        </button>
      </div>

      <div className="graph-scroll" ref={scrollerRef}>
        {laneOverflow && vms.length > 0 && (
          <div
            className="lane-scrollbar"
            ref={laneBarRef}
            title="Scroll the lane gutter — commits stay put"
            style={{ width: gutterW }}
            onScroll={(e) => {
              cardRef.current?.style.setProperty(
                "--lane-scroll",
                `${-e.currentTarget.scrollLeft}px`
              );
            }}
          >
            <div style={{ width: layout.laneCount * LANE_W, height: 1 }} />
          </div>
        )}
        {vms.length > 0 ? (
          <div
            ref={cardRef}
            className={`graph-card${selectedCommits.size > 0 ? " has-selection" : ""}`}
          >
            {vms.map((vm) => (
              <GraphRow
                key={vm.commit.hash}
                vm={vm}
                laneCount={layout.laneCount}
                selected={selectedCommits.has(vm.commit.hash)}
                focused={focusedCommit === vm.commit.hash}
                flashing={flash === vm.commit.hash}
                branchInfo={data?.branches ?? {}}
                onToggle={() => onToggleCommit(vm.commit.hash)}
                onOpen={() => onOpenCommit(vm.commit.hash, vm.commit.subject)}
                onRevealWorktree={onRevealWorktree}
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
