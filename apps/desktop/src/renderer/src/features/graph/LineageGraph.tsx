import { useEffect, useState } from "react";
import type { GraphLog } from "@pwrgit/shared";
import { dispatch, subscribe } from "../../lib/pwrgit";
import { CommitRow } from "./CommitRow";
import { decorateCommits, filterOnlyMe } from "./graph-view";

export function LineageGraph({
  worktreeId,
  activeEmail,
  selectedCommits,
  onToggleCommit
}: {
  worktreeId: string;
  activeEmail: string;
  selectedCommits: Set<string>;
  onToggleCommit: (hash: string) => void;
}) {
  const [log, setLog] = useState<GraphLog | null>(null);
  const [onlyMe, setOnlyMe] = useState(true);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    const load = (): void => {
      void dispatch("graph:log", { worktreeId }).then((r) => {
        if (!active) return;
        if (r.ok) setLog(r.value);
        setLoading(false);
      });
    };
    setLoading(true);
    load();
    const off = subscribe("worktree:changed", (p) => {
      if (p.worktreeId === worktreeId) load();
    });
    return () => {
      active = false;
      off();
    };
  }, [worktreeId]);

  const rows = decorateCommits(
    log?.commits ?? [],
    activeEmail,
    log?.branchRoot ?? null
  );
  const visible = filterOnlyMe(rows, onlyMe);
  const hidden = rows.length - visible.length;

  return (
    <>
      <div className="graph-toolbar">
        <span className="graph-toolbar__label">Lineage</span>
        <span style={{ flex: 1 }} />
        <span className="graph-toolbar__count">
          {onlyMe ? `${visible.length} by you` : `${visible.length} commits`}
        </span>
        <button
          className={`only-me${onlyMe ? " is-on" : ""}`}
          onClick={() => setOnlyMe((v) => !v)}
        >
          <span className="only-me__dot" />
          Only me
        </button>
      </div>

      <div className="graph-scroll">
        {visible.length > 0 ? (
          <div className="graph-card">
            {visible.map((row, i) => (
              <CommitRow
                key={row.hash}
                row={row}
                index={i}
                total={visible.length}
                selected={selectedCommits.has(row.hash)}
                onToggle={() => onToggleCommit(row.hash)}
              />
            ))}
          </div>
        ) : (
          <div className="graph-empty">
            {loading ? "Loading history…" : "No commits."}
          </div>
        )}

        {onlyMe && hidden > 0 && (
          <div className="graph-hidden-note">
            {hidden} commit{hidden === 1 ? "" : "s"} from others hidden.{" "}
            <button onClick={() => setOnlyMe(false)}>Show all branches</button>
          </div>
        )}
      </div>
    </>
  );
}
