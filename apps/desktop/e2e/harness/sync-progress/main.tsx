import { createRoot, type Root } from "react-dom/client";
import "../../../src/renderer/src/styles/app.css";
import { SidebarToolbar } from "../../../src/renderer/src/features/sidebar/SidebarToolbar";
import { countOutcomes } from "../../../src/renderer/src/features/sidebar/bulk-sync-progress";

// All contrived: invented counts and an invented path.
const bridge = {
  profileId: "demo",
  platform: "darwin",
  dispatch: async () => ({ ok: true, value: null }),
  on: () => () => undefined
};
(window as unknown as { pwrgit: typeof bridge }).pwrgit = bridge;
document.documentElement.dataset["platform"] = "darwin";

const progress = {
  counts: { ...countOutcomes([]), success: 10, skipped: 1, failed: 1 },
  inFlight: 2,
  queued: 13,
  startedAt: Date.now() - 42_000,
  path: "~/code/demo-org/atlas-api"
};

/** The real toolbar, a timed Pull recent running. `before` is the run with
 *  no progress reported: what the toolbar drew before it could count. */
function Toolbar({ view, width }: { view: "before" | "after"; width: number }) {
  return (
    <div className="pane pane--sidebar" style={{ width }}>
      <SidebarToolbar
        hasProfile
        rootCount={1}
        repoCount={42}
        recentCount={27}
        syncVerb="pull"
        syncScope="recent"
        fetchInterval={5}
        syncBusy
        syncAuto
        syncProgress={view === "after" ? progress : null}
        tagCheckAfterSync={true}
        onAddFolder={() => undefined}
        onClone={() => undefined}
        onFork={() => undefined}
        onSync={() => undefined}
        onShowRun={() => undefined}
        onMaintenance={() => undefined}
      />
    </div>
  );
}

let root: Root | null = null;
const harness = {
  ready: (async () => {
    await Promise.all(
      ['400 13px "Geist Sans"', '500 12px "Geist Sans"', '600 13px "Geist Sans"', '600 11px "Geist Mono"'].map((font) =>
        document.fonts.load(font)
      )
    );
    await document.fonts.ready;
  })(),
  mount(view: "before" | "after", theme: "light" | "dark", width: number): void {
    root?.unmount();
    if (theme === "light") document.documentElement.dataset["theme"] = "light";
    else delete document.documentElement.dataset["theme"];
    root = createRoot(document.getElementById("root")!);
    root.render(<Toolbar view={view} width={width} />);
  }
};
(window as unknown as { __harness: typeof harness }).__harness = harness;
