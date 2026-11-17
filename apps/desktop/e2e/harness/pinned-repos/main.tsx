import { useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Profile, Repo, Worktree } from "@pwrgit/shared";
import "../../../src/renderer/src/styles/app.css";
import { Sidebar } from "../../../src/renderer/src/features/sidebar/Sidebar";

// All contrived: invented repositories, paths and counts.
const worktree = (repoId: string, i: number, root: string): Worktree =>
  ({
    id: `${repoId}:wt${i}`,
    repoId,
    branch: i === 0 ? "main" : `feat/${i}`,
    path: `${root}/${repoId}${i === 0 ? "" : `-wt${i}`}`,
    dirty: 0,
    ahead: 0,
    behind: 0,
    behindDefault: 0,
    defaultBranch: "main",
    mergedIntoDefault: false,
    divergedFromDefault: false,
    isDefaultBranch: i === 0,
    pinned: false,
    isPrimary: i === 0
  }) as Worktree;

/** Pinned, in the reader's order: quartz-cli, atlas, tidepool. */
const PIN_ORDER = ["quartz-cli", "atlas", "tidepool"];
const NAMES = [
  "atlas",
  "beacon-web",
  "cinder",
  "delta-svc",
  "ember",
  "lumen-api",
  "nimbus",
  "orchid",
  "quartz-cli",
  "tidepool",
  "zephyr"
];
const OSS = new Set(["cinder", "orchid", "tidepool", "zephyr"]);

function makeRepos(): Repo[] {
  return NAMES.map((name) => {
    const root = OSS.has(name) ? "/Users/demo/oss" : "/Users/demo/code";
    const order = PIN_ORDER.indexOf(name);
    return {
      id: name,
      name,
      path: `${root}/${name}`,
      profileId: "demo",
      pinned: order !== -1,
      ...(order === -1 ? {} : { order }),
      worktrees: [worktree(name, 0, root), worktree(name, 1, root)]
    } as Repo;
  });
}

const bridge = {
  profileId: "demo",
  platform: "darwin",
  appearance: { theme: "dark", resolvedTheme: "dark" },
  // Nothing answers: the list needs no reply to draw.
  dispatch: () => new Promise(() => undefined),
  on: () => () => undefined
};
(window as unknown as { pwrgit: typeof bridge }).pwrgit = bridge;
document.documentElement.dataset["platform"] = "darwin";

const calls: string[] = [];
const noop = (): void => undefined;

function View({ grouped }: { grouped: boolean }) {
  const [repos, setRepos] = useState(makeRepos);
  const profile = {
    id: "demo",
    name: "Demo",
    roots: grouped ? ["/Users/demo/code", "/Users/demo/oss"] : ["/Users/demo"]
  } as Profile;
  return (
    <div className="app" style={{ display: "flex", width: 430, height: 520 }}>
      <Sidebar
        profiles={[profile]}
        activeProfile={profile}
        profileLoadState={{ status: "ready" }}
        onRetryProfiles={noop}
        onSwitchProfile={noop}
        repos={repos}
        repoLoadState={{ status: "ready" }}
        onRetryRepos={noop}
        selectedWorktreeId="lumen-api:wt0"
        onSelectWorktree={noop}
        onSetRepoPin={(repoId, pinned) => {
          calls.push(`pin:${repoId}:${pinned}`);
          setRepos((rs) =>
            rs.map((r) => {
              if (r.id !== repoId) return r;
              const { order: _dropped, ...rest } = r;
              return pinned ? { ...r, pinned } : ({ ...rest, pinned } as Repo);
            })
          );
        }}
        onSetWorktreePin={noop}
        onSetBranchPin={noop}
        onRemoveWorktree={noop}
        onRemoveWorktrees={() => Promise.resolve({ removed: [], failed: [] } as never)}
        onCreateWorktree={() => Promise.resolve(null)}
        onPersistOrder={noop}
        onPersistRepoOrder={(ids) => {
          calls.push(`order:${ids.join(",")}`);
          setRepos((rs) =>
            rs.map((r) => (ids.includes(r.id) ? { ...r, order: ids.indexOf(r.id) } : r))
          );
        }}
        refreshingRepoIds={new Set()}
        onRefreshRepo={noop}
        onRefreshPullRequest={noop}
        onCloneRepo={noop}
        onForkRepo={noop}
        onForkCheckout={noop}
        onAddFolder={noop}
        onExpandRepo={noop}
        onNewProfile={noop}
        onManageProfile={noop}
        platform="darwin"
      />
    </div>
  );
}

let root: Root | null = null;
const harness = {
  ready: (async () => {
    await Promise.all(
      ['400 13px "Geist Sans"', '500 12px "Geist Sans"', '600 13px "Geist Sans"', '700 10px "Geist Sans"'].map(
        (font) => document.fonts.load(font)
      )
    );
    await document.fonts.ready;
  })(),
  calls,
  mount(lens: string, grouped: boolean, theme: "light" | "dark"): void {
    root?.unmount();
    window.localStorage.clear();
    window.localStorage.setItem("pwrgit.lens", lens);
    if (theme === "light") document.documentElement.dataset["theme"] = "light";
    else delete document.documentElement.dataset["theme"];
    root = createRoot(document.getElementById("root")!);
    calls.length = 0;
    root.render(<View grouped={grouped} />);
  }
};
(window as unknown as { __harness: typeof harness }).__harness = harness;
