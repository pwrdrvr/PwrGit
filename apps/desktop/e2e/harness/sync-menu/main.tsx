import { useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import "../../../src/renderer/src/styles/app.css";
import { SidebarToolbar } from "../../../src/renderer/src/features/sidebar/SidebarToolbar";

// All contrived: invented counts, no repositories named.
const calls: string[] = [];
const bridge = {
  profileId: "demo",
  platform: "darwin",
  dispatch: async () => ({ ok: true, value: null }),
  on: () => () => undefined
};
(window as unknown as { pwrgit: typeof bridge }).pwrgit = bridge;
document.documentElement.dataset["platform"] = "darwin";

/** The real toolbar in a sidebar-wide pane.
 *  - `before`: only "Check tags after sync" (what builds before fork-sync drew)
 *  - `none`: neither setting read yet (`null`)
 *  - `on` / `off`: both "Sync forks with upstream" and "Check tags after sync"
 */
function Toolbar({
  tagInitial,
  forkInitial
}: {
  tagInitial: boolean | null;
  forkInitial: boolean | null;
}) {
  const [tagOn, setTagOn] = useState(tagInitial);
  const [forkOn, setForkOn] = useState(forkInitial);
  return (
    <div className="pane pane--sidebar" style={{ width: 320 }}>
      <SidebarToolbar
        hasProfile
        rootCount={1}
        repoCount={42}
        recentCount={9}
        syncVerb="pull"
        syncScope="recent"
        fetchInterval={15}
        tagCheckAfterSync={tagOn}
        onToggleTagCheck={(next) => {
          calls.push(`tagCheckAfterSync:${next}`);
          setTagOn(next);
        }}
        syncForksOnBulkPull={forkOn}
        onToggleSyncForks={(next) => {
          calls.push(`syncForksOnBulkPull:${next}`);
          setForkOn(next);
        }}
        onAddFolder={() => undefined}
        onClone={() => undefined}
        onFork={() => undefined}
        onSync={() => {
          calls.push("sync");
        }}
        onMaintenance={() => undefined}
      />
    </div>
  );
}

let root: Root | null = null;
const harness = {
  ready: (async () => {
    await Promise.all(
      ['400 13px "Geist Sans"', '500 12px "Geist Sans"', '600 13px "Geist Sans"', '500 10.5px "Geist Sans"'].map((font) =>
        document.fonts.load(font)
      )
    );
    await document.fonts.ready;
  })(),
  calls,
  mount(view: "none" | "before" | "on" | "off", theme: "light" | "dark"): void {
    root?.unmount();
    if (theme === "light") document.documentElement.dataset["theme"] = "light";
    else delete document.documentElement.dataset["theme"];
    root = createRoot(document.getElementById("root")!);
    calls.length = 0;
    const tagInitial = view === "none" ? null : view !== "off";
    const forkInitial = view === "none" || view === "before" ? null : view === "on";
    root.render(<Toolbar tagInitial={tagInitial} forkInitial={forkInitial} />);
  }
};
(window as unknown as { __harness: typeof harness }).__harness = harness;
