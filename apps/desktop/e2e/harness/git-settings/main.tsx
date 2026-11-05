import { createRoot, type Root } from "react-dom/client";
import {
  GENERAL_DEFAULTS,
  ok,
  type AppSettingsSnapshot,
  type GitRuntimeCandidate,
  type GitRuntimeStatus,
  type ManagedGitBuild,
  type ManagedGitProgress,
  type ManagedGitStatus
} from "@pwrgit/shared";
import "../../../src/renderer/src/styles/app.css";
import { SettingsWindow } from "../../../src/renderer/src/features/settings/SettingsWindow";

// Settings › Git, mounted whole (nav and pane) against a fake bridge. Every
// path, version and date is contrived. Design: "Git Settings and Managed
// Updates - UX Review".

const APP_GIT = "/Applications/PwrGit.app/Contents/Resources/git/bin/git";
const HOMEBREW = "/opt/homebrew/bin/git";
const XCODE = "/Applications/Xcode.app/Contents/Developer/usr/bin/git";
const BY_HAND = "/Users/demo/.local/share/pwrgit/runtimes/git/2.56.0-dev-pwrgit.3-ada47e4/darwin-arm64/bin/git";
const V4 = "2.56.0-dev-pwrgit.4";
const V5 = "2.56.0-dev-pwrgit.5";
const V6 = "2.56.0-dev-pwrgit.6";
const LFS = "git-lfs/3.7.1 (GitHub; darwin arm64; go 1.25.1; git b84b3384)";
const MINUTE = 60_000;

const build = (version: string): ManagedGitBuild => ({
  id: `${version}-97dd200`,
  version,
  sourceRevision: "97dd200ae74c18d4afe94deb03bc79f29b9d774d",
  path: `/Users/demo/Library/Application Support/PwrGit/git-runtimes/versions/${version}-97dd200/darwin-universal/bin/git`,
  trust: "signed",
  lfsVersion: "3.7.1",
  installedAt: Date.now() - 60 * MINUTE,
  publishedAt: "2026-11-07T12:00:00Z"
});

const bundledRow: GitRuntimeCandidate = {
  path: APP_GIT, source: "bundled", trust: "signed", git: `git version ${V4}`, lfs: LFS, problem: null,
  reflink: { checkout: true, reshare: true }
};
const installed: GitRuntimeCandidate[] = [
  { path: HOMEBREW, source: "homebrew", git: "git version 2.56.0", lfs: "git-lfs/3.8.1", problem: null, reflink: { checkout: false, reshare: false } },
  { path: XCODE, source: "xcode", git: "git version 2.54.0 (Apple Git-160)", lfs: "git-lfs/3.8.1", problem: null, reflink: { checkout: false, reshare: false } }
];
const managedRow = (b: ManagedGitBuild): GitRuntimeCandidate => ({
  path: b.path, source: "managed", managedId: b.id, trust: "signed", git: `git version ${b.version}`, lfs: LFS, problem: null,
  reflink: { checkout: true, reshare: true }
});

function runtimeFor(active: "bundled" | "managed" | "installed", path: string, builds: ManagedGitBuild[], extra: GitRuntimeCandidate[] = []): GitRuntimeStatus {
  return {
    active,
    path,
    keychainHelper: "/opt/homebrew/Cellar/git/2.56.0/libexec/git-core/git-credential-osxkeychain",
    candidates: [bundledRow, ...builds.map(managedRow), ...installed, ...extra]
  };
}

const latest = (version: string) => ({ version, tag: `v${version}`, publishedAt: "2026-11-07T12:00:00Z", size: 38_900_000 });
const base: ManagedGitStatus = {
  supported: true,
  bundledVersion: V4,
  latest: latest(V5),
  needsAppUpdate: null,
  checkedAt: Date.now() - 2 * MINUTE,
  checkError: null,
  builds: [],
  selected: null,
  previous: null,
  inUse: false,
  selectedError: null,
  progress: null
};
const downloading: ManagedGitProgress = {
  phase: "downloading", version: V5, receivedBytes: 16_300_000, totalBytes: 38_900_000, bytesPerSecond: 4_100_000, updatedAt: Date.now()
};

export type View =
  /** General, with the operator's case: a build chosen by path. On `main`
   *  this is where the Git card lives, so it is the "before" shot. */
  | "general"
  | "update"
  | "downloading"
  | "ready"
  | "rollback"
  | "failed"
  | "offline"
  | "chosen-by-path"
  | "needs-app";

const VIEWS: Record<Exclude<View, "general">, () => { runtime: GitRuntimeStatus; managed: ManagedGitStatus }> = {
  update: () => ({ runtime: runtimeFor("bundled", APP_GIT, []), managed: base }),
  downloading: () => ({ runtime: runtimeFor("bundled", APP_GIT, []), managed: { ...base, progress: downloading } }),
  ready: () => ({ runtime: runtimeFor("bundled", APP_GIT, [build(V5)]), managed: { ...base, checkedAt: Date.now() - 4 * MINUTE, builds: [build(V5)] } }),
  rollback: () => ({
    runtime: runtimeFor("managed", build(V6).path, [build(V6), build(V5)]),
    managed: {
      ...base, latest: latest(V6), checkedAt: Date.now() - 60 * MINUTE, builds: [build(V6), build(V5)],
      selected: build(V6).id, previous: build(V5).id, inUse: true
    }
  }),
  failed: () => ({
    runtime: runtimeFor("bundled", APP_GIT, []),
    managed: {
      ...base, checkedAt: Date.now(),
      progress: {
        phase: "failed", version: V5, failedPhase: "verifying", updatedAt: Date.now(),
        error: "libexec/git-core/git-remote-https isn’t signed by PwrDrvr (team T44CNHC4UH). PwrGit deleted the download."
      }
    }
  }),
  offline: () => ({
    runtime: runtimeFor("managed", build(V5).path, [build(V5)]),
    managed: {
      ...base, checkedAt: Date.now() - 26 * 60 * MINUTE, builds: [build(V5)], selected: build(V5).id, inUse: true,
      checkError: "getaddrinfo ENOTFOUND api.github.com"
    }
  }),
  "chosen-by-path": () => ({
    runtime: runtimeFor("installed", BY_HAND, [build(V5)], [
      { path: BY_HAND, source: "custom", git: "git version 2.56.0-dev-pwrgit.3", lfs: LFS, problem: null, reflink: { checkout: true, reshare: true } }
    ]),
    managed: { ...base, builds: [build(V5)] }
  }),
  "needs-app": () => ({
    runtime: runtimeFor("managed", build(V5).path, [build(V5)]),
    managed: { ...base, checkedAt: Date.now(), builds: [build(V5)], selected: build(V5).id, inUse: true, needsAppUpdate: "2.57.0-dev-pwrgit.1" }
  })
};

const byHand: GitRuntimeCandidate = {
  path: BY_HAND, source: "custom", git: "git version 2.56.0-dev-pwrgit.3", lfs: LFS, problem: null, reflink: { checkout: true, reshare: true }
};
const BEFORE = () => ({ runtime: runtimeFor("installed", BY_HAND, [], [byHand]), managed: base });
let state = VIEWS.update();
const snapshot = { general: GENERAL_DEFAULTS } as AppSettingsSnapshot;
const bridge = {
  profileId: null,
  platform: "darwin",
  appearance: { theme: "light", resolvedTheme: "light" },
  getAppMenuModel: async () => [],
  popupAppMenu: () => undefined,
  runWindowControl: async () => undefined,
  readWindowFrameState: async () => null,
  onWindowFrameState: () => () => undefined,
  dispatch: async (name: string) => {
    if (name === "settings:read") return ok(snapshot);
    if (name === "appearance:read") return ok({ theme: "light", resolvedTheme: "light" });
    if (name === "profile:list") {
      return ok({
        activeProfileId: "demo",
        profiles: [{ id: "demo", name: "Demo", email: "demo@example.com", mono: "D", roots: [], onboardingCompleted: true, showInMenu: true }]
      });
    }
    if (name === "forge:status") return ok({ forges: [] });
    if (name === "forge:hosts") return ok({ hosts: [], overrides: {} });
    if (name === "identity:machine") {
      return ok({
        outside: { kind: "configured", author: { name: "Demo", email: "demo@example.com" }, committer: { name: "Demo", email: "demo@example.com" } },
        config: [], globalFile: "/Users/demo/.gitconfig", notice: false
      });
    }
    if (name === "identity:folders") return ok({ enabled: false, globalFile: "/Users/demo/.gitconfig", machine: null, profiles: [] });
    if (name === "repo:hiddenList") return ok([]);
    if (name === "git:runtimeStatus" || name === "git:selectRuntime") return ok(state.runtime);
    if (name.startsWith("gitManaged:")) return ok(state.managed);
    return ok(null);
  },
  on: () => () => undefined
};
(window as unknown as { pwrgit: typeof bridge }).pwrgit = bridge;
document.documentElement.dataset["theme"] = "light";
document.documentElement.dataset["platform"] = "darwin";

let root: Root | null = null;
const harness = {
  ready: (async () => {
    await Promise.all([
      '400 13px "Geist Sans"', '500 11px "Geist Sans"', '600 13px "Geist Sans"', '700 12px "Geist Sans"',
      '400 11px "Geist Mono"', '500 10px "Geist Mono"', '600 11px "Geist Mono"'
    ].map((font) => document.fonts.load(font)));
    await document.fonts.ready;
  })(),
  mount(view: View): void {
    root?.unmount();
    state = view === "general" ? BEFORE() : VIEWS[view]();
    window.location.hash = view === "general" ? "#settings?page=general" : "#settings?page=git";
    root = createRoot(document.getElementById("root")!);
    root.render(<SettingsWindow />);
  }
};
(window as unknown as { __harness: typeof harness }).__harness = harness;
