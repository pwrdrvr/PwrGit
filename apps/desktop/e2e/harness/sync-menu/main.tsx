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

/** The real toolbar in a sidebar-wide pane. `null` is the menu without the
 *  tag switch: what every build before it drew. */
function Toolbar({ initial }: { initial: boolean | null }) {
  const [on, setOn] = useState(initial);
  return (
    <div className="pane pane--sidebar" style={{ width: 320 }}>
      <SidebarToolbar
        hasProfile
        rootCount={1}
        repoCount={42}
        recentCount={9}
        fetchInterval={15}
        tagCheckAfterSync={on}
        onToggleTagCheck={(next) => {
          calls.push(`tagCheckAfterSync:${next}`);
          setOn(next);
        }}
        onAddFolder={() => undefined}
        onClone={() => undefined}
        onFork={() => undefined}
        onSync={() => undefined}
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
  mount(view: "before" | "on" | "off", theme: "light" | "dark"): void {
    root?.unmount();
    if (theme === "light") document.documentElement.dataset["theme"] = "light";
    else delete document.documentElement.dataset["theme"];
    root = createRoot(document.getElementById("root")!);
    calls.length = 0;
    root.render(<Toolbar initial={view === "before" ? null : view === "on"} />);
  }
};
(window as unknown as { __harness: typeof harness }).__harness = harness;
