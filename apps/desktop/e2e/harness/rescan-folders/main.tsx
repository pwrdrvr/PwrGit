import { createRoot, type Root } from "react-dom/client";
import { ok, type Repo } from "@pwrgit/shared";
import "../../../src/renderer/src/styles/app.css";
import { SidebarToolbar } from "../../../src/renderer/src/features/sidebar/SidebarToolbar";
import { ToastHost } from "../../../src/renderer/src/features/shell/ToastHost";
import { rescanFoldersToast } from "../../../src/renderer/src/features/sidebar/rescan-folders";
import { dismissToast, showInfoToast, subscribeToasts, type Toast } from "../../../src/renderer/src/lib/toast";

// All contrived: invented repositories, paths and counts.
const repo = (name: string): Repo => ({
  id: `id-${name}`,
  name,
  path: `/Users/demo/src/${name}`,
  profileId: "demo",
  pinned: false,
  worktrees: []
});
const repos = ["atlas", "lumen-api", "tidepool", "quartz-cli"].map(repo);

const calls: string[] = [];
const bridge = {
  profileId: "demo",
  platform: "darwin",
  dispatch: async (name: string) => {
    if (name === "remote:activities") return ok([]);
    if (name === "app:readUpdateStatus") return ok({ status: "idle" });
    return ok(null);
  },
  on: () => () => undefined
};
(window as unknown as { pwrgit: typeof bridge }).pwrgit = bridge;
document.documentElement.dataset["platform"] = "darwin";

let live: Toast[] = [];
subscribeToasts((next) => {
  live = next;
});

/** The real toolbar in a sidebar-wide pane, and the real toast stack. */
function View() {
  return (
    <>
      <div className="pane pane--sidebar" style={{ width: 320 }}>
        <SidebarToolbar
          hasProfile
          rootCount={4}
          repoCount={135}
          recentCount={9}
          onAddFolder={() => calls.push("addFolders")}
          onRescanFolders={() => calls.push("rescanFolders")}
          onClone={() => undefined}
          onFork={() => undefined}
          onSync={() => undefined}
          onMaintenance={() => undefined}
        />
      </div>
      <ToastHost repos={repos} onReveal={(repoId) => calls.push(`reveal:${repoId}`)} />
    </>
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
  mount(theme: "light" | "dark"): void {
    root?.unmount();
    for (const toast of live) dismissToast(toast.id);
    if (theme === "light") document.documentElement.dataset["theme"] = "light";
    else delete document.documentElement.dataset["theme"];
    root = createRoot(document.getElementById("root")!);
    calls.length = 0;
    root.render(<View />);
  },
  /** Raise the toast Rescan folders shows for these new repositories. */
  toast(found: "scanning" | "none" | "one" | "several"): void {
    if (found === "scanning") {
      showInfoToast({
        key: "rescan-folders",
        title: "Rescanning folders…",
        message: "Looking through 4 folders for repositories.",
        showCopyAction: false,
        sticky: true
      });
      return;
    }
    const added =
      found === "none" ? [] : found === "one" ? [repos[3]!] : [...repos, repo("nimbus"), repo("orchid")];
    showInfoToast({ ...rescanFoldersToast(added, 4), sticky: true });
  }
};
(window as unknown as { __harness: typeof harness }).__harness = harness;
