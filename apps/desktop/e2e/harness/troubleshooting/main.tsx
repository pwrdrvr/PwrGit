import { createRoot, type Root } from "react-dom/client";
import {
  DIAGNOSTICS_DEFAULTS,
  EXPERIMENTAL_DEFAULTS,
  GENERAL_DEFAULTS,
  ok,
  resolveUpdateSelection,
  type AppSettingsPatch,
  type AppSettingsSnapshot,
  type StartupCpuProfileCapturedEvent
} from "@pwrgit/shared";
import "../../../src/renderer/src/styles/app.css";
import { SettingsWindow } from "../../../src/renderer/src/features/settings/SettingsWindow";
import { ToastHost } from "../../../src/renderer/src/features/shell/ToastHost";

// Settings › Troubleshooting and the startup-capture notice against a fake
// bridge. Every path, host and session id is contrived.

const ROOT = "/Users/demo/Library/Application Support/PwrGit/diagnostics";
const SESSION = "startup-cpu-2026-11-20-1043-a1b2c3";
const DIR = `${ROOT}/${SESSION}`;

export type View = "armed" | "idle" | "cpu-rules" | "notice-completed" | "notice-partial";

function snapshot(view: View): AppSettingsSnapshot {
  const armed = view === "armed";
  return {
    general: GENERAL_DEFAULTS,
    experimental: EXPERIMENTAL_DEFAULTS,
    diagnostics: {
      ...DIAGNOSTICS_DEFAULTS,
      ...(view === "cpu-rules" ? {
        hotCpuProfilingEnabled: true,
        hotCpuProfilingCaptureChromiumTrace: true,
        hotCpuProfilingRules: {
          ...DIAGNOSTICS_DEFAULTS.hotCpuProfilingRules,
          slowburn: { enabled: true, thresholdPercent: 15, durationMs: 30_000 }
        }
      } : {}),
      startupCpuProfilingEnabled: armed,
      resourceUsageEnabled: armed,
      resourceUsageExpiresAt: armed ? "2026-11-21T18:43:00.000Z" : null
    },
    updates: resolveUpdateSelection(undefined, "0.61.0"),
    forges: { hosts: {} },
    diagnosticsEnv: { heapMonitorForcedOn: false, hotCpuProfilingForcedOn: false, startupCpuProfilingForcedOn: false },
    diagnosticsOutputRoot: ROOT
  };
}

function startup(status: "completed" | "partial"): StartupCpuProfileCapturedEvent {
  const rendererSaved = status === "completed";
  return {
    sessionId: "a1b2c3",
    sessionDirectory: DIR,
    sessionDirectoryName: SESSION,
    status,
    reason: rendererSaved ? "post-load-elapsed" : "hard-timeout",
    armedBy: "settings",
    startedAt: "2026-11-20T18:43:08.000Z",
    completedAt: "2026-11-20T18:43:14.000Z",
    sourceHostname: "demo-mac.example",
    artifacts: [
      { kind: "main-profile", filename: "main.cpuprofile", path: `${DIR}/main.cpuprofile` },
      ...(rendererSaved ? [{ kind: "renderer-profile" as const, filename: "renderer.cpuprofile", path: `${DIR}/renderer.cpuprofile` }] : []),
      { kind: "manifest", filename: "session.json", path: `${DIR}/session.json` },
      { kind: "events", filename: "events.ndjson", path: `${DIR}/events.ndjson` }
    ],
    missing: rendererSaved ? [] : ["renderer-profile"]
  };
}

let view: View = "armed";
let settings = snapshot(view);
const bridge = {
  profileId: null,
  platform: "darwin",
  appearance: { theme: "light", resolvedTheme: "light" },
  getAppMenuModel: async () => [],
  popupAppMenu: () => undefined,
  runWindowControl: async () => undefined,
  readWindowFrameState: async () => null,
  onWindowFrameState: () => () => undefined,
  dispatch: async (name: string, args?: { patch: AppSettingsPatch }) => {
    if (name === "settings:read") return ok(settings);
    if (name === "settings:update") {
      settings = { ...settings, diagnostics: { ...settings.diagnostics, ...args?.patch.diagnostics } };
      return ok(settings);
    }
    if (name === "appearance:read") return ok({ theme: "light", resolvedTheme: "light" });
    if (name === "app:readProcessIds") {
      return ok({ line: "main=4101 gpu=4107 renderer=4120", diagnosticsText: "PwrGit 0.61.0 (demo)\nmain=4101 gpu=4107 renderer=4120" });
    }
    if (name === "profile:list") {
      return ok({
        activeProfileId: "demo",
        profiles: [{ id: "demo", name: "Demo", email: "demo@example.com", mono: "D", roots: [], onboardingCompleted: true, showInMenu: true }]
      });
    }
    if (name === "diagnostics:readStartupCpuProfile") {
      return ok(view === "notice-completed" ? startup("completed") : view === "notice-partial" ? startup("partial") : null);
    }
    if (name === "remote:activities" || name === "repo:hiddenList") return ok([]);
    if (name === "app:readUpdateStatus") return ok({ status: "idle" });
    return ok(null);
  },
  on: () => () => undefined
};
(window as unknown as { pwrgit: typeof bridge }).pwrgit = bridge;
document.documentElement.dataset["theme"] = "light";
document.documentElement.dataset["platform"] = "darwin";

let root: Root | null = null;
let toasts: Root | null = null;
const harness = {
  ready: (async () => {
    await Promise.all([
      '400 13px "Geist Sans"', '500 11px "Geist Sans"', '600 13px "Geist Sans"', '700 12px "Geist Sans"',
      '400 11px "Geist Mono"', '500 10px "Geist Mono"', '600 11px "Geist Mono"'
    ].map((font) => document.fonts.load(font)));
    await document.fonts.ready;
  })(),
  mount(next: View): void {
    root?.unmount();
    toasts?.unmount();
    root = toasts = null;
    view = next;
    settings = snapshot(view);
    if (next === "armed" || next === "idle" || next === "cpu-rules") {
      window.location.hash = "#settings?page=diagnostics";
      root = createRoot(document.getElementById("root")!);
      root.render(<SettingsWindow />);
    } else {
      toasts = createRoot(document.getElementById("toasts")!);
      toasts.render(<ToastHost profileId="demo" repos={[]} onReveal={() => undefined} />);
    }
  }
};
(window as unknown as { __harness: typeof harness }).__harness = harness;
