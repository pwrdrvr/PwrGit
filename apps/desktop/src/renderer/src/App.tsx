import { useState } from "react";
import { useAppearance } from "./lib/useAppearance";

/**
 * Three-pane app shell (titlebar · sidebar · main · collapsible rail) matching
 * design/PwrGit.dc.html. Pane contents are filled by later units: the sidebar
 * in U5-U7, the main graph in U8-U10, the rail in U11+.
 */
export function App() {
  useAppearance();
  const [railCollapsed, setRailCollapsed] = useState(false);

  const gridTemplateColumns = `320px minmax(0, 1fr) ${
    railCollapsed ? "0px" : "344px"
  }`;

  return (
    <div className="app">
      <div className="titlebar">
        <div className="titlebar__gutter" />
        <div className="titlebar__title">PwrGit</div>
        <div className="titlebar__gutter" />
      </div>

      <div className="app-body" style={{ gridTemplateColumns }}>
        <aside className="pane pane--sidebar" data-testid="sidebar">
          <div className="pane__placeholder">Repos</div>
        </aside>

        <main className="pane pane--main" data-testid="main">
          <div className="pane__placeholder">Lineage</div>
        </main>

        {!railCollapsed && (
          <aside className="pane pane--rail" data-testid="rail">
            <div className="rail__bar">
              <span className="pane__placeholder" style={{ padding: 0 }}>
                Changes
              </span>
              <span style={{ flex: 1 }} />
              <button
                className="icon-btn"
                onClick={() => setRailCollapsed(true)}
                title="Collapse panel"
                aria-label="Collapse panel"
              >
                ›
              </button>
            </div>
          </aside>
        )}

        {railCollapsed && (
          <button
            className="rail-reopen"
            onClick={() => setRailCollapsed(false)}
          >
            ‹ Panel
          </button>
        )}
      </div>
    </div>
  );
}
