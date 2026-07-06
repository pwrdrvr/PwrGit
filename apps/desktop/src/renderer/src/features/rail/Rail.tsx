import { useState } from "react";
import type { Worktree, WorktreeState } from "@pwrgit/shared";
import { ChangesTab } from "./ChangesTab";

type RailTab = "changes" | "agent";

export function Rail({
  worktree,
  state,
  activeEmail,
  onCollapse
}: {
  worktree: Worktree | null;
  state: WorktreeState | null;
  activeEmail: string;
  onCollapse: () => void;
}) {
  const [tab, setTab] = useState<RailTab>("changes");
  const dirty = state?.dirty ?? worktree?.dirty ?? 0;

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
        <ChangesTab worktree={worktree} activeEmail={activeEmail} />
      ) : (
        <div className="rail-empty">Rebase assistant — U16</div>
      )}
    </aside>
  );
}
