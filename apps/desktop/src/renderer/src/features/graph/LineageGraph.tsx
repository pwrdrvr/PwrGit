import { useEffect, useMemo, useState } from "react";
import type { LaneGraph } from "@pwrgit/shared";
import { dispatch, subscribe } from "../../lib/pwrgit";
import { GraphRow, type GraphRowVM } from "./GraphRow";
import { layoutLanes } from "./lane-layout";

type Scope = "active" | "all";

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
    const head = data?.head ?? "";
    const defaultBranch = data?.defaultBranch ?? "";
    return commits.map((commit, i) => ({
      commit,
      row: layout.rows[i] ?? { lane: 0, top: [], bottom: [] },
      refs: tips[commit.hash] ?? [],
      isHead: commit.hash === head,
      isMine: commit.authorEmail.toLowerCase() === email,
      defaultBranch
    }));
  }, [data, layout, email]);

  const shown = data?.shownBranches.length ?? 0;
  const hidden = data?.hiddenBranches ?? 0;

  return (
    <>
      <div className="graph-toolbar">
        <span className="graph-toolbar__label">Lineage</span>
        <span style={{ flex: 1 }} />
        <span className="graph-toolbar__count">
          {scope === "active"
            ? `${shown} active branch${shown === 1 ? "" : "es"}`
            : `${vms.length} commits`}
        </span>
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

      <div className="graph-scroll">
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
