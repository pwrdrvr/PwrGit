import { useEffect, useState } from "react";
import type { Worktree, WorktreeState } from "@pwrgit/shared";
import { AgentTab } from "./AgentTab";
import { ChangesTab } from "./ChangesTab";

type RailTab = "changes" | "agent";

export function Rail({
  worktree,
  state,
  activeEmail,
  selectedHashes,
  agentAction,
  onClearSelection,
  onCollapse,
  onOpenDiff
}: {
  worktree: Worktree | null;
  state: WorktreeState | null;
  activeEmail: string;
  selectedHashes: string[];
  agentAction: "squash" | "reorder" | null;
  onClearSelection: () => void;
  onCollapse: () => void;
  onOpenDiff: (path: string, staged: boolean) => void;
}) {
  const [tab, setTab] = useState<RailTab>("changes");
  const dirty = state?.dirty ?? worktree?.dirty ?? 0;

  useEffect(() => {
    if (agentAction !== null) setTab("agent");
  }, [agentAction]);

  return (
    <aside className="pane pane--rail" data-testid="rail">
      <div className="rail__bar">
        <button
          className={`rail-tab${tab === "changes" ? " is-active" : ""}`}
          onClick={() => setTab("changes")}
        >
          Changes
          {dirty > 0 && <span className="rail-tab__badge">{dirty}</span>}
        </button>
        <button
          className={`rail-tab${tab === "agent" ? " is-active" : ""}`}
          onClick={() => setTab("agent")}
        >
          Agent
          {selectedHashes.length > 0 && (
            <span className="rail-tab__badge">{selectedHashes.length}</span>
          )}
        </button>
        <span style={{ flex: 1 }} />
        <button
          className="icon-btn"
          onClick={onCollapse}
          title="Collapse panel"
          aria-label="Collapse panel"
        >
          ›
        </button>
      </div>

      {tab === "changes" ? (
        <ChangesTab
          worktree={worktree}
          activeEmail={activeEmail}
          onOpenDiff={onOpenDiff}
        />
      ) : (
        <AgentTab
          worktreeId={worktree?.id ?? null}
          selectedHashes={selectedHashes}
          op={agentAction}
          onClear={onClearSelection}
        />
      )}
    </aside>
  );
}
